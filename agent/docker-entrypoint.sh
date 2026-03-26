#!/bin/sh
set -e

# Create Tailscale socket directory only for edge agents (not virtual agents)
# Virtual agents run in Kubernetes and don't need VPN
if [ "$IS_VIRTUAL_AGENT" != "true" ]; then
  mkdir -p /var/run/tailscale
  mkdir -p /var/lib/tailscale
fi

# Migrate legacy database name: device.sqlite -> agent.sqlite
# Runs once on upgrade; safe to leave in place (idempotent)
if [ -f /app/data/device.sqlite ] && [ ! -f /app/data/agent.sqlite ]; then
  mv /app/data/device.sqlite /app/data/agent.sqlite
fi

# Insert default sensor outputs if not exists (idempotent)
node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/agent.sqlite');

// Check if endpoint_outputs table exists
const tableExists = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='endpoint_outputs'\").get();

if (tableExists) {
  const isWindows = process.platform === 'win32';
  const protocols = ['modbus', 'can', 'opcua', 'snmp'];
  const socketPaths = {
    modbus: isWindows ? '\\\\\\\\.\\\\pipe\\\\modbus' : '/tmp/modbus.sock',
    can: isWindows ? '\\\\\\\\.\\\\pipe\\\\canbus' : '/tmp/canbus.sock',
    opcua: isWindows ? '\\\\\\\\.\\\\pipe\\\\opcua' : '/tmp/opcua.sock',
    snmp: isWindows ? '\\\\\\\\.\\\\pipe\\\\snmp' : '/tmp/snmp.sock'
  };

  protocols.forEach(protocol => {
    const exists = db.prepare('SELECT id FROM endpoint_outputs WHERE protocol = ?').get(protocol);
    if (!exists) {
      db.prepare(\`
        INSERT INTO endpoint_outputs (protocol, socket_path, data_format, delimiter, include_timestamp, include_device_name, logging)
        VALUES (?, ?, 'json', '\\n', 1, 1, ?)
      \`).run(protocol, socketPaths[protocol], JSON.stringify({ level: 'info' }));
    }
  });
}

db.close();
" 2>/dev/null || true

# Start the agent
exec "$@"
