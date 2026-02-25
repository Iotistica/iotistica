import { CustomerModel } from '../db/customer-model';
import { SubscriptionModel } from '../db/subscription-model';
import { StripeService } from './stripe-service';
import { RefundService } from './refund-service';
import pool from '../db/connection';

export interface DeactivationOptions {
  cancelSubscription: boolean;
  issueRefund: boolean;
  refundReason?: 'requested_by_customer' | 'duplicate' | 'fraudulent';
  refundAmount?: number; // Optional partial refund
  deleteData: boolean;
  retentionDays?: number; // Default: 30 days
  cancelAtPeriodEnd?: boolean; // Graceful cancellation
}

export interface DeactivationResult {
  customerId: string;
  subscriptionCanceled: boolean;
  refundIssued: boolean;
  refundAmount?: number;
  dataScheduledForDeletion: boolean;
  scheduledDeletionDate?: Date;
  licenseRevoked: boolean;
}

export class CustomerDeactivationService {
  /**
   * Complete customer deactivation workflow
   */
  static async deactivateCustomer(
    customerId: string,
    options: DeactivationOptions
  ): Promise<DeactivationResult> {
    const result: DeactivationResult = {
      customerId,
      subscriptionCanceled: false,
      refundIssued: false,
      dataScheduledForDeletion: false,
      licenseRevoked: false,
    };

    console.log(`🔄 Starting deactivation for customer ${customerId}`);

    // Get customer info
    const customer = await CustomerModel.getById(customerId);
    if (!customer) {
      throw new Error('Customer not found');
    }

    // 1. Handle subscription cancellation
    if (options.cancelSubscription) {
      const subscription = await SubscriptionModel.getByCustomerId(customerId);

      if (subscription && subscription.stripe_subscription_id) {
        try {
          if (options.cancelAtPeriodEnd) {
            // Graceful cancellation - cancel at period end
            await StripeService.cancelAtPeriodEnd(customerId);
            console.log(`✅ Subscription set to cancel at period end`);
          } else {
            // Immediate cancellation
            await StripeService.cancelSubscription(customerId);
            console.log(`✅ Subscription canceled immediately`);
          }
          result.subscriptionCanceled = true;
        } catch (error: any) {
          console.error(`⚠️  Subscription cancellation failed: ${error.message}`);
          // Continue with deactivation even if cancellation fails (e.g., already canceled, trial)
          if (error.message.includes('No such subscription')) {
            console.log(`ℹ️  Subscription already canceled or doesn't exist in Stripe`);
          }
        }
      } else {
        console.log(`ℹ️  No active Stripe subscription (trial customer)`);
      }
    }

    // 2. Issue refund if requested
    if (options.issueRefund && options.refundReason) {
      try {
        const refundAmount =
          options.refundAmount ||
          (await RefundService.calculateProRatedRefund(customerId));

        if (refundAmount > 0) {
          const refundResult = await RefundService.issueRefund({
            customerId,
            reason: options.refundReason,
            amount: refundAmount,
            description: 'Customer deactivation refund',
          });

          result.refundIssued = true;
          result.refundAmount = refundAmount;
          console.log(`✅ Refund issued: $${(refundAmount / 100).toFixed(2)}`);
        } else {
          console.log(`ℹ️  No refund needed (amount: $0)`);
        }
      } catch (error: any) {
        console.error(`⚠️  Refund failed: ${error.message}`);
        // Continue with deactivation even if refund fails
      }
    }

    // 3. Handle data retention/deletion
    const retentionDays = options.retentionDays || 30;
    const scheduledDeletion = new Date(
      Date.now() + retentionDays * 24 * 60 * 60 * 1000
    );

    if (options.deleteData) {
      // Schedule Kubernetes cleanup
      await this.scheduleKubernetesCleanup(
        customer.customer_id,
        retentionDays
      );

      // Update customer record
      await pool.query(
        `UPDATE customers 
         SET is_active = false, 
             deleted_at = NOW(),
             scheduled_deletion = $1
         WHERE customer_id = $2`,
        [scheduledDeletion, customerId]
      );

      result.dataScheduledForDeletion = true;
      result.scheduledDeletionDate = scheduledDeletion;
      console.log(
        `✅ Data scheduled for deletion on ${scheduledDeletion.toISOString()}`
      );
    } else {
      // Just deactivate, keep data
      await pool.query(
        `UPDATE customers 
         SET is_active = false 
         WHERE customer_id = $1`,
        [customerId]
      );
      console.log(`✅ Customer deactivated (data retained)`);
    }

    // 4. Revoke license
    await pool.query(
      `INSERT INTO license_history (customer_id, action, plan, max_devices, license_hash, metadata, generated_at, generated_by)
       VALUES ($1, 'revoked', 'none', 0, 'revoked', $2, NOW(), 'system')`,
      [
        customerId,
        JSON.stringify({
          reason: 'customer_deactivation',
          options: options,
        }),
      ]
    );

    result.licenseRevoked = true;
    console.log(`✅ License revoked`);

    // 5. Audit log
    await this.auditLog('customer.deactivated', customerId, options);

    console.log(`🎉 Deactivation complete for customer ${customerId}`);

    return result;
  }

