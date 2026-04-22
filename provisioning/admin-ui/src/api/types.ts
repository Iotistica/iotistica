export type DeploymentStatus =
  | 'pending'
  | 'billing_active'
  | 'provisioning'
  | 'db_provisioning'
  | 'db_ready'
  | 'failed_db'
  | 'secret_creating'
  | 'secret_ready'
  | 'failed_secret'
  | 'deploying'
  | 'git_committed'
  | 'argo_syncing'
  | 'failed_deployment'
  | 'argo_failed'
  | 'deployed'
  | 'deployed_bootstrap_pending'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'deleting'
  | 'deleted';

export interface Customer {
  id: number;
  customer_id: string;
  email: string;
  company_name: string | null;
  full_name: string | null;
  deployment_status: DeploymentStatus | null;
  instance_url: string | null;
  instance_namespace: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  // From join
  plan?: 'starter' | 'professional' | 'enterprise' | null;
  subscription_status?: string | null;
  trial_ends_at?: string | null;
}

export interface Subscription {
  id: number;
  customer_id: string;
  stripe_subscription_id: string | null;
  plan: 'starter' | 'professional' | 'enterprise';
  status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid';
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_ends_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Job {
  id: string | number;
  type: string;
  data: Record<string, unknown>;
  progress: number;
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused';
  attempts: number;
  failedReason?: string | null;
  timestamp: number;
  processedOn?: number | null;
  finishedOn?: number | null;
}
