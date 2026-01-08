"""
Shared profile data loader for Modbus simulator
Centralizes API calls for both simulator.py and web_gui.py
"""
import json
import urllib.request
import time
import os
import logging

logger = logging.getLogger(__name__)

def load_profile_data():
    """Load profile data points from API (shared by simulator and GUI)"""
    API_URL = os.environ.get("MODBUS_API_URL", "http://api:3002")
    API_TOKEN = os.environ.get("API_TOKEN", "")
    
    # Try API with retries
    max_retries = 3
    retry_delay = 2
    
    for attempt in range(max_retries):
        try:
            url = f"{API_URL}/api/v1/profiles/datapoints?protocol=modbus"
            headers = {'User-Agent': 'modbus-simulator/1.0'}
            if API_TOKEN:
                headers['Authorization'] = f'Bearer {API_TOKEN}'
            
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=5) as response:
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
