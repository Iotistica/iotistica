#!/bin/bash
# Test script for provisioning skip feature

echo "🧪 Provisioning Skip Feature Test"
echo "=================================="
echo ""

# Test database path
DB_PATH="../agent/data/database.sqlite"

# Function to check provisioning status
check_provisioning_status() {
    echo "📋 Checking provisioning status..."
    
    if [ ! -f "$DB_PATH" ]; then
        echo "❌ Database not found at: $DB_PATH"
        echo "   This is expected for a fresh installation"
        return 1
    fi
    
    if ! command -v sqlite3 &> /dev/null; then
        echo "❌ sqlite3 not installed"
        echo "   Install with: sudo apt install sqlite3"
        return 1
    fi
    
    # Check if device table exists
    local TABLE_EXISTS=$(sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name='device';" 2>/dev/null)
    if [ -z "$TABLE_EXISTS" ]; then
        echo "❌ Device table not found in database"
        return 1
    fi
    
    # Get provisioning status
    local PROVISIONED=$(sqlite3 "$DB_PATH" "SELECT provisioned FROM device LIMIT 1;" 2>/dev/null || echo "0")
    local UUID=$(sqlite3 "$DB_PATH" "SELECT uuid FROM device LIMIT 1;" 2>/dev/null || echo "unknown")
    local NAME=$(sqlite3 "$DB_PATH" "SELECT deviceName FROM device LIMIT 1;" 2>/dev/null || echo "unknown")
    local DEVICE_ID=$(sqlite3 "$DB_PATH" "SELECT deviceId FROM device LIMIT 1;" 2>/dev/null || echo "unknown")
    
    echo ""
    echo "Device Information:"
    echo "  UUID: $UUID"
    echo "  Name: $NAME"
    echo "  Device ID: $DEVICE_ID"
    echo "  Provisioned: $PROVISIONED"
    echo ""
    
    if [ "$PROVISIONED" = "1" ]; then
        echo "✅ Device IS provisioned"
        echo "   install.sh will SKIP provisioning prompts"
        return 0
    else
        echo "⚠️  Device is NOT provisioned"
        echo "   install.sh will PROMPT for provisioning credentials"
        return 1
    fi
}

# Function to simulate provisioning
simulate_provisioning() {
    echo ""
    echo "🔧 Simulating provisioning (for testing only)..."
    
    if [ ! -f "$DB_PATH" ]; then
        echo "❌ Cannot simulate - database doesn't exist"
        echo "   Run the agent first to create the database"
        return 1
    fi
    
    # Update provisioning status
    sqlite3 "$DB_PATH" "UPDATE device SET provisioned = 1, deviceName = 'test-device', deviceId = 'test-id-123' WHERE uuid IS NOT NULL;" 2>/dev/null
    
    if [ $? -eq 0 ]; then
        echo "✅ Provisioning status updated"
        check_provisioning_status
    else
        echo "❌ Failed to update provisioning status"
        return 1
    fi
}

# Function to reset provisioning
reset_provisioning() {
    echo ""
    echo "🔄 Resetting provisioning status..."
    
    if [ ! -f "$DB_PATH" ]; then
        echo "❌ Cannot reset - database doesn't exist"
        return 1
    fi
    
    sqlite3 "$DB_PATH" "UPDATE device SET provisioned = 0 WHERE uuid IS NOT NULL;" 2>/dev/null
    
    if [ $? -eq 0 ]; then
        echo "✅ Provisioning status reset"
        check_provisioning_status
    else
        echo "❌ Failed to reset provisioning status"
        return 1
    fi
}

# Main menu
echo "Select an option:"
echo "1) Check provisioning status"
echo "2) Simulate provisioning (set provisioned=1)"
echo "3) Reset provisioning (set provisioned=0)"
echo "4) View full device record"
echo ""
read -p "Enter choice [1-4]: " choice

case $choice in
    1)
        check_provisioning_status
        ;;
    2)
        simulate_provisioning
        ;;
    3)
        reset_provisioning
        ;;
    4)
        if [ -f "$DB_PATH" ]; then
            echo ""
            echo "Full device record:"
            echo "==================="
            sqlite3 "$DB_PATH" "SELECT * FROM device;" 2>/dev/null || echo "❌ Failed to read device record"
        else
            echo "❌ Database not found"
        fi
        ;;
    *)
        echo "Invalid choice"
        exit 1
        ;;
esac

echo ""
echo "🎯 Test complete!"
