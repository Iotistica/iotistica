const express = require('express');
const helmet = require('helmet');
const https = require('https');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);

// Security middleware
app.use(helmet());

// Azure Storage configuration
const AZURE_STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT || 'iotistic';
const AZURE_STORAGE_CONTAINER = process.env.AZURE_STORAGE_CONTAINER || 'scripts';
const BLOB_INSTALL_PATH = process.env.BLOB_INSTALL_PATH || 'agent/install.sh';
const BLOB_INSTALL_SHA256_PATH = process.env.BLOB_INSTALL_SHA256_PATH || 'agent/install.sh.sha256';

// Construct Azure Blob Storage URLs
const INSTALL_URL = `https://${AZURE_STORAGE_ACCOUNT}.blob.core.windows.net/${AZURE_STORAGE_CONTAINER}/${BLOB_INSTALL_PATH}`;
const INSTALL_SHA256_URL = `https://${AZURE_STORAGE_ACCOUNT}.blob.core.windows.net/${AZURE_STORAGE_CONTAINER}/${BLOB_INSTALL_SHA256_PATH}`;

function buildStorageUrl(blobPath) {
  return `https://${AZURE_STORAGE_ACCOUNT}.blob.core.windows.net/${AZURE_STORAGE_CONTAINER}/${blobPath}`;
}

function normalizeArtifactPath(requestPath) {
  if (!requestPath || requestPath.startsWith('/') || requestPath.includes('..')) {
    return null;
  }

  if (!/^[A-Za-z0-9._/-]+$/.test(requestPath)) {
    return null;
  }

  return `agent/${requestPath}`;
}

function getRequestContext(req) {
  return {
    method: req.method,
    path: req.originalUrl,
    host: req.get('host') || '',
    ip: req.ip,
    forwardedFor: req.get('x-forwarded-for') || '',
    forwardedProto: req.get('x-forwarded-proto') || '',
    envoyExternalAddress: req.get('x-envoy-external-address') || '',
    requestId: req.get('x-request-id') || '',
    userAgent: req.get('user-agent') || ''
  };
}

// Helper function to proxy content from Azure Storage
function proxyFromStorage(url, req, res, contentType = 'text/plain', failureMessage = 'Failed to fetch installation script') {
  const parsedUrl = new URL(url);
  const requestContext = getRequestContext(req);
  
  const options = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname,
    method: 'GET',
    headers: {
      'User-Agent': 'Iotistica-Install-Redirect/1.0'
    }
  };

  console.log(`[${new Date().toISOString()}] Proxy request ${JSON.stringify({
    ...requestContext,
    blobUrl: url
  })}`);

  https.get(options, (response) => {
    if (response.statusCode !== 200) {
      console.error(`[ERROR] Azure Storage returned ${response.statusCode}: ${response.statusMessage} ${JSON.stringify({
        ...requestContext,
        blobUrl: url
      })}`);
      res.status(502).json({
        error: 'Bad Gateway',
        message: failureMessage
      });
      return;
    }

    // Set appropriate headers
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes

    console.log(`[${new Date().toISOString()}] Proxy success ${JSON.stringify({
      ...requestContext,
      blobUrl: url,
      statusCode: response.statusCode,
      contentType
    })}`);
    
    // Pipe Azure Storage response directly to client
    response.pipe(res);
  }).on('error', (error) => {
    console.error(`[ERROR] Failed to fetch from Azure Storage: ${error.message} ${JSON.stringify({
      ...requestContext,
      blobUrl: url
    })}`);
    if (!res.headersSent) {
      res.status(502).json({
        error: 'Bad Gateway',
        message: failureMessage
      });
    }
  });
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Main proxy endpoint: curl -sfL https://get.iotistica.com/agent | sh
app.get('/agent', (req, res) => {
  proxyFromStorage(INSTALL_URL, req, res, 'text/x-shellscript');
});

// SHA256 checksum endpoint
app.get('/agent.sha256', (req, res) => {
  proxyFromStorage(INSTALL_SHA256_URL, req, res, 'text/plain');
});

// Tarball proxy endpoint used by install.sh so clients do not need direct Azure URLs.
app.get('/agent/artifacts/*', (req, res) => {
  const requestedPath = req.params[0];
  const blobPath = normalizeArtifactPath(requestedPath);

  if (!blobPath) {
    res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid artifact path'
    });
    return;
  }

  const contentType = blobPath.endsWith('.sha256')
    ? 'text/plain'
    : blobPath.endsWith('.json')
      ? 'application/json'
      : 'application/gzip';

  proxyFromStorage(
    buildStorageUrl(blobPath),
    req,
    res,
    contentType,
    'Failed to fetch agent artifact'
  );
});

// Info endpoint - shows what would be executed
app.get('/agent/info', (req, res) => {
  const publicDomain = req.get('host') || 'get.iotistica.com';
  const protocol = req.secure || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  
  res.json({
    description: 'Iotistica Agent Installer',
    usage: `curl -sfL ${protocol}://${publicDomain}/agent | sh`,
    install_url: `${protocol}://${publicDomain}/agent`,
    checksum_url: `${protocol}://${publicDomain}/agent.sha256`,
    artifacts_base_url: `${protocol}://${publicDomain}/agent/artifacts`,
    verify_integrity: `curl -sfL ${protocol}://${publicDomain}/agent.sha256 | sha256sum -c -`,
    documentation: 'https://iotistica.com/documentation.html#agent-installation'
  });
});

// Catch-all 404
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not Found',
    message: 'Use: curl -sfL https://get.iotistica.com/agent | sh'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${err.message}`);
  res.status(500).json({ 
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? 'An error occurred' : err.message
  });
});

app.listen(PORT, () => {
  console.log(`\n✓ Iotistica Install Redirect Service running on port ${PORT}`);
  console.log(`  Install URL: curl -sfL https://get.iotistica.com/agent | sh\n`);
});
