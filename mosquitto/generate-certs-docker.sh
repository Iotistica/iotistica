#!/bin/bash
# Docker-based certificate generation for Mosquitto with self-signed TLS
# Run from project root: ./mosquitto/generate-certs-docker.sh

set -e

CERT_DIR="mosquitto/certs"
COMMON_NAME="${1:-mosquitto.local}"
DAYS_VALID="${2:-365}"

echo "🐳 Using Docker to generate self-signed certificates..."

# Create certs directory if needed
mkdir -p "$CERT_DIR"

# Generate using Docker
docker run --rm \
  -v "$(pwd)/$CERT_DIR:/certs" \
  alpine/openssl \
  sh -c "
    set -e
    echo 'Generating private key...'
    openssl genrsa -out /certs/server.key 4096
    
    echo 'Generating CSR...'
    openssl req -new \
      -key /certs/server.key \
      -out /certs/server.csr \
      -subj '/CN=$COMMON_NAME/O=IoT/C=US' \
      -addext 'subjectAltName=DNS:$COMMON_NAME,DNS:mosquitto,DNS:localhost,IP:127.0.0.1'
    
    echo 'Self-signing certificate...'
    openssl x509 -req \
      -days $DAYS_VALID \
      -in /certs/server.csr \
      -signkey /certs/server.key \
      -out /certs/server.crt \
      -extensions 'subjectAltName=DNS:$COMMON_NAME,DNS:mosquitto,DNS:localhost,IP:127.0.0.1'
    
    chmod 600 /certs/server.key
    chmod 644 /certs/server.crt
    echo 'Done!'
  "

echo ""
echo "✅ Certificates generated in $CERT_DIR"
echo ""
echo "📋 Certificate Details:"
openssl x509 -in "$CERT_DIR/server.crt" -text -noout | grep -A 2 "Subject:\|Not Before\|Not After" || true

echo ""
echo "⚡ Next Steps:"
echo "   1. Start Mosquitto with TLS:"
echo "      docker-compose up mosquitto"
echo ""
echo "   2. Connect with TLS (skip verification for self-signed):"
echo "      mosquitto_sub -h localhost -p 8883 --insecure -t 'test/topic'"
echo ""
echo "   3. Or use the certificate file:"
echo "      mosquitto_sub -h localhost -p 8883 --cafile $CERT_DIR/server.crt -t 'test/topic'"
