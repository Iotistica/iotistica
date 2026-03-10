#!/usr/bin/env python3
import json
import logging
import math
import os
import random
import signal
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

import paho.mqtt.client as mqtt

from profile_loader import load_mqtt_profiles


LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("mqtt-simulator")


class DataPointPublisher:
    def __init__(self, datapoint: dict):
        self.name = datapoint["name"]
        self.topic = datapoint["topic"]
        self.qos = int(datapoint.get("qos", 0))
        self.retain = bool(datapoint.get("retain", False))
        self.data_type = datapoint.get("dataType", "float")
        self.unit = datapoint.get("unit", "")
        self.base = float(datapoint.get("base", 50.0))
        self.noise_pct = float(datapoint.get("noise_pct", 0.02))
        self.min_value = datapoint.get("min")
        self.max_value = datapoint.get("max")
        self.period_s = float(datapoint.get("period_s", 30.0))

        if not self.name or not self.topic:
            raise ValueError("Each MQTT datapoint requires name and topic")

        if self.qos not in (0, 1, 2):
            raise ValueError(f"Invalid qos for {self.name}: {self.qos}")

    def next_value(self, t: float):
        swing = self.base * self.noise_pct
        value = self.base + math.sin((2 * math.pi * t) / self.period_s) * swing
        value += random.uniform(-swing, swing)

        if self.min_value is not None:
            value = max(float(self.min_value), value)
        if self.max_value is not None:
            value = min(float(self.max_value), value)

        if self.data_type in ("int", "uint16", "uint32"):
            return int(round(value))
        return round(value, 4)

    def build_payload(self, value):
        return {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "name": self.name,
            "value": value,
            "unit": self.unit,
        }


class MqttSimulator:
    def __init__(self):
        self.profile_name = os.environ["PROFILE"]
        self.broker_url = os.environ["MQTT_BROKER_URL"]
        self.username = os.environ.get("MQTT_USERNAME") or os.environ.get("MQTT_AUTH_USERNAME")
        self.password = os.environ.get("MQTT_PASSWORD") or os.environ.get("MQTT_AUTH_PASSWORD")
        self.client_id = os.environ.get("MQTT_CLIENT_ID", "iotistic-mqtt-simulator")
        self.publish_interval_ms = int(os.environ.get("PUBLISH_INTERVAL_MS", "1000"))

        if not self.username or not self.password:
            raise ValueError("MQTT auth is required: set MQTT_USERNAME and MQTT_PASSWORD")

        if self.publish_interval_ms < 100:
            raise ValueError("PUBLISH_INTERVAL_MS must be >= 100")

        parsed = urlparse(self.broker_url)
        if parsed.scheme not in ("mqtt", "tcp"):
            raise ValueError("MQTT_BROKER_URL must use mqtt:// or tcp://")
        if not parsed.hostname or not parsed.port:
            raise ValueError("MQTT_BROKER_URL must include host and port")

        self.host = parsed.hostname
        self.port = parsed.port

        profiles = load_mqtt_profiles()
        if self.profile_name not in profiles:
            available = ", ".join(profiles.keys())
            raise ValueError(f"Profile '{self.profile_name}' not found. Available: {available}")

        profile = profiles[self.profile_name]
        datapoints = profile.get("dataPoints", [])
        if not isinstance(datapoints, list) or len(datapoints) == 0:
            raise ValueError(f"Profile '{self.profile_name}' has no dataPoints")

        self.publishers = [DataPointPublisher(dp) for dp in datapoints]

        self.client = mqtt.Client(client_id=self.client_id)
        self.client.username_pw_set(self.username, self.password)
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect

        self.running = True

    def _on_connect(self, client, userdata, flags, rc):
        if rc != 0:
            logger.error("MQTT connect failed with code %s", rc)
        else:
            logger.info("Connected to MQTT broker %s:%s", self.host, self.port)

    def _on_disconnect(self, client, userdata, rc):
        logger.warning("Disconnected from MQTT broker rc=%s", rc)

    def stop(self, *_):
        self.running = False

    def run(self):
        logger.info("Starting MQTT simulator profile=%s datapoints=%d", self.profile_name, len(self.publishers))
        self.client.connect(self.host, self.port, keepalive=60)
        self.client.loop_start()

        try:
            while self.running:
                now = time.time()
                for pub in self.publishers:
                    value = pub.next_value(now)
                    payload = pub.build_payload(value)
                    msg = json.dumps(payload, separators=(",", ":"))
                    info = self.client.publish(pub.topic, msg, qos=pub.qos, retain=pub.retain)
                    if info.rc != mqtt.MQTT_ERR_SUCCESS:
                        logger.error("Publish failed topic=%s rc=%s", pub.topic, info.rc)
                time.sleep(self.publish_interval_ms / 1000.0)
        finally:
            self.client.loop_stop()
            self.client.disconnect()
            logger.info("MQTT simulator stopped")


def main():
    sim = MqttSimulator()

    signal.signal(signal.SIGINT, sim.stop)
    signal.signal(signal.SIGTERM, sim.stop)

    sim.run()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        logger.exception("Fatal startup/runtime error: %s", exc)
        sys.exit(1)
