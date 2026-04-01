#!/bin/bash -e

# Setup SSH Reverse Tunnel for Remote Device Access
# This script helps configure SSH keys and cloud server for remote access

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SSH_DIR="${PROJECT_ROOT}/data/ssh"
SSH_KEY_PATH="${SSH_DIR}/id_rsa"

CLOUD_HOST="${1:-}"
CLOUD_USER="${2:-tunnel}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

function print_banner() {
    echo -e "${BLUE}"
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║     SSH Reverse Tunnel Setup for Remote Device Access    ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

function print_error() {
    echo -e "${RED}❌ ERROR: $1${NC}" >&2
}

function print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

function print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

function print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

function check_requirements() {
    print_info "Checking requirements..."
    
    if ! command -v ssh-keygen &> /dev/null; then
        print_error "ssh-keygen not found. Please install openssh-client"
        exit 1
    fi
    
    if ! command -v ssh-copy-id &> /dev/null; then
        print_error "ssh-copy-id not found. Please install openssh-client"
        exit 1
    fi
    
    print_success "All requirements met"
}

function generate_ssh_key() {
    print_info "Generating SSH key pair..."
    
    # Create SSH directory if it doesn't exist
    mkdir -p "$SSH_DIR"
    
    # Check if key already exists
    if [ -f "$SSH_KEY_PATH" ]; then
        print_warning "SSH key already exists at: $SSH_KEY_PATH"
        read -p "Do you want to overwrite it? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            print_info "Using existing SSH key"
            return
        fi
        rm -f "$SSH_KEY_PATH" "${SSH_KEY_PATH}.pub"
    fi
    
    # Generate ED25519 key (more secure and faster than RSA)
    ssh-keygen -t ed25519 \
        -f "$SSH_KEY_PATH" \
        -N "" \
        -C "Iotistic-device-$(hostname)" \
        -q
    
    # Set correct permissions
    chmod 600 "$SSH_KEY_PATH"
    chmod 644 "${SSH_KEY_PATH}.pub"
    
    print_success "SSH key generated: $SSH_KEY_PATH"
    print_info "Public key:"
    cat "${SSH_KEY_PATH}.pub"
}

function configure_cloud_server() {
    local cloud_host="$1"
    local cloud_user="$2"
    
    print_info "Configuring cloud server: $cloud_host"
    
    # Test SSH connection
    print_info "Testing SSH connection to $cloud_user@$cloud_host..."
    if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$cloud_user@$cloud_host" exit 2>/dev/null; then
        print_warning "Cannot connect via SSH key authentication"
        print_info "You may need to enter password to copy the key"
    fi
    
    # Copy SSH key to cloud server
    print_info "Copying SSH public key to cloud server..."
    if ssh-copy-id -i "${SSH_KEY_PATH}.pub" "$cloud_user@$cloud_host"; then
        print_success "SSH key copied to cloud server"
    else
        print_error "Failed to copy SSH key to cloud server"
        print_info "Manual steps:"
        print_info "1. Copy the public key above"
        print_info "2. SSH to your cloud server: ssh $cloud_user@$cloud_host"
        print_info "3. Add to authorized_keys: echo '<PUBLIC_KEY>' >> ~/.ssh/authorized_keys"
        return 1
    fi
    
    # Test connection with the new key
    print_info "Testing SSH key authentication..."
    if ssh -o BatchMode=yes -i "$SSH_KEY_PATH" "$cloud_user@$cloud_host" exit 2>/dev/null; then
        print_success "SSH key authentication working!"
    else
        print_error "SSH key authentication not working"
        return 1
    fi
    
    print_success "Cloud server configured successfully"
}

function configure_cloud_sshd() {
    local cloud_host="$1"
    local cloud_user="$2"
    
    print_warning "Cloud server SSH configuration"
    print_info "The cloud server needs these settings in /etc/ssh/sshd_config:"
    echo ""
    echo "# Allow reverse tunneling"
    echo "GatewayPorts yes"
    echo ""
    echo "# Keep connections alive"
    echo "ClientAliveInterval 60"
    echo "ClientAliveCountMax 3"
    echo ""
    
    read -p "Do you want to apply these settings automatically? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        print_info "Applying SSH server configuration..."
        
        # This requires root/sudo access on cloud server
        ssh "$cloud_user@$cloud_host" "sudo bash -s" <<'EOF'
# Backup existing config
sudo cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup

# Add or update settings
if ! grep -q "^GatewayPorts yes" /etc/ssh/sshd_config; then
    echo "GatewayPorts yes" | sudo tee -a /etc/ssh/sshd_config
fi

if ! grep -q "^ClientAliveInterval 60" /etc/ssh/sshd_config; then
    echo "ClientAliveInterval 60" | sudo tee -a /etc/ssh/sshd_config
fi

if ! grep -q "^ClientAliveCountMax 3" /etc/ssh/sshd_config; then
    echo "ClientAliveCountMax 3" | sudo tee -a /etc/ssh/sshd_config
fi

# Test config
if sudo sshd -t; then
    echo "✅ SSH config valid"
    sudo systemctl restart sshd
    echo "✅ SSH server restarted"
else
    echo "❌ Invalid SSH config, restoring backup"
    sudo cp /etc/ssh/sshd_config.backup /etc/ssh/sshd_config
    exit 1
fi
EOF
        
        if [ $? -eq 0 ]; then
            print_success "Cloud SSH server configured"
        else
            print_error "Failed to configure cloud SSH server"
            print_info "Please configure manually or contact your system administrator"
        fi
    else
        print_info "Skipping automatic configuration"
        print_warning "Please configure the cloud server manually"
    fi
}

function update_env_file() {
    local cloud_host="$1"
    local cloud_user="$2"
    local env_file="${PROJECT_ROOT}/.env"
    
    print_info "Updating .env file..."
    
    # Create .env if it doesn't exist
    if [ ! -f "$env_file" ]; then
        touch "$env_file"
    fi
    
    # Remove old remote access settings
    sed -i.bak '/^ENABLE_REMOTE_ACCESS=/d' "$env_file"
    sed -i.bak '/^CLOUD_HOST=/d' "$env_file"
    sed -i.bak '/^SSH_TUNNEL_USER=/d' "$env_file"
    sed -i.bak '/^SSH_KEY_PATH=/d' "$env_file"
    
    # Add new settings
    cat >> "$env_file" <<EOF

# SSH Reverse Tunnel Configuration
ENABLE_REMOTE_ACCESS=true
CLOUD_HOST=$cloud_host
CLOUD_SSH_PORT=22
SSH_TUNNEL_USER=$cloud_user
SSH_KEY_PATH=/app/data/ssh/id_rsa
SSH_AUTO_RECONNECT=true
SSH_RECONNECT_DELAY=5000
EOF
    
    # Clean up backup
    rm -f "${env_file}.bak"
    
    print_success ".env file updated"
}

function test_tunnel() {
    local cloud_host="$1"
    local cloud_user="$2"
    
    print_info "Testing SSH reverse tunnel..."
    
    # Try to establish a test tunnel
    print_info "Establishing test tunnel (will disconnect after 5 seconds)..."
    
    ssh -R 48484:localhost:48484 \
        -i "$SSH_KEY_PATH" \
        -o StrictHostKeyChecking=no \
        -o ServerAliveInterval=60 \
        -N \
        "$cloud_user@$cloud_host" &
    
    local ssh_pid=$!
    
    sleep 5
    
    if ps -p $ssh_pid > /dev/null; then
        print_success "SSH tunnel established successfully!"
        kill $ssh_pid 2>/dev/null || true
    else
        print_error "SSH tunnel failed to establish"
        return 1
    fi
}

function print_usage_instructions() {
    print_success "Setup complete!"
    echo ""
    print_info "Next steps:"
    echo "  1. Restart the device agent container:"
    echo "     docker-compose restart agent"
    echo ""
    echo "  2. Check tunnel status in logs:"
    echo "     docker-compose logs -f agent | grep tunnel"
    echo ""
    echo "  3. From cloud server, access device API:"
    echo "     curl http://localhost:48484/v2/device"
    echo ""
    print_info "Environment variables set in .env:"
    echo "  ENABLE_REMOTE_ACCESS=true"
    echo "  CLOUD_HOST=$CLOUD_HOST"
    echo "  SSH_TUNNEL_USER=$CLOUD_USER"
    echo ""
    print_warning "Security note:"
    echo "  - SSH key stored in: $SSH_KEY_PATH"
    echo "  - Keep this key secure!"
    echo "  - Never commit to version control"
}

function main() {
    print_banner
    
    # Check for cloud host argument
    if [ -z "$CLOUD_HOST" ]; then
        print_error "Cloud host not provided"
        echo ""
        echo "Usage: $0 <cloud_host> [ssh_user]"
        echo ""
        echo "Example:"
        echo "  $0 cloud.example.com tunnel"
        echo ""
        exit 1
    fi
    
    print_info "Cloud Host: $CLOUD_HOST"
    print_info "SSH User: $CLOUD_USER"
    echo ""
    
    # Run setup steps
    check_requirements
    generate_ssh_key
    configure_cloud_server "$CLOUD_HOST" "$CLOUD_USER"
    configure_cloud_sshd "$CLOUD_HOST" "$CLOUD_USER"
    update_env_file "$CLOUD_HOST" "$CLOUD_USER"
    test_tunnel "$CLOUD_HOST" "$CLOUD_USER"
    print_usage_instructions
}

# Run main function
main
