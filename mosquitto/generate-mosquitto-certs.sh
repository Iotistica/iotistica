#!/bin/bash
# Generate self-signed certificates for Mosquitto
# Usage: ./generate-mosquitto-certs.sh [common-name] [days-valid]
# Example: ./generate-mosquitto-certs.sh mosquitto.local 365

set -e

# Parameters
COMMON_NAME="${1:-mosquitto.local}"
DAYS_VALID="${2:-365}"
CERT_DIR="/mosquitto/certs"
HOSTNAME=$(hostname -f 2>/dev/null || echo "mosquitto")

# Create certs directory if it doesn't exist
mkdir -p "$CERT_DIR"

echo "🔐 Generating self-signed Mosquitto TLS certificates..."
echo "   Common Name: $COMMON_NAME"
echo "   Hostname: $HOSTNAME"
echo "   Days Valid: $DAYS_VALID"
echo "   Certificate Directory: $CERT_DIR"

# Generate private key (4096-bit RSA)
echo "1️⃣  Generating private key..."
openssl genrsa -out "$CERT_DIR/server.key" 4096

# Generate certificate signing request (CSR)
echo "2️⃣  Generating certificate signing request..."
openssl req -new \
  -key "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.csr" \
  -subj "/CN=$COMMON_NAME/O=IoT/C=US" \
  -addext "subjectAltName=DNS:$COMMON_NAME,DNS:$HOSTNAME,DNS:localhost,IP:127.0.0.1"

# Self-sign the certificate
echo "3️⃣  Self-signing certificate..."
openssl x509 -req \
  -days "$DAYS_VALID" \
  -in "$CERT_DIR/server.csr" \
  -signkey "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.crt" \
  -extensions "subjectAltName=DNS:$COMMON_NAME,DNS:$HOSTNAME,DNS:localhost,IP:127.0.0.1"

# Set proper permissions
chmod 600 "$CERT_DIR/server.key"
chmod 644 "$CERT_DIR/server.crt"
chmod 644 "$CERT_DIR/server.csr"

# Display certificate info
echo ""
echo "✅ Certificates generated successfully!"
echo ""
echo "📋 Certificate Details:"
openssl x509 -in "$CERT_DIR/server.crt" -text -noout | grep -A 5 "Subject:\|Not Before\|Not After\|Subject Alternative Name"

echo ""
echo "⚡ Quick Start:"
echo "   - Broker: mosquitto (port 8883/TLS or 9002/WebSocket+TLS)"
echo "   - Client: Use insecure/skip-verify mode"
echo "   - Example (mosquitto_sub):"
echo "     mosquitto_sub -h localhost -p 8883 --cafile $CERT_DIR/server.crt -t 'test/topic'"
echo ""
echo "📝 Client Configuration Notes:"
echo "   - For clients that SKIP verification (development only):"
echo "     - MQTT.js: { tls: true, rejectUnauthorized: false }"
echo "     - Python paho: client.tls_insecure_set(True)"
echo "     - mosquitto_sub: mosquitto_sub -h host -p 8883 --insecure"
echo ""
echo "   - For clients that ACCEPT self-signed certs:"
echo "     - Copy $CERT_DIR/server.crt to client"
echo "     - MQTT.js: { tls: true, ca: [certificateContent] }"
echo "     - Python paho: client.tls_set(ca_certs='$CERT_DIR/server.crt')"
echo "     - mosquitto_sub: mosquitto_sub -h host -p 8883 --cafile $CERT_DIR/server.crt"
