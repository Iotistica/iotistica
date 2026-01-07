# Mosquitto TLS Configuration Guide

This directory contains Mosquitto broker configuration with **TLS/SSL support using self-signed certificates**.

## Quick Start

### 1. Generate Self-Signed Certificates

**Option A: Using bash (Linux/Mac)**
```bash
cd mosquitto
./generate-mosquitto-certs.sh mosquitto.local 365
```

**Option B: Using Docker (Windows/Linux/Mac)**
```bash
./mosquitto/generate-certs-docker.sh mosquitto.local 365
```

**Option C: Manual OpenSSL**
```bash
mkdir -p mosquitto/certs
openssl genrsa -out mosquitto/certs/server.key 4096
openssl req -new \
  -key mosquitto/certs/server.key \
  -out mosquitto/certs/server.csr \
  -subj "/CN=mosquitto.local/O=IoT/C=US"
openssl x509 -req \
  -days 365 \
  -in mosquitto/certs/server.csr \
  -signkey mosquitto/certs/server.key \
  -out mosquitto/certs/server.crt
chmod 600 mosquitto/certs/server.key
```

### 2. Start Mosquitto

```bash
docker-compose up mosquitto
# or with TLS config
docker-compose up -f docker-compose.yml -f docker-compose.mqtt-tls.yml up
```

### 3. Connect Clients

## Certificate Files

Generated in `mosquitto/certs/`:
- **server.key** - Private key (KEEP SECRET)
- **server.crt** - Public certificate (self-signed)
- **server.csr** - Certificate signing request (can be deleted)

## TLS Ports

| Port | Protocol | Use Case |
|------|----------|----------|
| 8883 | MQTT+TLS | Native MQTT with TLS encryption |
| 9002 | WebSocket+TLS | Browser-based clients |
| 1883 | MQTT | Unencrypted (local only, if enabled) |

## Connection Examples

### Skip Certificate Validation (Development)

**mosquitto_sub (CLI)**
```bash
mosquitto_sub -h localhost -p 8883 --insecure -t 'test/topic'
```

**MQTT.js (Node.js)**
```javascript
const mqtt = require('mqtt');
const client = mqtt.connect('mqtts://localhost:8883', {
  rejectUnauthorized: false,  // Skip certificate validation
  protocolVersion: 4
});
client.subscribe('test/topic');
```

**Python paho-mqtt**
```python
import paho.mqtt.client as mqtt

client = mqtt.Client()
client.tls_set(ca_certs=None, certfile=None, keyfile=None, cert_reqs=None, tls_version=None, ciphers=None)
client.tls_insecure_set(True)  # Skip certificate validation

client.connect('localhost', 8883, 60)
client.subscribe('test/topic')
```

**Go paho MQTT**
```go
opts := mqtt.NewClientOptions()
opts.AddBroker("tcps://localhost:8883")
opts.SetDefaultPublishHandler(func(client mqtt.Client, msg mqtt.Message) {
  fmt.Printf("Topic: %s, Message: %s\n", msg.Topic(), msg.Payload())
})

// Skip certificate validation
opts.SetTLSConfig(&tls.Config{
  InsecureSkipVerify: true,
})

client := mqtt.NewClient(opts)
client.Connect()
```

### Accept Self-Signed Certificate

**Copy certificate to client machine first**

**mosquitto_sub (CLI)**
```bash
cp mosquitto/certs/server.crt /path/to/ca.crt
mosquitto_sub -h localhost -p 8883 --cafile /path/to/ca.crt -t 'test/topic'
```

**MQTT.js (Node.js)**
```javascript
const fs = require('fs');
const mqtt = require('mqtt');

const ca = [fs.readFileSync('./certs/server.crt', 'utf8')];
const client = mqtt.connect('mqtts://localhost:8883', {
  ca: ca,
  rejectUnauthorized: true  // Validate self-signed cert
});
```

**Python paho-mqtt**
```python
import paho.mqtt.client as mqtt

client = mqtt.Client()
# Point to certificate file
client.tls_set(ca_certs='./certs/server.crt', 
               certfile=None, 
               keyfile=None, 
               cert_reqs=mqtt.ssl.CERT_REQUIRED,
               tls_version=mqtt.ssl.PROTOCOL_TLSv1_2)

client.connect('localhost', 8883, 60)
```

## Configuration Details

See `mosquitto-tls.conf`:

```bash
# MQTT over TLS (port 8883)
listener 8883 0.0.0.0
protocol mqtt

# Self-signed certificate
certfile /mosquitto/certs/server.crt
keyfile /mosquitto/certs/server.key

# No client certificate required (username/password auth only)
require_certificate false

# TLS 1.2 minimum
tls_version tlsv1.2
```

## Authentication

Clients must provide username/password (configured in PostgreSQL via go-auth plugin).

**Example with auth:**
```bash
mosquitto_sub -h localhost -p 8883 --insecure \
  -u username -P password \
  -t 'test/topic'
```

## Certificate Renewal

To renew expired certificates:

```bash
# Delete old certs
rm -rf mosquitto/certs/server.*

# Generate new ones
./mosquitto/generate-mosquitto-certs.sh mosquitto.local 365

# Restart broker
docker-compose restart mosquitto
```

## Troubleshooting

### Connection Refused
```bash
# Check if Mosquitto is running
docker-compose ps

# Check logs
docker-compose logs mosquitto
```

### Certificate Verification Failed
- Use `--insecure` flag (development only)
- Or provide `--cafile` with path to `server.crt`
- Or use `rejectUnauthorized: false` in code

### "Unknown CA" Error
This is expected with self-signed certs. Either:
1. Skip verification (development): `--insecure` or `rejectUnauthorized: false`
2. Accept self-signed: `--cafile ./certs/server.crt` or provide `ca` option

### Port Already in Use
```bash
# Check what's using the port
lsof -i :8883

# Or kill the process
docker-compose down
```

## Production Considerations

⚠️ **Self-signed certificates are for development only!**

For production:
1. Use certificates from a trusted CA (Let's Encrypt, etc.)
2. Set `require_certificate true` if using client certificates
3. Enable certificate validation: `rejectUnauthorized: true`
4. Use strong ciphers: restrict `tls_ciphers`
5. Enable certificate pinning in critical clients
6. Rotate certificates regularly

## References

- [Mosquitto TLS Documentation](https://mosquitto.org/documentation/authentication-methods/)
- [MQTT.js TLS Configuration](https://github.com/mqttjs/MQTT.js#mqtts)
- [OpenSSL Self-Signed Certificate Guide](https://www.openssl.org/docs/man1.1.1/man1/req.html)
