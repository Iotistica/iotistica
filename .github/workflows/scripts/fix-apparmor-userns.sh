#!/bin/bash
set -e

echo "=== Checking AppArmor user namespace restrictions ==="

# Check current setting
current_value=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo "0")
echo "Current value: $current_value"

if [ "$current_value" = "1" ]; then
    echo "⚠️  AppArmor is restricting unprivileged user namespaces"
    echo "This will prevent BitBake from running properly"
    echo ""
    echo "Fixing: Setting kernel.apparmor_restrict_unprivileged_userns=0"
    
    # Temporarily set for current session
    sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
    
    # Make permanent if not already configured
    if ! grep -q "kernel.apparmor_restrict_unprivileged_userns" /etc/sysctl.d/99-iotistic-runner.conf 2>/dev/null; then
        echo "Making permanent in /etc/sysctl.d/99-iotistic-runner.conf"
        echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee -a /etc/sysctl.d/99-iotistic-runner.conf
    fi
    
    echo "✓ AppArmor user namespace restriction disabled"
else
    echo "✓ AppArmor user namespace restriction already disabled"
fi

# Verify the fix
new_value=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns)
echo "New value: $new_value"

if [ "$new_value" = "0" ]; then
    echo "✓ BitBake can now use user namespaces"
else
    echo "❌ Failed to disable AppArmor restriction"
    exit 1
fi
