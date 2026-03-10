import json
import logging
import os
import ssl
import urllib.request

logger = logging.getLogger(__name__)


def load_mqtt_profiles() -> dict:
    api_url = os.environ["API_URL"]
    api_key = os.environ["API_KEY"]

    ssl_context = ssl.create_default_context()
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE

    url = f"{api_url}/api/v1/profiles/sim/datapoints?protocol=mqtt"
    headers = {
        "User-Agent": "mqtt-simulator/1.0",
        "Authorization": f"Bearer {api_key}",
    }

    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=10, context=ssl_context) as response:
        payload = json.loads(response.read().decode("utf-8"))

    if not isinstance(payload, dict):
        raise ValueError("Invalid profile response format: expected object")

    logger.info("Loaded %d MQTT profiles from API", len(payload))
    return payload
