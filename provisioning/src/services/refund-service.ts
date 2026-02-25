import Stripe from 'stripe';
import pool from '../db/connection';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16',
});

export interface RefundOptions {
  customerId: string;
  reason: 'requested_by_customer' | 'duplicate' | 'fraudulent';
  amount?: number; // Optional: partial refund in cents
  description?: string;
}

export interface RefundResult {
  refundId: string;
  amount: number;
  status: string;
  created: Date;
}

export class RefundService {
  /**
   * Issue refund for customer's most recent payment
   */
  static async issueRefund(options: RefundOptions): Promise<RefundResult> {
    const { customerId, reason, amount, description } = options;

    // Get customer's Stripe customer ID
    const customerResult = await pool.query(
      'SELECT stripe_customer_id FROM customers WHERE customer_id = $1',
      [customerId]
    );

    if (customerResult.rows.length === 0) {
      throw new Error('Customer not found');
    }

    const stripeCustomerId = customerResult.rows[0].stripe_customer_id;

    // Get most recent paid invoice
    const invoices = await stripe.invoices.list({
      customer: stripeCustomerId,
      status: 'paid',
      limit: 1,
    });

    if (invoices.data.length === 0) {
      throw new Error('No paid invoice found for refund');
    }

    const invoice = invoices.data[0];

    if (!invoice.payment_intent) {
      throw new Error('No payment intent found for invoice');
    }

    // Calculate refund amount
    const refundAmount = amount || invoice.amount_paid;

    // Issue refund
    const refund = await stripe.refunds.create({
      payment_intent: invoice.payment_intent as string,
      amount: refundAmount,
      reason: reason,
      metadata: {
        customer_id: customerId,
        description: description || 'Customer requested refund',
      },
    });

    // Log refund in database
    await this.logRefund(customerId, refund.id, refundAmount, reason);

    console.log(`✅ Refund issued: ${refund.id} for customer ${customerId}`);

    return {
      refundId: refund.id,
      amount: refundAmount,
      status: refund.status || 'succeeded',
      created: new Date(refund.created * 1000),
    };
  }

  /**
   * Calculate pro-rated refund amount
   */
  static async calculateProRatedRefund(customerId: string): Promise<number> {
    const subscriptionResult = await pool.query(
      `SELECT 
        s.current_period_start, 
        s.current_period_ends_at as current_period_end,
        s.stripe_subscription_id,
        c.stripe_customer_id
      FROM subscriptions s
      JOIN customers c ON s.customer_id = c.customer_id
      WHERE s.customer_id = $1`,
      [customerId]
    );

    if (subscriptionResult.rows.length === 0) {
      throw new Error('Subscription not found');
    }

    const subscription = subscriptionResult.rows[0];

    // If no period dates, can't calculate pro-rated refund
    if (!subscription.current_period_start || !subscription.current_period_end) {
      console.log('No subscription period dates available (trial customer)');
      return 0;
    }

    // Get invoice amount
    const invoices = await stripe.invoices.list({
      customer: subscription.stripe_customer_id,
      subscription: subscription.stripe_subscription_id,
      status: 'paid',
      limit: 1,
    });

    console.log(`📋 Refund calculation for customer ${customerId}:`);
    console.log(`   Stripe Customer: ${subscription.stripe_customer_id}`);
    console.log(`   Stripe Subscription: ${subscription.stripe_subscription_id}`);
    console.log(`   Period Start: ${subscription.current_period_start}`);
    console.log(`   Period End: ${subscription.current_period_end}`);
    console.log(`   Invoices found: ${invoices.data.length}`);

    if (invoices.data.length === 0) {
      console.log('⚠️  No paid invoices found');
      return 0;
    }

    const invoice = invoices.data[0];
    const totalAmount = invoice.amount_paid;
    console.log(`   Invoice amount: $${totalAmount / 100} (${totalAmount} cents)`);

    // Calculate time remaining
    const now = new Date();
    const periodStart = new Date(subscription.current_period_start);
    const periodEnd = new Date(subscription.current_period_end);

    let totalDays = Math.ceil(
      (periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24)
    );
    
    // Stripe test mode sometimes returns same start/end dates
    // In production, subscriptions have proper billing cycles (30 days typically)
    // Fallback: assume 30-day monthly billing cycle if period is 0
    if (totalDays === 0) {
      console.log('   ⚠️  Period start and end are the same (Stripe test mode)');
      console.log('   📅 Assuming 30-day billing cycle for refund calculation');
      totalDays = 30;
      // Adjust periodEnd to be 30 days from start
      periodEnd.setDate(periodStart.getDate() + 30);
    }
    
    const daysUsed = Math.ceil(
      (now.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24)
    );
    const daysRemaining = totalDays - daysUsed;

    console.log(`   Total days in period: ${totalDays}`);
    console.log(`   Days used: ${daysUsed}`);
    console.log(`   Days remaining: ${daysRemaining}`);

    // Pro-rated refund
    const proRatedAmount = Math.floor((totalAmount * daysRemaining) / totalDays);
    console.log(`   Pro-rated refund amount: $${proRatedAmount / 100} (${proRatedAmount} cents)`);

    return proRatedAmount;
  }

  /**
   * Log refund in database
   */
  private static async logRefund(
    customerId: string,
    refundId: string,
    amount: number,
    reason: string
  ): Promise<void> {
    await pool.query(
      `INSERT INTO refunds (customer_id, stripe_refund_id, amount, reason, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [customerId, refundId, amount, reason]
    );
  }

  /**
   * Get refund history for customer
   */
  static async getRefundHistory(customerId: string): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM refunds 
       WHERE customer_id = $1 
       ORDER BY created_at DESC`,
      [customerId]
    );

    return result.rows;
  }
}
