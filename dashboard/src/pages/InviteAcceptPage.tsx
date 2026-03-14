import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle, AlertCircle, Loader2, Mail } from 'lucide-react';
import { Button } from '../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import { Alert, AlertDescription } from '../components/ui/alert';
import { getAuth0LoginUrl } from '../config/auth0';
import { useAuth } from '../contexts/AuthContext';
import { buildApiUrl } from '../config/api';

type PageStatus = 'checking' | 'ready' | 'accepting' | 'success' | 'error';

export function InviteAcceptPage() {
  const [searchParams] = useSearchParams();
  const { isAuthenticated, login } = useAuth();
  const [status, setStatus] = useState<PageStatus>('checking');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Token is either in the URL or was saved in sessionStorage before the Auth0 redirect
  const tokenFromUrl = searchParams.get('token');
  const token = tokenFromUrl || sessionStorage.getItem('pending_invite_token');

  useEffect(() => {
    if (!token) {
      setErrorMessage('No invite token found. This link may be invalid or expired.');
      setStatus('error');
      return;
    }

    if (!isAuthenticated) {
      // Save token so we can pick it up after Auth0 login
      sessionStorage.setItem('pending_invite_token', token);
      window.location.href = getAuth0LoginUrl();
      return;
    }

    // Authenticated and token present — auto-accept
    setStatus('ready');
  }, [isAuthenticated, token]);

  useEffect(() => {
    if (status === 'ready') {
      acceptInvite();
    }
  }, [status]);

  const acceptInvite = async () => {
    const currentToken = token;
    if (!currentToken) return;

    setStatus('accepting');

    try {
      const accessToken = localStorage.getItem('accessToken') || localStorage.getItem('token');
      const response = await fetch(buildApiUrl('/api/v1/invites/accept'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ token: currentToken }),
      });

      const data = await response.json();

      if (!response.ok) {
        const message =
          response.status === 410
            ? 'This invite has expired. Please request a new one.'
            : response.status === 409
            ? 'This invite has already been used.'
            : data.message || 'Failed to accept the invitation. Please try again.';
        setErrorMessage(message);
        setStatus('error');
        return;
      }

      // Clear the saved token
      sessionStorage.removeItem('pending_invite_token');

      // Log in with the new tenant-scoped JWT
      login(data.data.accessToken, data.data.refreshToken, data.data.user);

      setStatus('success');

      // Navigate to dashboard after a short delay
      setTimeout(() => {
        window.location.href = '/';
      }, 2000);
    } catch (err: any) {
      setErrorMessage('An unexpected error occurred. Please try again.');
      setStatus('error');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1 text-center">
          <div className="flex justify-center mb-2">
            <Mail className="w-10 h-10 text-blue-600" />
          </div>
          <CardTitle className="text-2xl font-bold">Team Invitation</CardTitle>
          <CardDescription>
            You have been invited to join an Iotistic workspace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(status === 'checking' || status === 'ready' || status === 'accepting') && (
            <div className="flex flex-col items-center gap-4 py-4">
              <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              <p className="text-sm text-muted-foreground">
                {status === 'accepting' ? 'Accepting invitation...' : 'Verifying your invitation...'}
              </p>
            </div>
          )}

          {status === 'success' && (
            <div className="flex flex-col items-center gap-4 py-4">
              <CheckCircle className="w-10 h-10 text-green-600" />
              <div className="text-center">
                <p className="font-semibold text-green-700">Invitation accepted!</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Redirecting you to the dashboard...
                </p>
              </div>
            </div>
          )}

          {status === 'error' && (
            <div className="space-y-4">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
              <div className="text-center">
                <Button variant="outline" onClick={() => (window.location.href = '/')}>
                  Go to Dashboard
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