  /**
   * Reactivate customer (within retention period)
   */
  static async reactivateCustomer(customerId: string): Promise<void> {
    // Check if customer is within retention period
    const customerResult = await pool.query(
      `SELECT scheduled_deletion, deleted_at 
       FROM customers 
       WHERE customer_id = $1`,
      [customerId]
    );

    if (customerResult.rows.length === 0) {
      throw new Error('Customer not found');
    }

    const customer = customerResult.rows[0];

    if (customer.scheduled_deletion && new Date() > customer.scheduled_deletion) {
      throw new Error('Customer data has been deleted and cannot be reactivated');
    }

    // Reactivate customer
    await pool.query(
      `UPDATE customers 
       SET is_active = true,
           deleted_at = NULL,
           scheduled_deletion = NULL
       WHERE customer_id = $1`,
      [customerId]
    );

    // Cancel scheduled cleanup job
    await this.cancelScheduledCleanup(customerId);

    // Audit log
    await this.auditLog('customer.reactivated', customerId, {});

    console.log(`✅ Customer ${customerId} reactivated`);
  }

  /**
   * Schedule Kubernetes namespace cleanup
   */
  private static async scheduleKubernetesCleanup(
    customerId: string,
    delayDays: number
  ): Promise<void> {
    // This would integrate with your deployment queue
    // For now, we'll just log it to a cleanup queue table

    // Sanitize namespace: replace underscores with hyphens
    const namespace = `customer-${customerId.replace(/_/g, '-').toLowerCase()}`;

    await pool.query(
      `INSERT INTO cleanup_queue (customer_id, namespace, scheduled_for, status)
       VALUES ($1, $2, NOW() + INTERVAL '${delayDays} days', 'scheduled')`,
      [customerId, namespace]
    );

    console.log(
      `📅 Kubernetes cleanup scheduled for namespace: ${namespace} in ${delayDays} days`
    );
  }

  /**
   * Cancel scheduled cleanup
   */
  private static async cancelScheduledCleanup(customerId: string): Promise<void> {
    await pool.query(
      `UPDATE cleanup_queue 
       SET status = 'canceled', canceled_at = NOW()
       WHERE customer_id = $1 AND status = 'scheduled'`,
      [customerId]
    );

    console.log(`✅ Scheduled cleanup canceled for customer ${customerId}`);
  }

  /**
   * Audit log entry
   */
  private static async auditLog(
    action: string,
    customerId: string,
    metadata: any
  ): Promise<void> {
    await pool.query(
      `INSERT INTO audit_log (action, customer_id, metadata, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [action, customerId, JSON.stringify(metadata)]
    );
  }

  /**
   * Get customers scheduled for deletion
   */
  static async getScheduledDeletions(): Promise<any[]> {
    const result = await pool.query(
      `SELECT customer_id, email, company_name, scheduled_deletion, deleted_at
       FROM customers
       WHERE scheduled_deletion IS NOT NULL 
         AND scheduled_deletion > NOW()
       ORDER BY scheduled_deletion ASC`
    );

    return result.rows;
  }

  /**
   * Execute scheduled deletions (run daily via cron)
   */
  static async executeScheduledDeletions(): Promise<number> {
    // Get customers due for deletion
    const result = await pool.query(
      `SELECT customer_id FROM customers
       WHERE scheduled_deletion IS NOT NULL 
         AND scheduled_deletion <= NOW()
         AND is_active = false`
    );

    let deleted = 0;

    for (const row of result.rows) {
      try {
        await this.permanentlyDeleteCustomer(row.customer_id);
        deleted++;
      } catch (error: any) {
        console.error(
          `Failed to delete customer ${row.customer_id}: ${error.message}`
        );
      }
    }

    console.log(`🗑️  Permanently deleted ${deleted} customer(s)`);
    return deleted;
  }

  /**
   * Permanently delete customer data
   */
  private static async permanentlyDeleteCustomer(customerId: string): Promise<void> {
    // Delete from all tables (respect foreign keys)
    await pool.query('DELETE FROM license_history WHERE customer_id = $1', [
      customerId,
    ]);
    await pool.query('DELETE FROM usage_reports WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM refunds WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM subscriptions WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM customers WHERE customer_id = $1', [customerId]);

    console.log(`🗑️  Permanently deleted customer ${customerId}`);
  }
}
