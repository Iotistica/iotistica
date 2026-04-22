import { ChangeEvent, FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  deleteCustomer,
  deprovisionCustomer,
  getCustomer,
  provisionCustomer,
  updateCustomer,
} from '../api/client';
import { Customer, Subscription } from '../api/types';
import JobsPanel from '../components/JobsPanel';
import StatusBadge from '../components/StatusBadge';

export default function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Edit form
  const [editing, setEditing] = useState(false);
  const [companyName, setCompanyName] = useState('');
  const [fullName, setFullName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Action state
  const [actionMsg, setActionMsg] = useState('');
  const [actionError, setActionError] = useState('');
  const [confirming, setConfirming] = useState<'provision' | 'deprovision' | 'delete' | null>(null);
  const [jobRefresh, setJobRefresh] = useState(0);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getCustomer(id)
      .then(({ customer: c, subscription: s }) => {
        setCustomer(c);
        setSubscription(s);
        setCompanyName(c.company_name ?? '');
        setFullName(c.full_name ?? '');
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!id) return;
    setSaving(true);
    setSaveError('');
    try {
      const { customer: updated } = await updateCustomer(id, { company_name: companyName, full_name: fullName });
      setCustomer(updated);
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleProvision() {
    if (!id) return;
    setConfirming(null);
    setActionMsg('');
    setActionError('');
    try {
      const result = await provisionCustomer(id);
      setActionMsg(`Deployment job queued (${result.jobId}). Watch jobs below.`);
      setJobRefresh((n: number) => n + 1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function handleDeprovision() {
    if (!id) return;
    setConfirming(null);
    setActionMsg('');
    setActionError('');
    try {
      const result = await deprovisionCustomer(id);
      setActionMsg(`Deprovision job queued (${result.jobId}).`);
      setJobRefresh((n: number) => n + 1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function handleDelete() {
    if (!id) return;
    setConfirming(null);
    try {
      await deleteCustomer(id);
      navigate('/customers', { replace: true });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading...</p>;
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!customer) return <p className="text-sm text-gray-500">Customer not found.</p>;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Link to="/customers" className="text-sm text-blue-600 hover:text-blue-800 mb-1 inline-block">
            &larr; Back to customers
          </Link>
          <h1 className="text-2xl font-semibold text-gray-900">{customer.email}</h1>
          <div className="flex items-center gap-3 mt-1">
            <StatusBadge status={customer.deployment_status} />
            <span className="text-sm text-gray-500 capitalize">{subscription?.plan ?? 'No plan'}</span>
            {!customer.is_active && (
              <span className="text-xs text-gray-400 font-medium">Inactive</span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 flex-wrap justify-end">
          <button
            onClick={() => setConfirming('provision')}
            className="bg-green-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-green-700 transition-colors"
          >
            Provision
          </button>
          <button
            onClick={() => setConfirming('deprovision')}
            className="bg-orange-500 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-orange-600 transition-colors"
          >
            Deprovision
          </button>
          <button
            onClick={() => setConfirming('delete')}
            className="bg-red-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-red-700 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Confirmation dialogs */}
      {confirming === 'provision' && (
        <ConfirmBanner
          message={`Queue a deployment job for ${customer.email}?`}
          onConfirm={handleProvision}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming === 'deprovision' && (
        <ConfirmBanner
          message={`Queue a deprovision (teardown) job for namespace ${customer.instance_namespace ?? customer.customer_id}?`}
          onConfirm={handleDeprovision}
          onCancel={() => setConfirming(null)}
          danger
        />
      )}
      {confirming === 'delete' && (
        <ConfirmBanner
          message={`Soft-delete ${customer.email}? This sets is_active=false and status=cancelled.`}
          onConfirm={handleDelete}
          onCancel={() => setConfirming(null)}
          danger
        />
      )}

      {actionMsg && (
        <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-md text-sm">
          {actionMsg}
        </div>
      )}
      {actionError && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md text-sm">
          {actionError}
        </div>
      )}

      {/* Details grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Editable fields */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-medium text-gray-900">Details</h2>
            {!editing && (
              <button
                onClick={() => setEditing(true)}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                Edit
              </button>
            )}
          </div>

          {editing ? (
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Company name</label>
                <input
                  type="text"
                  value={companyName}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setCompanyName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Full name</label>
                <input
                  type="text"
                  value={fullName}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setFullName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              {saveError && <p className="text-sm text-red-600">{saveError}</p>}
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => { setEditing(false); setSaveError(''); }}
                  className="px-3 py-1.5 border border-gray-300 rounded-md text-sm hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <dl className="space-y-3 text-sm">
              <Row label="Customer ID" value={customer.customer_id} mono />
              <Row label="Email" value={customer.email} />
              <Row label="Company" value={customer.company_name ?? '—'} />
              <Row label="Full name" value={customer.full_name ?? '—'} />
              <Row label="Namespace" value={customer.instance_namespace ?? '—'} mono />
              <Row
                label="Instance URL"
                value={
                  customer.instance_url ? (
                    <a
                      href={customer.instance_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      {customer.instance_url}
                    </a>
                  ) : '—'
                }
              />
            </dl>
          )}
        </div>

        {/* Subscription / billing */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-base font-medium text-gray-900 mb-4">Subscription</h2>
          {subscription ? (
            <dl className="space-y-3 text-sm">
              <Row label="Plan" value={<span className="capitalize">{subscription.plan}</span>} />
              <Row label="Status" value={<span className="capitalize">{subscription.status}</span>} />
              <Row
                label="Trial ends"
                value={subscription.trial_ends_at ? new Date(subscription.trial_ends_at).toLocaleDateString() : '—'}
              />
              <Row
                label="Period ends"
                value={subscription.current_period_ends_at ? new Date(subscription.current_period_ends_at).toLocaleDateString() : '—'}
              />
              <Row label="Stripe sub ID" value={subscription.stripe_subscription_id ?? '—'} mono />
            </dl>
          ) : (
            <p className="text-sm text-gray-500">No subscription found.</p>
          )}
        </div>
      </div>

      {/* Jobs panel */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <JobsPanel customerId={customer.customer_id} refreshTrigger={jobRefresh} />
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <dt className="text-gray-500 w-32 shrink-0">{label}</dt>
      <dd className={`text-gray-900 break-all ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}

function ConfirmBanner({
  message,
  onConfirm,
  onCancel,
  danger = false,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}) {
  return (
    <div className={`border rounded-md px-4 py-3 flex items-center justify-between gap-4 ${danger ? 'bg-red-50 border-red-200' : 'bg-yellow-50 border-yellow-200'}`}>
      <p className={`text-sm ${danger ? 'text-red-700' : 'text-yellow-800'}`}>{message}</p>
      <div className="flex gap-2 shrink-0">
        <button
          onClick={onConfirm}
          className={`px-3 py-1 text-sm font-medium rounded-md text-white transition-colors ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-yellow-600 hover:bg-yellow-700'}`}
        >
          Confirm
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1 text-sm border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
