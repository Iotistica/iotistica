/**
 * k8s-deployment-service (LEGACY - DEPRECATED)
 * 
 * This is a stub for the legacy Helm-based deployment service.
 * The system now uses GitOps-based deployments via gitops-provisioning-service.ts
 * 
 * This stub prevents compilation errors in existing code that references the old service.
 */

export interface DeploymentResult {
  success: boolean;
  customerId: string;
  instanceUrl?: string;
  namespace?: string;
  error?: string;
}

export interface DeploymentStatusResult {
  customerId: string;
  namespace: string;
  status: string;
  ready: boolean;
  instanceUrl?: string;
  error?: string;
}

export interface DeploymentParams {
  customerId: string;
  email: string;
  companyName: string;
  licenseKey: string;
  namespace?: string;
}

class K8sDeploymentService {
  /**
   * Deploy customer instance (LEGACY - NOT IMPLEMENTED)
   * Use gitops-provisioning-service.deployClient() instead
   */
  async deployCustomerInstance(params: DeploymentParams): Promise<DeploymentResult> {
    throw new Error(
      'Legacy Helm deployment is not supported. ' +
      'Set GITOPS_ENABLED=true to use GitOps-based deployments. ' +
      'See gitops-provisioning-service.ts for implementation.'
    );
  }

  /**
   * Update customer instance (LEGACY - NOT IMPLEMENTED)
   * Use gitops-provisioning-service.updateClient() instead
   */
  async updateCustomerInstance(params: DeploymentParams): Promise<DeploymentResult> {
    throw new Error(
      'Legacy Helm update is not supported. ' +
      'Set GITOPS_ENABLED=true to use GitOps-based updates. ' +
      'See gitops-provisioning-service.ts for implementation.'
    );
  }

  /**
   * Delete customer instance (LEGACY - NOT IMPLEMENTED)
   * Use gitops-provisioning-service.deleteClient() instead
   */
  async deleteCustomerInstance(customerId: string): Promise<DeploymentResult> {
    throw new Error(
      'Legacy Helm deletion is not supported. ' +
      'Set GITOPS_ENABLED=true to use GitOps-based deletions. ' +
      'See gitops-provisioning-service.ts for implementation.'
    );
  }

  /**
   * Get deployment status (LEGACY - NOT IMPLEMENTED)
   * Query customer database directly or use argoStatusService.ts
   */
  async getDeploymentStatus(customerId: string): Promise<DeploymentStatusResult> {
    throw new Error(
      'Legacy status check is not supported. ' +
      'Use CustomerModel.getById() to check deployment_status field, ' +
      'or use argoStatusService.getApplicationStatus() for Argo CD status.'
    );
  }
}

// Export singleton instance
export const k8sDeploymentService = new K8sDeploymentService();
