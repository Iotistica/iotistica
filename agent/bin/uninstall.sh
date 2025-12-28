#!/bin/bash
#
# Iotistic Agent Uninstaller
# Removes the Iotistic agent from the system
#
# Usage:
#   sudo ./uninstall.sh                  # Complete removal
#   sudo ./uninstall.sh --keep-config    # Keep configuration files
#   sudo ./uninstall.sh --keep-data      # Keep data and configuration

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Parse command line arguments
KEEP_CONFIG=false
KEEP_DATA=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --keep-config)
            KEEP_CONFIG=true
            shift
            ;;
        --keep-data)
            KEEP_DATA=true
            KEEP_CONFIG=true  # If keeping data, also keep config
            shift
            ;;
        --help|-h)
            echo "Iotistic Agent Uninstaller"
            echo ""
            echo "Usage:"
            echo "  sudo ./uninstall.sh                  # Complete removal"
            echo "  sudo ./uninstall.sh --keep-config    # Keep configuration files"
            echo "  sudo ./uninstall.sh --keep-data      # Keep data and configuration"
            echo ""
            echo "Directories:"
            echo "  /opt/iotistic              - Installation directory"
            echo "  /etc/iotistic              - Configuration files"
            echo "  /var/lib/iotistic          - Data directory (database, state)"
            echo "  /var/log/iotistic          - Log files"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Error: This script must be run as root${NC}"
    echo "Please run: sudo $0"
    exit 1
fi

echo -e "${YELLOW}Iotistic Agent Uninstaller${NC}"
echo ""

# Check if agent is installed
if [ ! -f /etc/systemd/system/iotistic-agent.service ]; then
    echo -e "${YELLOW}Warning: Iotistic agent systemd service not found${NC}"
    echo "The agent may not be installed or was installed differently."
    read -p "Continue with cleanup anyway? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 0
    fi
fi

# Stop the service
echo -n "Stopping iotistic-agent service... "
if systemctl is-active --quiet iotistic-agent; then
    systemctl stop iotistic-agent
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${YELLOW}(not running)${NC}"
fi

# Disable the service
echo -n "Disabling iotistic-agent service... "
if systemctl is-enabled --quiet iotistic-agent 2>/dev/null; then
    systemctl disable iotistic-agent
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${YELLOW}(not enabled)${NC}"
fi

# Remove systemd service file
echo -n "Removing systemd service file... "
if [ -f /etc/systemd/system/iotistic-agent.service ]; then
    rm /etc/systemd/system/iotistic-agent.service
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${YELLOW}(not found)${NC}"
fi

# Reload systemd
echo -n "Reloading systemd daemon... "
systemctl daemon-reload
systemctl reset-failed 2>/dev/null || true
echo -e "${GREEN}✓${NC}"

# Remove installation directory
echo -n "Removing installation directory (/opt/iotistic)... "
if [ -d /opt/iotistic ]; then
    rm -rf /opt/iotistic
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${YELLOW}(not found)${NC}"
fi

# Remove configuration directory
if [ "$KEEP_CONFIG" = false ]; then
    echo -n "Removing configuration directory (/etc/iotistic)... "
    if [ -d /etc/iotistic ]; then
        rm -rf /etc/iotistic
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${YELLOW}(not found)${NC}"
    fi
else
    echo -e "${YELLOW}Keeping configuration directory (/etc/iotistic)${NC}"
fi

# Remove data directory
if [ "$KEEP_DATA" = false ]; then
    echo -n "Removing data directory (/var/lib/iotistic)... "
    if [ -d /var/lib/iotistic ]; then
        rm -rf /var/lib/iotistic
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${YELLOW}(not found)${NC}"
    fi
else
    echo -e "${YELLOW}Keeping data directory (/var/lib/iotistic)${NC}"
fi

# Remove log directory
if [ "$KEEP_DATA" = false ]; then
    echo -n "Removing log directory (/var/log/iotistic)... "
    if [ -d /var/log/iotistic ]; then
        rm -rf /var/log/iotistic
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${YELLOW}(not found)${NC}"
    fi
else
    echo -e "${YELLOW}Keeping log directory (/var/log/iotistic)${NC}"
fi

# Verify removal
echo ""
echo -n "Verifying removal... "
if ! systemctl status iotistic-agent >/dev/null 2>&1 && \
   [ ! -f /etc/systemd/system/iotistic-agent.service ] && \
   [ ! -d /opt/iotistic ]; then
    echo -e "${GREEN}✓${NC}"
    echo ""
    echo -e "${GREEN}Iotistic agent has been successfully uninstalled${NC}"
    
    if [ "$KEEP_CONFIG" = true ] || [ "$KEEP_DATA" = true ]; then
        echo ""
        echo "Preserved directories:"
        [ "$KEEP_CONFIG" = true ] && [ -d /etc/iotistic ] && echo "  • /etc/iotistic (configuration)"
        [ "$KEEP_DATA" = true ] && [ -d /var/lib/iotistic ] && echo "  • /var/lib/iotistic (data)"
        [ "$KEEP_DATA" = true ] && [ -d /var/log/iotistic ] && echo "  • /var/log/iotistic (logs)"
    fi
else
    echo -e "${YELLOW}Warning: Some components may still exist${NC}"
    echo "Run 'systemctl status iotistic-agent' for details"
fi

echo ""
