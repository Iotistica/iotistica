"""
Shared profile data loader for Modbus simulator
Centralizes API calls for both simulator.py and web_gui.py
"""
import json
import urllib.request
import ssl
import time
import os
import logging

logger = logging.getLogger(__name__)

def load_profile_data():
    """Load profile data points from API (shared by simulator and GUI)"""
    API_URL = os.environ.get("API_URL", "http://api:3002")
    API_KEY = os.environ.get("API_KEY")  # Required: from api_keys table
    VERIFY_SSL = os.environ.get("VERIFY_SSL", "false").lower() == "true"
    
    if not API_KEY:
        logger.error("API_KEY environment variable is required but not set")
        return {}
    
    # Create SSL context for HTTPS (disable verification for self-signed certs)
    ssl_context = ssl.create_default_context()
    if not VERIFY_SSL:
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
    
    # Try API with retries
    max_retries = 3
    retry_delay = 2
    
    for attempt in range(max_retries):
        try:
            # Use simulator endpoint
            url = f"{API_URL}/api/v1/profiles/sim/datapoints?protocol=modbus"
            headers = {
                'User-Agent': 'modbus-simulator/1.0',
                'Authorization': f'Bearer {API_KEY}'
            }
            
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=5, context=ssl_context) as response:
                profile_data = json.loads(response.read().decode())
                logger.info(f"✓ Loaded profile data from API ({len(profile_data)} profiles)")
                return profile_data
        except Exception as e:
            if attempt < max_retries - 1:
                logger.warning(f"API attempt {attempt + 1} failed: {e}, retrying in {retry_delay}s...")
                time.sleep(retry_delay)
            else:
                logger.error(f"Failed to load from API after {max_retries} attempts: {e}")
    
    # No fallback - API is required
    logger.error("Profile data could not be loaded from API. Starting with empty profiles.")
    return {}
