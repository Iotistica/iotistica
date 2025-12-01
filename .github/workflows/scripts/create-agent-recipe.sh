#!/bin/bash
set -e

BUILD_DIR="$1"
AGENT_VERSION="$2"

LAYER_DIR="$BUILD_DIR/meta-iotistic"

echo "Creating iotistic-agent recipe..."

# Create recipe directory structure
mkdir -p "$LAYER_DIR/recipes-iotistic/agent/files/agent-src"

# Copy agent files into the files/agent-src subdirectory
cp -r agent/* "$LAYER_DIR/recipes-iotistic/agent/files/agent-src/"

# Create BitBake recipe
cat > "$LAYER_DIR/recipes-iotistic/agent/iotistic-agent_${AGENT_VERSION}.bb" << 'EOF'
SUMMARY = "Iotistic IoT Device Agent"
DESCRIPTION = "Container orchestrator and cloud sync agent for Iotistic IoT platform"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

DEPENDS = "nodejs-native"
RDEPENDS:${PN} = "nodejs nodejs-npm sqlite3 bash"

SRC_URI = "file://agent-src"
S = "${WORKDIR}/agent-src"

inherit systemd

SYSTEMD_SERVICE:${PN} = "iotistic-agent.service"
SYSTEMD_AUTO_ENABLE = "enable"

do_install() {
    # Install agent to /opt/iotistic/agent
    install -d ${D}/opt/iotistic/agent
    
    # Copy only production files (not dev/test files)
    # Compiled code
    cp -r ${S}/dist ${D}/opt/iotistic/agent/
    
    # Package metadata
    install -m 0644 ${S}/package.json ${D}/opt/iotistic/agent/
    install -m 0644 ${S}/package-lock.json ${D}/opt/iotistic/agent/
    
    # CLI tools (if agent has CLI)
    if [ -d ${S}/bin ]; then
        cp -r ${S}/bin ${D}/opt/iotistic/agent/
    fi
    if [ -d ${S}/cli ]; then
        cp -r ${S}/cli ${D}/opt/iotistic/agent/
    fi
    
    # Production dependencies will be installed during do_compile
    # No need to copy node_modules
    
    # Install systemd service
    install -d ${D}${systemd_system_unitdir}
    cat > ${D}${systemd_system_unitdir}/iotistic-agent.service << 'SERVICE'
[Unit]
Description=Iotistic Device Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
User=iotistic
Group=iotistic
WorkingDirectory=/opt/iotistic/agent
EnvironmentFile=/etc/iotistic/agent.env
ExecStart=/usr/bin/pm2 start /opt/iotistic/agent/dist/index.js --name iotistic-agent --update-env
ExecStop=/usr/bin/pm2 stop iotistic-agent
ExecReload=/usr/bin/pm2 reload iotistic-agent
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=iotistic-agent

[Install]
WantedBy=multi-user.target
SERVICE
    
    # Create directories
    install -d ${D}/var/lib/iotistic/agent
    install -d ${D}/var/log/iotistic
    install -d ${D}/etc/iotistic
    
    # Create default environment file
    cat > ${D}/etc/iotistic/agent.env << 'ENVFILE'
# Iotistic Agent Configuration
NODE_ENV=production
LOG_LEVEL=info
CLOUD_API_ENDPOINT=https://api.iotistic.ca
IOTISTIC_DEVICE_PORT=48484
ORCHESTRATOR_INTERVAL=30000
POLL_INTERVAL_MS=30000
REPORT_INTERVAL_MS=60000

# Read-only rootfs: Use /data partition for writable data
DATABASE_PATH=/data/iotistic/device.sqlite
LOG_DIR=/data/logs
STATE_FILE=/data/iotistic/target-state.json

# Provisioning config (optional - can be overridden by /boot/iotistic-config.json)
# PROVISIONING_API_KEY=  # Leave empty - will be read from boot config or runtime provisioning
# BOOT_CONFIG_PATH=/data/iotistic/boot-config.json  # Auto-copied from /boot if exists
ENVFILE
}

do_compile() {
    # Build agent
    cd ${S}
    npm ci --production
    npm run build
}

pkg_postinst:${PN}() {
    #!/bin/sh -e
    if [ -z "$D" ]; then
        # Create iotistic user/group
        if ! getent group iotistic >/dev/null; then
            groupadd -r iotistic
        fi
        if ! getent passwd iotistic >/dev/null; then
            useradd -r -g iotistic -d /opt/iotistic/agent -s /sbin/nologin -c "Iotistic Agent" iotistic
        fi
        
        # Add iotistic user to docker group (so agent can manage containers)
        if getent group docker >/dev/null; then
            usermod -aG docker iotistic
            echo "✓ Added iotistic user to docker group"
        else
            echo "⚠ WARNING: docker group not found - agent won't be able to manage containers"
        fi
        
        # Install PM2 globally (process manager for agent)
        if command -v npm >/dev/null 2>&1; then
            npm install -g pm2
            echo "✓ PM2 installed globally"
        else
            echo "⚠ WARNING: npm not found - PM2 not installed"
        fi
        
        # NOTE: /var/lib/iotistic and /var/log/iotistic are created as symlinks
        # by iotistic-init-data.service on first boot (see resin-init recipe)
        # This ensures writable data on read-only root filesystem
        
        # Set permissions on agent code (read-only location is fine)
        chown -R iotistic:iotistic /opt/iotistic/agent
        chmod 600 /etc/iotistic/agent.env
    fi
}

FILES:${PN} += "/opt/iotistic/agent/*"
FILES:${PN} += "/var/lib/iotistic/*"
FILES:${PN} += "/var/log/iotistic/*"
FILES:${PN} += "/etc/iotistic/*"
FILES:${PN} += "${systemd_system_unitdir}/iotistic-agent.service"
EOF

echo "✓ Agent recipe created"
