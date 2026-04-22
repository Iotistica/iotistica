import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const { logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <span className="font-semibold text-gray-900 text-lg">Iotistica Admin</span>
          <Link
            to="/customers"
            className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            Customers
          </Link>
          <a
            href="/admin/queues"
            target="_blank"
            rel="noreferrer"
            className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            Bull Queues
          </a>
        </div>
        <button
          onClick={handleLogout}
          className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
        >
          Log out
        </button>
      </nav>
      <main className="px-6 py-8 max-w-7xl mx-auto">{children}</main>
    </div>
  );
}
