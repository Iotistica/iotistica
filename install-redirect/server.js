const express = require('express');
const helmet = require('helmet');
const https = require('https');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());

// Azure Storage configuration
const AZURE_STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT || 'iotistic';
const AZURE_STORAGE_CONTAINER = process.env.AZURE_STORAGE_CONTAINER || 'scripts';
const BLOB_INSTALL_PATH = 'agent/install';
const BLOB_INSTALL_SHA256_PATH = 'agent/install.sha256';

// Construct Azure Blob Storage URLs
const INSTALL_URL = `https://${AZURE_STORAGE_ACCOUNT}.blob.core.windows.net/${AZURE_STORAGE_CONTAINER}/${BLOB_INSTALL_PATH}`;
const INSTALL_SHA256_URL = `https://${AZURE_STORAGE_ACCOUNT}.blob.core.windows.net/${AZURE_STORAGE_CONTAINER}/${BLOB_INSTALL_SHA256_PATH}`;

// Helper function to proxy content from Azure Storage
function proxyFromStorage(url, res, contentType = 'text/plain') {
  const parsedUrl = new URL(url);
  
  const options = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname,
    method: 'GET',
    headers: {
      'User-Agent': 'Iotistica-Install-Redirect/1.0'
    }
  };

  https.get(options, (response) => {
    if (response.statusCode !== 200) {
      console.error(`[ERROR] Azure Storage returned ${response.statusCode}: ${response.statusMessage}`);
      res.status(502).json({
        error: 'Bad Gateway',
        message: 'Failed to fetch installation script'
      });
      return;
    }

    // Set appropriate headers
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes
    
    // Pipe Azure Storage response directly to client
    response.pipe(res);
  }).on('error', (error) => {
    console.error(`[ERROR] Failed to fetch from Azure Storage: ${error.message}`);
    if (!res.headersSent) {
      res.status(502).json({
        error: 'Bad Gateway',
        message: 'Failed to fetch installation script'
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
  console.log(`[${new Date().toISOString()}] Install request from ${req.ip}`);
  proxyFromStorage(INSTALL_URL, res, 'text/x-shellscript');
});

// SHA256 checksum endpoint
app.get('/agent.sha256', (req, res) => {
  console.log(`[${new Date().toISOString()}] Checksum request from ${req.ip}`);
  proxyFromStorage(INSTALL_SHA256_URL, res, 'text/plain');
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
