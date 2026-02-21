const express = require('express');
const helmet = require('helmet');

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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Main redirect endpoint: curl -sfL https://iotistica.com/agent/install | sh
app.get('/agent/install', (req, res) => {
  console.log(`[${new Date().toISOString()}] Install request from ${req.ip}`);
  res.redirect(301, INSTALL_URL);
});

// SHA256 checksum endpoint
app.get('/agent/install.sha256', (req, res) => {
  console.log(`[${new Date().toISOString()}] Checksum request from ${req.ip}`);
  res.redirect(301, INSTALL_SHA256_URL);
});

// Info endpoint - shows what would be executed
app.get('/agent/info', (req, res) => {
  res.json({
    description: 'Iotistic Device Agent Installer',
    usage: 'curl -sfL https://iotistica.com/agent/install | sh',
    install_url: INSTALL_URL,
    checksum_url: INSTALL_SHA256_URL,
    verify_integrity: 'curl -sfL https://iotistica.com/agent/install.sha256 | sha256sum -c -',
    documentation: 'https://iotistica.com/documentation.html#agent-installation'
  });
});

// Catch-all 404
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not Found',
    message: 'Use: curl -sfL https://iotistica.com/agent/install | sh'
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
  console.log(`  Install URL: curl -sfL https://iotistica.com/agent/install | sh\n`);
});
