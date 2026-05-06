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

SYSTEMD_SERVICE:${PN} = "iotistica-agent.service"
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
        cat > ${D}${systemd_system_unitdir}/iotistica-agent.service << 'SERVICE'
[Unit]
Description=Iotistic Device Agent
After=network-online.target docker.service
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=iotistic
Group=iotistic
WorkingDirectory=/opt/iotistic/agent
EnvironmentFile=/etc/iotistic/agent.env
ExecStart=/usr/local/bin/iotistica-agent-start.sh
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=iotistica-agent

[Install]
WantedBy=multi-user.target
SERVICE

        # Install startup wrapper that matches install.sh runtime behavior
        install -d ${D}/usr/local/bin
        cat > ${D}/usr/local/bin/iotistica-agent-start.sh << 'STARTSCRIPT'
#!/bin/sh
set -e

NODE_PATH="$(command -v node)"
if [ -z "$NODE_PATH" ]; then
    echo "node binary not found"
    exit 1
fi

if [ -f /opt/iotistic/agent/dist/app.js ]; then
    APP_JS_PATH="/opt/iotistic/agent/dist/app.js"
elif [ -f /opt/iotistic/agent/dist/src/app.js ]; then
    APP_JS_PATH="/opt/iotistic/agent/dist/src/app.js"
elif [ -f /opt/iotistic/agent/dist/index.js ]; then
    APP_JS_PATH="/opt/iotistic/agent/dist/index.js"
else
    echo "No known agent entrypoint found in /opt/iotistic/agent/dist"
    exit 1
fi

exec "$NODE_PATH" "$APP_JS_PATH"
STARTSCRIPT
        chmod 0755 ${D}/usr/local/bin/iotistica-agent-start.sh
    
    # Create directories
    install -d ${D}/var/lib/iotistic/agent
    install -d ${D}/var/log/iotistic
    install -d ${D}/etc/iotistic
    
    # Create default environment file
    cat > ${D}/etc/iotistic/agent.env << 'ENVFILE'
# Iotistic Agent Configuration
NODE_ENV=production
LOG_LEVEL=info
DEVICE_API_PORT=48484
ORCHESTRATOR_TYPE=docker-compose
ORCHESTRATOR_INTERVAL=30000
POLL_INTERVAL_MS=30000
REPORT_INTERVAL_MS=60000
DATA_DIR=/var/lib/iotistic/agent

# Installer-aligned default data paths
DATABASE_PATH=/var/lib/iotistic/agent/agent.sqlite
STATE_FILE=/var/lib/iotistic/agent/target-state.json
LOG_DIR=/var/log/iotistic
IOTISTICA_API=https://api.iotistica.com

# Provisioning: Multiple methods supported (priority order)
# 1. PROVISIONING_KEY environment variable (highest priority - for manual override)
# 2. Boot config file at BOOT_CONFIG_PATH (for Yocto manufacturing)
#    - Simple: /boot/provisioning-key.txt → auto-converted to JSON
#    - Full: /boot/iotistic-config.json with provisioningKey field
# Leave PROVISIONING_KEY empty to use boot config
BOOT_CONFIG_PATH=/data/iotistic/boot-config.json
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
FILES:${PN} += "/usr/local/bin/iotistica-agent-start.sh"
FILES:${PN} += "${systemd_system_unitdir}/iotistica-agent.service"
EOF

echo "✓ Agent recipe created"
