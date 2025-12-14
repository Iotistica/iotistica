#!/bin/sh
set -e

# Insert default sensor outputs if not exists (idempotent)
node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/device.sqlite');

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
