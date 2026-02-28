/**
 * Deployment Status Types
 * Provides granular tracking of customer instance provisioning lifecycle
 */

/**
 * Deployment status enum with granular stages
 * Each status represents a specific point in the provisioning flow
 */
export type DeploymentStatus =
  // Initial states
  | 'pending'             // Deployment job queued, not yet started
  | 'billing_active'      // Customer has active subscription, not yet provisioned
  | 'provisioning'        // Generic provisioning in progress (legacy)
  
  // Database provisioning
  | 'db_provisioning'     // Creating TigerData database
  | 'db_ready'            // Database created and ready
  | 'failed_db'           // Database provisioning failed
  
  // Secret management
  | 'secret_creating'     // Creating 1Password secret
  | 'secret_ready'        // Secret created successfully
  | 'failed_secret'       // Secret creation failed
  
  // GitOps deployment
  | 'deploying'           // Committing to GitOps repo
  | 'git_committed'       // Git commit successful
  | 'argo_syncing'        // Argo CD syncing application
  | 'failed_deployment'   // Deployment/GitOps failed (Git commit/push)
  | 'argo_failed'         // Argo CD sync/health check failed
  
  // Admin bootstrap
  | 'deployed'            // Argo CD synced, waiting for bootstrap or bootstrap complete
  | 'deployed_bootstrap_pending'  // Deployment complete but bootstrap failed/pending
  
  // Terminal states
  | 'ready'               // Fully provisioned, bootstrapped, and operational
  | 'failed'              // Generic failure (legacy)
  | 'cancelled'           // Subscription cancelled
  | 'deleting'            // Cleanup in progress
  | 'deleted';            // Successfully deleted

/**
 * Provisioning steps - tracks what was successfully completed
 * Used for idempotent retry logic
 */
export type ProvisioningStep =
  | 'db_provisioned'
  | 'secret_created'
  | 'git_committed'
  | 'argo_deployed';

/**
 * Check if a status represents a failure state
 */
export function isFailureStatus(status: DeploymentStatus): boolean {
  return status.startsWith('failed_') || status === 'failed';
}

/**
 * Check if provisioning is in progress
 */
export function isProvisioningInProgress(status: DeploymentStatus): boolean {
  return [
    'provisioning',
    'db_provisioning',
    'secret_creating',
    'deploying',
    'git_committed',
    'argo_syncing',
    'deployed',
    'deployed_bootstrap_pending'
  ].includes(status);
}

/**
 * Check if status is terminal (no further action needed)
 */
export function isTerminalStatus(status: DeploymentStatus): boolean {
  return ['ready', 'cancelled', 'deleted'].includes(status) || isFailureStatus(status);
}

/**
 * Get next expected status in the provisioning flow
 */
export function getNextStatus(currentStatus: DeploymentStatus): DeploymentStatus | null {
  const flow: Record<DeploymentStatus, DeploymentStatus | null> = {
    'pending': 'db_provisioning',
    'billing_active': 'db_provisioning',
    'provisioning': 'db_provisioning',
    'db_provisioning': 'db_ready',
    'db_ready': 'secret_creating',
    'secret_creating': 'secret_ready',
    'secret_ready': 'deploying',
    'deploying': 'git_committed',
    'git_committed': 'argo_syncing',
    'argo_syncing': 'deployed',
    'deployed': 'ready',
    'deployed_bootstrap_pending': 'ready',  // Retry leads to ready or stays terminal
    'ready': null,
    'failed': null,
    'failed_db': null,
    'failed_secret': null,
    'failed_deployment': null,
    'argo_failed': null,
    'cancelled': null,
    'deleting': 'deleted',
    'deleted': null,
  };
  
  return flow[currentStatus] ?? null;
}

/**
 * Determine appropriate failure status based on current step
 */
export function getFailureStatus(currentStatus: DeploymentStatus): DeploymentStatus {
  if (currentStatus === 'db_provisioning') return 'failed_db';
  if (currentStatus === 'db_ready' || currentStatus === 'secret_creating') return 'failed_secret';
  if (['deploying', 'git_committed', 'argo_syncing'].includes(currentStatus)) return 'failed_deployment';
  return 'failed';
}
