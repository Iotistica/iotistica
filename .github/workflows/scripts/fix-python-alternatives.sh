#!/bin/bash
set -e

echo "Ensuring system Python is properly configured..."

# Test if apt_pkg module works (more reliable than just python3 --version)
if ! python3 -c "import apt_pkg" 2>/dev/null; then
  echo "Python apt_pkg module not working, restoring system Python..."
  
  # Find the original system Python (typically 3.12 on Noble)
  SYSTEM_PYTHON=$(ls /usr/bin/python3.* | grep -E 'python3\.[0-9]+$' | grep -v python3.8 | sort -V | tail -n1)
  
  if [ -n "$SYSTEM_PYTHON" ]; then
    echo "Found system Python: $SYSTEM_PYTHON"
    VERSION=$($SYSTEM_PYTHON --version)
    echo "Version: $VERSION"
    
    # Remove all python3 alternatives
    sudo update-alternatives --remove-all python3 2>/dev/null || true
    
    # Set system Python as default with high priority
    sudo update-alternatives --install /usr/bin/python3 python3 $SYSTEM_PYTHON 100
    sudo update-alternatives --set python3 $SYSTEM_PYTHON
    
    # Verify fix
    python3 --version
    python3 -c "import apt_pkg" && echo "✓ Python3 and apt_pkg fixed" || echo "⚠ apt_pkg still broken"
  else
    echo "❌ Could not find system Python"
    exit 1
  fi
else
  echo "✓ Python3 and apt_pkg are working correctly"
  python3 --version
fi
