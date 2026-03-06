/**
 * Node-RED Page - Embedded Node-RED interface
 * 
 * Provides seamless SSO integration where dashboard users can access Node-RED
 * without additional authentication. Uses bridge token for iframe auth.
 */

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { auth0Config } from '@/config/auth0';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

export function NodeRedPage() {
  const { user } = useAuth();
  const [bridgeToken, setBridgeToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      setError('User not authenticated');
      setLoading(false);
      return;
    }

    const fetchBridgeToken = async () => {
      const provisioningUrl = auth0Config.provisioningApiUrl || 'http://localhost:3100';

      try {
        setError(null);
        const accessToken = localStorage.getItem('accessToken');
        
        if (!accessToken) {
          setError('No access token found. Please log in again.');
          setLoading(false);
          return;
        }

        // Call provisioning API to get bridge token
        const response = await fetch(
          `${provisioningUrl}/api/auth/create-bridge-token`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ accessToken }),
          }
        );

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to create bridge token');
        }

        const data = await response.json();
        setBridgeToken(data.bridgeToken);
        setLoading(false);
      } catch (err: any) {
        console.error('[NodeRedPage] Error:', err);
        const message = err?.message || 'Failed to authenticate with Node-RED';
        setError(`${message} (auth endpoint: ${provisioningUrl}/api/auth/create-bridge-token)`);
        setLoading(false);
      }
    };

    fetchBridgeToken();
  }, [user]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-4 text-blue-600" />
          <p className="text-muted-foreground">Loading Node-RED...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            <strong>Node-RED Access Error:</strong> {error}
          </AlertDescription>
        </Alert>
        <p className="text-sm text-muted-foreground mt-4">
          Verify `VITE_PROVISIONING_API_URL` points to the provisioning service, then refresh.
        </p>
      </div>
    );
  }

  if (!bridgeToken) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-muted-foreground">Unable to initialize Node-RED</p>
      </div>
    );
  }

  // Determine Node-RED URL based on environment
  const getNodeRedUrl = (): string => {
    const hostname = window.location.hostname;
    
    // Local development
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return `http://localhost:1880?bridgeToken=${encodeURIComponent(bridgeToken)}`;
    }
    
    // K8s deployment - derive from dashboard URL
    // Pattern: https://dash1.iotistica.com -> https://nodered1.iotistica.com
    // Pattern: https://client-{id}.iotistic.ca -> https://nr-{id}.iotistic.ca
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
    
    return `${protocol}//${noderedHostname}?bridgeToken=${encodeURIComponent(bridgeToken)}`;
  };

  const nodeRedUrl = getNodeRedUrl();
  
  // Log the URL for debugging
  console.log('[NodeRedPage] Node-RED URL:', nodeRedUrl);
  console.log('[NodeRedPage] Window location:', window.location.href);

  return (
    <div className="h-screen w-full flex flex-col">
      {/* Header */}
      <div className="border-b border-border bg-card px-6 py-4">
        <h1 className="text-2xl font-bold">Node-RED</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Visual process automation for {user?.email}
        </p>
      </div>

      {/* Iframe Container */}
      <div className="flex-1 overflow-hidden">
        <iframe
          src={nodeRedUrl}
          title="Node-RED"
          className="w-full h-full border-0"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
          onLoad={() => console.log('[NodeRedPage] iframe loaded')}
          onError={(error) => {
            console.error('[NodeRedPage] iframe error:', error);
            setError('Failed to load Node-RED interface');
          }}
        />
      </div>
    </div>
  );
}
