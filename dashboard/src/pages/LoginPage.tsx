import { FormEvent, useState } from 'react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { AlertCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getAuth0LoginUrl } from '../config/auth0';

export function LoginPage() {
  const { loginWithAuth0Credentials } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleCredentialsLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');

    if (!username.trim() || !password) {
      setError('Email and password are required');
      return;
    }

    try {
      setIsSubmitting(true);
      await loginWithAuth0Credentials(username.trim(), password);
    } catch (err: any) {
      console.error('Login error:', err);
      setError(err.message || 'Login failed');
    } finally {
      setIsSubmitting(false);
    }
  };

        <CardContent className="space-y-4">
                value={username}
                onChange={(event) => setPassword(event.target.value)}
            <div className="relative flex justify-center text-sm">
          <Button type="button" data-testid="login-google" onClick={handleGoogleLogin} className="w-full bg-white hover:bg-gray-50 text-gray-700 border border-gray-300 disabled:opacity-50" disabled={isSubmitting}>
              />
        return (
          <div data-testid="login-page" className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-100 via-blue-50 to-cyan-100 dark:from-slate-950 dark:via-slate-900 dark:to-slate-800 p-4">
            <Card data-testid="login-card" className="w-full max-w-md border-slate-200 shadow-xl">
              <CardHeader className="space-y-1">
                <CardTitle className="text-2xl font-bold text-center">Sign in to Iotistica</CardTitle>
                <CardDescription className="text-center">
                  Enter your email and password
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {error && (
                  <Alert variant="destructive" data-testid="login-error">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <button onClick={loginWithAuth0Credentials} disabled={isSubmitting} className="w-full bg-blue-600 hover:bg-blue-700">
                  Login with Auth0
                </button>
              </CardContent>
            </Card>
          </div>
        );