import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { checkAuth } from '../api/client';
import { useAuth } from '../hooks/useAuth';

export default function Login() {
  const { setToken } = useAuth();
  const navigate = useNavigate();
  const [tokenInput, setTokenInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!tokenInput.trim()) {
      setError('Token is required');
      return;
    }
    setLoading(true);
    try {
      // Store token so the API client can pick it up for the auth check
      sessionStorage.setItem('admin_token', tokenInput.trim());
      const valid = await checkAuth();
      if (!valid) {
        sessionStorage.removeItem('admin_token');
        setError('Invalid token');
        return;
      }
      setToken(tokenInput.trim());
      navigate('/customers', { replace: true });
    } catch {
      sessionStorage.removeItem('admin_token');
      setError('Could not connect to the provisioning API');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 w-full max-w-sm">
        <h1 className="text-xl font-semibold text-gray-900 mb-6">Iotistica Admin</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="token" className="block text-sm font-medium text-gray-700 mb-1">
              Admin token
            </label>
            <input
              id="token"
              type="password"
              autoComplete="current-password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="ADMIN_API_TOKEN value"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-2 px-4 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Checking...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
