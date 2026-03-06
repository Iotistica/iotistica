import { useMemo } from 'react';

export function NodeRedPage() {
  const nodeRedUrl = useMemo(() => {
    // Determine Node-RED URL based on environment
    const hostname = window.location.hostname;
    
    // Local development
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://localhost:1880';
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
    
    return `${protocol}//${noderedHostname}`;
  }, []);
  
  // Log the URL for debugging
  console.log('[NodeRedPage] Node-RED URL:', nodeRedUrl);
  console.log('[NodeRedPage] Window location:', window.location.href);

  return (
    <div className="h-screen w-full flex flex-col">
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
          }}
        />
      </div>
    </div>
  );
}
