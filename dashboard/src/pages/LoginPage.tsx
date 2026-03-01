import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Alert, AlertDescription } from '../components/ui/alert';
import { AlertCircle, Lock } from 'lucide-react';
import { auth0Config, getAuth0LoginUrl } from '../config/auth0';

export function LoginPage() {
  const [error, setError] = useState('');

  const handleAuth0Login = () => {
    try {
      const loginUrl = getAuth0LoginUrl();
      window.location.href = loginUrl;
    } catch (err: any) {
      console.error('Auth0 login error:', err);
      setError(err.message || 'Auth0 login configuration error');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold text-center">
            Welcome to Iotistica
          </CardTitle>
          <CardDescription className="text-center">
            Sign in to access your IoT dashboard
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button
            type="button"
            onClick={handleAuth0Login}
            className="w-full bg-blue-600 hover:bg-blue-700"
          >
            <Lock className="mr-2 h-4 w-4" />
            Login with Auth0
          </Button>

          {auth0Config.showSocialLogin && (
            <Button
              type="button"
              onClick={handleAuth0Login}
              variant="outline"
              className="w-full"
            >
              📧 Login with Google
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}