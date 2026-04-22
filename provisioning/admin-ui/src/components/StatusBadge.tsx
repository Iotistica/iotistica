import { DeploymentStatus } from '../api/types';

const STATUS_CLASSES: Record<string, string> = {
  ready: 'bg-green-100 text-green-800',
  deployed: 'bg-blue-100 text-blue-800',
  argo_syncing: 'bg-blue-100 text-blue-800',
  git_committed: 'bg-blue-100 text-blue-800',
  deploying: 'bg-yellow-100 text-yellow-800',
  provisioning: 'bg-yellow-100 text-yellow-800',
  db_provisioning: 'bg-yellow-100 text-yellow-800',
  secret_creating: 'bg-yellow-100 text-yellow-800',
  db_ready: 'bg-yellow-100 text-yellow-800',
  secret_ready: 'bg-yellow-100 text-yellow-800',
  deployed_bootstrap_pending: 'bg-orange-100 text-orange-800',
  pending: 'bg-gray-100 text-gray-700',
  billing_active: 'bg-gray-100 text-gray-700',
  failed: 'bg-red-100 text-red-800',
  failed_db: 'bg-red-100 text-red-800',
  failed_secret: 'bg-red-100 text-red-800',
  failed_deployment: 'bg-red-100 text-red-800',
  argo_failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-200 text-gray-500',
  deleting: 'bg-orange-100 text-orange-800',
  deleted: 'bg-gray-200 text-gray-500',
};

interface StatusBadgeProps {
  status: DeploymentStatus | string | null | undefined;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  if (!status) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500">
        none
      </span>
    );
  }

  const cls = STATUS_CLASSES[status] ?? 'bg-gray-100 text-gray-700';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}
