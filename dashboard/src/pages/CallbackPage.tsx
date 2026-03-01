import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import {
  getAuth0CodeFromUrl,
  getAuth0ErrorFromUrl,
  exchangeAuth0Code,
} from '../config/auth0';
import { getApiUrl } from '../config/api';
import { useAuth } from '../contexts/AuthContext';

interface CallbackPageProps {
  onLogin?: (accessToken: string, refreshToken: string, user: any) => void;
}

export function CallbackPage({ onLogin }: CallbackPageProps) {
  const navigate = useNavigate();
  const { login: authContextLogin } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const hasProcessedRef = useRef(false);

  useEffect(() => {
    const processCallback = async () => {
      if (hasProcessedRef.current) {
        return;
      }

      try {
        // Check for Auth0 errors first
        const auth0Error = getAuth0ErrorFromUrl();
        if (auth0Error) {
          throw new Error(`${auth0Error.error}: ${auth0Error.description}`);
        }

        // Get authorization code
        const code = getAuth0CodeFromUrl();
        if (!code) {
          throw new Error('No authorization code in callback URL');
        }

        const lastCode = sessionStorage.getItem('auth0_last_processed_code');
        if (lastCode === code) {
          navigate('/');
          return;
        }

        hasProcessedRef.current = true;

        console.log('[Auth0 Callback] Processing authorization code...');

        // Exchange code for tokens (server-side)
        const apiUrl = getApiUrl();
        
        try {
          const { accessToken, refreshToken, user } = await exchangeAuth0Code(code, apiUrl);

          console.log('[Auth0 Callback] Token exchange successful, user:', user.email);

          // Update auth context
          authContextLogin(accessToken, refreshToken, user);

          // Call optional parent handler
          if (onLogin) {
            onLogin(accessToken, refreshToken, user);
          }

          sessionStorage.setItem('auth0_last_processed_code', code);

          if (window.location.pathname === '/auth/callback' && window.location.search) {
            window.history.replaceState({}, document.title, '/auth/callback');
          }

          // Redirect to dashboard
          setTimeout(() => {
            navigate('/');
          }, 500);
        } catch (tokenError: any) {
          // Debug: Log full error object
          console.log('[Auth0 Callback] Token error caught:', {
            message: tokenError.message,
            data: tokenError.data,
            error: tokenError.data?.error,
            hasAuth0User: !!tokenError.data?.auth0User
          });
          
          // Check if this is a "needs signup" scenario
          if (tokenError.data?.error === 'needs_signup') {
            console.log('[Auth0 Callback] User needs to complete signup, redirecting...');
            
            // Store Auth0 code for signup page to exchange directly
            sessionStorage.setItem('auth0_signup_code', code);
            
            // Store pending signup data
            const signupData = tokenError.data.auth0User ? {
              auth0Sub: tokenError.data.auth0User.sub,
              email: tokenError.data.auth0User.email,
              name: tokenError.data.auth0User.name
            } : {};
            
            sessionStorage.setItem('signup_pending', JSON.stringify(signupData));
            
            // Redirect to website signup page (separate from dashboard)
            console.log('[Auth0 Callback] Redirecting to: http://localhost:3000/complete-signup.html');
            window.location.href = 'http://localhost:3000/complete-signup.html';
            return;
          }
          
          throw tokenError;
        }
      } catch (err: any) {
        hasProcessedRef.current = false;
        console.error('[Auth0 Callback] Error:', err);
        setError(err.message || 'Authentication callback failed');
      }
    };

    processCallback();
  }, [authContextLogin, onLogin, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold text-center">Signing In</CardTitle>
          <CardDescription className="text-center">
            {error ? 'Authentication Error' : 'Processing your login...'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <>
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
              <div className="text-center text-sm text-muted-foreground">
                <p>
                  <button
                    onClick={() => window.location.href = '/login'}
                    className="text-blue-600 hover:underline"
                  >
                    Return to login
                  </button>
                </p>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center space-y-4">
              <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
              <p className="text-sm text-muted-foreground">
                Please wait while we complete your authentication...
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
