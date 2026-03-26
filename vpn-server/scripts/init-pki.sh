#!/bin/bash
set -e

# Initialize PKI for Iotistic VPN Server
# This script sets up the Certificate Authority and server certificates

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VPN_ROOT="$(dirname "$SCRIPT_DIR")"
PKI_DIR="/etc/openvpn/pki"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $1${NC}"
}

success() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] SUCCESS: $1${NC}"
}

warn() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $1${NC}"
}

print_banner() {
    echo -e "${BLUE}"
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║            Iotistic VPN Server PKI Initialization        ║"
    echo "║                                                           ║"
    echo "║  This script will initialize the Public Key              ║"
    echo "║  Infrastructure (PKI) for the Iotistic VPN server.       ║"
    echo "║                                                           ║"
    echo "║  Components to be created:                                ║"
    echo "║  • Certificate Authority (CA)                             ║"
    echo "║  • Server Certificate                                     ║"
    echo "║  • Diffie-Hellman Parameters                              ║"
    echo "║  • TLS Authentication Key                                 ║"
    echo "║  • Certificate Revocation List (CRL)                     ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

check_requirements() {
    log "Checking requirements..."
    
    # Check if running as root (needed for /etc/openvpn access)
    if [ "$EUID" -ne 0 ] && [ ! -w "$(dirname "$PKI_DIR")" ]; then
        error "This script needs write access to $PKI_DIR"
        echo "Run with sudo or ensure proper permissions"
        exit 1
    fi
    
    # Check if easy-rsa is available
    if ! command -v /usr/share/easy-rsa/easyrsa &> /dev/null; then
        error "easy-rsa not found. Please install it first:"
        echo "  Alpine: apk add easy-rsa"
        echo "  Ubuntu: apt install easy-rsa"
        echo "  CentOS: yum install easy-rsa"
        exit 1
    fi
    
    # Check if OpenVPN is available
    if ! command -v openvpn &> /dev/null; then
        error "OpenVPN not found. Please install it first:"
        echo "  Alpine: apk add openvpn"
        echo "  Ubuntu: apt install openvpn"
        echo "  CentOS: yum install openvpn"
        exit 1
    fi
    
    success "All requirements satisfied"
}

setup_pki_directory() {
    log "Setting up PKI directory structure..."
    
    # Create PKI directory if it doesn't exist
    mkdir -p "$PKI_DIR"
    cd "$PKI_DIR"
    
    # Create subdirectories
    mkdir -p \
        issued \
        private \
        certs \
        client-configs \
        revoked
    
    success "PKI directory structure created"
}

initialize_pki() {
    log "Initializing PKI..."
    
    cd "$PKI_DIR"
    
    # Initialize easy-rsa
    /usr/share/easy-rsa/easyrsa init-pki
    
    success "PKI initialized"
}

create_ca() {
    log "Creating Certificate Authority..."
    
    cd "$PKI_DIR"
    
    # Set environment variables for non-interactive mode
    export EASYRSA_REQ_COUNTRY="CA"
    export EASYRSA_REQ_PROVINCE="ON"
    export EASYRSA_REQ_CITY="Toronto"
    export EASYRSA_REQ_ORG="Iotistic Platform"
    export EASYRSA_REQ_EMAIL="ca@iotistica.com"
    export EASYRSA_REQ_OU="VPN Certificate Authority"
    export EASYRSA_REQ_CN="Iotistic VPN CA"
    
    # Build CA (non-interactive)
    echo "iotistic-vpn-ca" | /usr/share/easy-rsa/easyrsa build-ca nopass
    
    success "Certificate Authority created"
}

create_server_cert() {
    log "Creating server certificate..."
    
    cd "$PKI_DIR"
    
    # Set server name
    local server_name="vpn-server"
    
    # Generate server request (non-interactive)
    echo "$server_name" | /usr/share/easy-rsa/easyrsa gen-req "$server_name" nopass
    
    # Sign server certificate (non-interactive)
    echo "yes" | /usr/share/easy-rsa/easyrsa sign-req server "$server_name"
    
    success "Server certificate created"
}

create_dh_params() {
    log "Generating Diffie-Hellman parameters (this may take a while)..."
    
    cd "$PKI_DIR"
    
    # Generate DH parameters
    /usr/share/easy-rsa/easyrsa gen-dh
    
    success "Diffie-Hellman parameters generated"
}

create_tls_auth() {
    log "Generating TLS authentication key..."
    
    cd "$PKI_DIR"
    
    # Generate TLS auth key
    openvpn --genkey --secret ta.key
    
    success "TLS authentication key generated"
}

create_crl() {
    log "Creating Certificate Revocation List..."
    
    cd "$PKI_DIR"
    
    # Generate empty CRL
    /usr/share/easy-rsa/easyrsa gen-crl
    
    success "Certificate Revocation List created"
}

set_permissions() {
    log "Setting proper permissions..."
    
    cd "$PKI_DIR"
    
    # Set ownership
    chown -R root:root .
    
    # Set directory permissions
    chmod 755 .
    chmod 755 issued certs client-configs revoked
    chmod 700 private
    
    # Set file permissions
    chmod 644 ca.crt
    chmod 644 issued/*
    chmod 600 private/*
    chmod 600 ta.key
    
    # Make CRL readable by OpenVPN
    chmod 644 crl.pem
    
    success "Permissions set correctly"
}

create_summary() {
    log "Creating PKI summary..."
    
    cat > "$PKI_DIR/README.txt" << EOF
Iotistic VPN Server PKI
=====================

Created: $(date)

Files:
------
ca.crt              - Certificate Authority certificate
private/ca.key      - Certificate Authority private key
issued/vpn-server.crt - Server certificate
private/vpn-server.key - Server private key
dh.pem              - Diffie-Hellman parameters
ta.key              - TLS authentication key
crl.pem             - Certificate Revocation List

Directories:
-----------
issued/             - Issued certificates
private/            - Private keys
client-configs/     - Generated client configurations
revoked/            - Revoked certificates

Usage:
------
To generate a client certificate:
  /etc/openvpn/scripts/generate-client.sh <device-id> <customer-id>

To revoke a certificate:
  /etc/openvpn/scripts/revoke-client.sh <device-id>

To view CRL:
  openssl crl -in crl.pem -text

Security:
---------
- Keep private/ directory secure (600 permissions)
- Backup ca.key in a secure location
- Regularly update CRL
- Monitor certificate expiration

EOF
    
    success "PKI summary created"
}

validate_pki() {
    log "Validating PKI setup..."
    
    cd "$PKI_DIR"
    
    # Check required files exist
    local required_files=(
        "ca.crt"
        "private/ca.key"
        "issued/vpn-server.crt"
        "private/vpn-server.key"
        "dh.pem"
        "ta.key"
        "crl.pem"
    )
    
    local missing_files=()
    for file in "${required_files[@]}"; do
        if [ ! -f "$file" ]; then
            missing_files+=("$file")
        fi
    done
    
    if [ ${#missing_files[@]} -ne 0 ]; then
        error "Missing required files:"
        for file in "${missing_files[@]}"; do
            echo "  - $file"
        done
        exit 1
    fi
    
    # Validate CA certificate
    if ! openssl x509 -in ca.crt -noout -text &>/dev/null; then
        error "Invalid CA certificate"
        exit 1
    fi
    
    # Validate server certificate
    if ! openssl x509 -in issued/vpn-server.crt -noout -text &>/dev/null; then
        error "Invalid server certificate"
        exit 1
    fi
    
    # Check certificate chain
    if ! openssl verify -CAfile ca.crt issued/vpn-server.crt &>/dev/null; then
        error "Server certificate not signed by CA"
        exit 1
    fi
    
    success "PKI validation passed"
}

print_completion() {
    echo -e "${GREEN}"
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║                PKI Initialization Complete!              ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    
    echo "PKI Directory: $PKI_DIR"
    echo ""
    echo "Certificate Authority:"
    openssl x509 -in "$PKI_DIR/ca.crt" -noout -subject -dates
    echo ""
    echo "Server Certificate:"
    openssl x509 -in "$PKI_DIR/issued/vpn-server.crt" -noout -subject -dates
    echo ""
    echo -e "${GREEN}Next steps:${NC}"
    echo "1. Start the VPN server: docker-compose up -d"
    echo "2. Generate client certificates: ./scripts/generate-client.sh <device-id> <customer-id>"
    echo "3. Configure firewall rules for port 1194/udp"
    echo ""
    echo -e "${YELLOW}Security reminder:${NC}"
    echo "- Backup the CA private key ($PKI_DIR/private/ca.key) securely"
    echo "- Restrict access to the PKI directory"
    echo "- Monitor certificate expiration dates"
}

# Main execution
main() {
    print_banner
    check_requirements
    
    # Check if PKI already exists
    if [ -f "$PKI_DIR/ca.crt" ]; then
        warn "PKI already exists at $PKI_DIR"
        read -p "Do you want to reinitialize? This will DELETE all existing certificates! (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Initialization cancelled"
            exit 0
        fi
        
        log "Removing existing PKI..."
        rm -rf "$PKI_DIR"
    fi
    
    setup_pki_directory
    initialize_pki
    create_ca
    create_server_cert
    create_dh_params
    create_tls_auth
    create_crl
    set_permissions
    create_summary
    validate_pki
    print_completion
}

# Run main function
main "$@"