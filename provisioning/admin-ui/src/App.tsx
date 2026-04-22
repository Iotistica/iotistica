import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import { useAuth } from './hooks/useAuth';
import CreateCustomer from './pages/CreateCustomer';
import CustomerDetail from './pages/CustomerDetail';
import CustomerList from './pages/CustomerList';
import Login from './pages/Login';

function ProtectedRoutes() {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return (
    <Layout>
      <Routes>
        <Route path="customers" element={<CustomerList />} />
        <Route path="customers/new" element={<CreateCustomer />} />
        <Route path="customers/:id" element={<CustomerDetail />} />
        <Route path="*" element={<Navigate to="customers" replace />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <BrowserRouter basename="/admin">
      <Routes>
        <Route path="login" element={<Login />} />
        <Route path="/*" element={<ProtectedRoutes />} />
      </Routes>
    </BrowserRouter>
  );
}
