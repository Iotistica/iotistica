// Jest setup file - runs before tests
// Load test environment variables

const fs = require('fs');
const path = require('path');

function parseEnvValue(rawValue) {
  const trimmed = rawValue.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const envContent = fs.readFileSync(filePath, 'utf-8');
  for (const line of envContent.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = parseEnvValue(trimmed.slice(separatorIndex + 1));
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(__dirname, '../.env.test'));

// Set default test environment variables
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.MQTT_PERSIST_DB = process.env.MQTT_PERSIST_DB || 'false';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
