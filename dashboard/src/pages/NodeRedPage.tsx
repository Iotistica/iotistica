import { useMemo, useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

export function NodeRedPage() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const [tokenReady, setTokenReady] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  
  const nodeRedUrl = useMemo(() => {
    // Determine Node-RED URL based on environment
    const hostname = window.location.hostname;
    
    // Local development - use direct URL to avoid path rewriting issues
    // Node-RED has CORS configured to allow localhost:8080 origin
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://localhost:1880';
    }
    
    // K8s deployment - derive from dashboard URL
    // Pattern: https://dash1.iotistica.com -> https://nodered1.iotistica.com
    // Pattern: https://client-{id}.iotistica.com -> https://nr-{id}.iotistica.com
    const protocol = window.location.protocol;
    let noderedHostname = hostname;
    
    // Replace dashboard subdomain with nodered subdomain
    if (hostname.startsWith('dash')) {
      noderedHostname = hostname.replace(/^dash/, 'nodered');
    } else if (hostname.startsWith('client-')) {
      noderedHostname = hostname.replace(/^client-/, 'nr-');
    } else {
      // Fallback: prepend 'nodered-' or 'nr-'
      noderedHostname = `nodered-${hostname}`;
    }
    
    return `${protocol}//${noderedHostname}`;
  }, []);
  
  // Get access token and pass to Node-RED
  useEffect(() => {
    async function setupAuth() {
      if (!isAuthenticated || !user) {
        console.log('[NodeRedPage] Not authenticated, skipping token setup');
        return;
      }
      
      try {
        console.log('[NodeRedPage] Getting access token from localStorage...');
        const token = localStorage.getItem('accessToken');
        
        if (!token) {
          throw new Error('Access token not found in localStorage');
        }
        
        // Store in sessionStorage for nr-devices-plugin
        sessionStorage.setItem('auth0_token', token);
        console.log('[NodeRedPage] Access token stored in sessionStorage');

        // Bridge token into Node-RED session so editor loads without login prompt.
        const bridgeResponse = await fetch(`${nodeRedUrl}/admin/auth/token`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ token }),
        });

        if (!bridgeResponse.ok) {
          const errorText = await bridgeResponse.text();
          throw new Error(`Node-RED auth bridge failed (${bridgeResponse.status}): ${errorText}`);
        }

        console.log('[NodeRedPage] Node-RED session established via auth bridge');
        
        setTokenReady(true);
      } catch (error: any) {
        console.error('[NodeRedPage] Failed to setup access token:', error);
        setTokenError(error.message || 'Failed to authenticate with Node-RED');
      }
    }
    
    setupAuth();
  }, [isAuthenticated, user, nodeRedUrl]);
  
  // Log the URL for debugging
  console.log('[NodeRedPage] Node-RED URL:', nodeRedUrl);
  console.log('[NodeRedPage] Window location:', window.location.href);
  
  // Loading state
  if (isLoading) {
    return (
      <div className="h-screen w-full flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading authentication...</p>
        </div>
      </div>
    );
  }
  
  // Not authenticated
  if (!isAuthenticated) {
    return (
      <div className="h-screen w-full flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 text-lg mb-4">Authentication required</p>
          <p className="text-gray-600">Please log in to access Node-RED</p>
        </div>
      </div>
    );
  }
  
  // Token error
  if (tokenError) {
    return (
      <div className="h-screen w-full flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 text-lg mb-4">Authentication Error</p>
          <p className="text-gray-600">{tokenError}</p>
          <button 
            onClick={() => window.location.reload()} 
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-full flex flex-col">
      {/* Iframe Container */}
      <div className="flex-1 overflow-hidden">
        {tokenReady ? (
          <iframe
            src={nodeRedUrl}
            title="Node-RED"
            className="w-full h-full border-0"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
            onLoad={() => console.log('[NodeRedPage] iframe loaded')}
            onError={(error) => {
              console.error('[NodeRedPage] iframe error:', error);
            }}
          />
        ) : (
          <div className="h-full w-full flex items-center justify-center">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900 mx-auto mb-4"></div>
              <p className="text-gray-600">Connecting to Node-RED...</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
