/**
 * Subscription Model
 */

import { query } from './connection';

export interface Subscription {
  id: number;
  customer_id: string;
  stripe_subscription_id?: string;
  plan: 'starter' | 'professional' | 'enterprise';
  status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid';
  trial_ends_at?: Date | null;
  current_period_start?: Date | null;
  current_period_ends_at?: Date | null;
  created_at: Date;
  updated_at: Date;
}

export class SubscriptionModel {
  /**
   * Create trial subscription
   */
  static async createTrial(
    customerId: string,
    plan: Subscription['plan'],
    trialDays: number = 14
  ): Promise<Subscription> {
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + trialDays);

    const result = await query<Subscription>(
      `INSERT INTO subscriptions (
        customer_id, plan, status, trial_ends_at, current_period_ends_at,
        created_at, updated_at
      ) VALUES ($1, $2, 'trialing', $3, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *`,
      [customerId, plan, trialEndsAt]
    );

    return result.rows[0];
  }

  /**
   * Create paid subscription
   */
  static async createPaid(
    customerId: string,
    plan: Subscription['plan'],
    stripeSubscriptionId: string,
    currentPeriodEndsAt: Date,
    currentPeriodStart?: Date
  ): Promise<Subscription> {
    const result = await query<Subscription>(
      `INSERT INTO subscriptions (
        customer_id, stripe_subscription_id, plan, status, current_period_start, current_period_ends_at,
        created_at, updated_at
      ) VALUES ($1, $2, $3, 'active', $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *`,
      [customerId, stripeSubscriptionId, plan, currentPeriodStart || new Date(), currentPeriodEndsAt]
    );

    return result.rows[0];
  }

  /**
   * Get subscription by customer ID
   */
  static async getByCustomerId(customerId: string): Promise<Subscription | null> {
    const result = await query<Subscription>(
      'SELECT * FROM subscriptions WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1',
      [customerId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get subscription by Stripe subscription ID
   */
  static async getByStripeId(stripeSubscriptionId: string): Promise<Subscription | null> {
    const result = await query<Subscription>(
      'SELECT * FROM subscriptions WHERE stripe_subscription_id = $1',
      [stripeSubscriptionId]
    );
    return result.rows[0] || null;
  }

  /**
   * Update subscription
   */
  static async update(
    customerId: string,
    data: Partial<Pick<Subscription, 'status' | 'plan' | 'stripe_subscription_id' | 'current_period_start' | 'current_period_ends_at' | 'trial_ends_at'>>
  ): Promise<Subscription> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    Object.entries(data).forEach(([key, value]) => {
      // Allow null to clear fields, skip only undefined
      if (value !== undefined) {
        fields.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    });

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(customerId);

    const result = await query<Subscription>(
      `UPDATE subscriptions SET ${fields.join(', ')} 
       WHERE customer_id = $${paramIndex} 
       RETURNING *`,
      values
    );

    return result.rows[0];
  }

  /**
   * Cancel subscription
   */
  static async cancel(customerId: string): Promise<Subscription> {
    return this.update(customerId, { status: 'canceled' });
  }
}
