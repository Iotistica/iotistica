#!/usr/bin/env python3
import json
import logging
import math
import os
import random
import signal
import sys
import time
from collections import defaultdict
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
        self.device_id = os.environ.get("MQTT_DEVICE_ID", self.client_id)
        self.publish_interval_ms = int(os.environ.get("PUBLISH_INTERVAL_MS", "1000"))
        self.payload_mode = os.environ.get("MQTT_PAYLOAD_MODE", "multi").lower()
        self.timestamp_field = os.environ.get("MQTT_TIMESTAMP_FIELD", "ts")
        self.timestamp_format = os.environ.get("MQTT_TIMESTAMP_FORMAT", "epoch_ms").lower()
        self.log_publish_events = os.environ.get("LOG_PUBLISH_EVENTS", "true").lower() == "true"

        if not self.username or not self.password:
            raise ValueError("MQTT auth is required: set MQTT_USERNAME and MQTT_PASSWORD")

        if self.publish_interval_ms < 100:
            raise ValueError("PUBLISH_INTERVAL_MS must be >= 100")

        if self.payload_mode not in ("single", "multi"):
            raise ValueError("MQTT_PAYLOAD_MODE must be one of: single, multi")

        if self.timestamp_format not in ("epoch_ms", "iso"):
            raise ValueError("MQTT_TIMESTAMP_FORMAT must be one of: epoch_ms, iso")

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
        self.publishers_by_topic = defaultdict(list)
        for publisher in self.publishers:
            self.publishers_by_topic[publisher.topic].append(publisher)

        self.client = mqtt.Client(client_id=self.client_id)
        self.client.username_pw_set(self.username, self.password)
        self.client.will_set(f"device/{self.device_id}/status", payload="offline", qos=1, retain=True)
        self.client.enable_logger(logger)
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_publish = self._on_publish

        self.running = True
        self._publish_count = 0
        self._log_every = int(os.environ.get("LOG_PUBLISH_EVERY", "60"))
        self._pending_publish = {}

    def _on_connect(self, client, userdata, flags, rc):
        if rc != 0:
            logger.error("MQTT connect failed with code %s", rc)
        else:
            logger.info("Connected to MQTT broker %s:%s", self.host, self.port)
            client.publish(f"device/{self.device_id}/status", "online", qos=1, retain=True)
            logger.info("Published LWT online status topic=device/%s/status", self.device_id)

    def _on_disconnect(self, client, userdata, rc):
        logger.warning("Disconnected from MQTT broker rc=%s", rc)

    def _on_publish(self, client, userdata, mid):
        queued = self._pending_publish.pop(mid, None)
        if not queued:
            return

        topic, queued_at = queued
        if self.log_publish_events:
            elapsed_ms = int((time.time() - queued_at) * 1000)
            logger.info("Publish confirmed topic=%s mid=%s latency_ms=%s", topic, mid, elapsed_ms)

    def stop(self, *_):
        self.running = False

    def _build_multi_metric_payload(self, publishers, now: float):
        if self.timestamp_format == "iso":
            timestamp_value = datetime.now(timezone.utc).isoformat()
        else:
            timestamp_value = int(now * 1000)

        payload = {
            self.timestamp_field: timestamp_value,
        }

        for pub in publishers:
            payload[pub.name] = pub.next_value(now)

        return payload

    def _publish_single_mode(self, now: float):
        for pub in self.publishers:
            value = pub.next_value(now)
            payload = pub.build_payload(value)
            msg = json.dumps(payload, separators=(",", ":"))
            info = self.client.publish(pub.topic, msg, qos=pub.qos, retain=pub.retain)
            if info.rc != mqtt.MQTT_ERR_SUCCESS:
                logger.error("Publish failed topic=%s rc=%s", pub.topic, info.rc)
            else:
                self._pending_publish[info.mid] = (pub.topic, time.time())
                if self.log_publish_events:
                    logger.info("Publish queued topic=%s mid=%s qos=%s retain=%s", pub.topic, info.mid, pub.qos, pub.retain)

    def _publish_multi_mode(self, now: float):
        for topic, publishers in self.publishers_by_topic.items():
            payload = self._build_multi_metric_payload(publishers, now)
            msg = json.dumps(payload, separators=(",", ":"))

            qos = max(pub.qos for pub in publishers)
            retain = any(pub.retain for pub in publishers)
            info = self.client.publish(topic, msg, qos=qos, retain=retain)
            if info.rc != mqtt.MQTT_ERR_SUCCESS:
                logger.error("Publish failed topic=%s rc=%s", topic, info.rc)
            else:
                self._pending_publish[info.mid] = (topic, time.time())
                if self.log_publish_events:
                    metric_count = sum(1 for k in payload.keys() if k != self.timestamp_field)
                    logger.info(
                        "Publish queued topic=%s mid=%s qos=%s retain=%s metrics=%s",
                        topic,
                        info.mid,
                        qos,
                        retain,
                        metric_count,
                    )

    def run(self):
        logger.info(
            "Starting MQTT simulator profile=%s datapoints=%d mode=%s topics=%d",
            self.profile_name,
            len(self.publishers),
            self.payload_mode,
            len(self.publishers_by_topic),
        )
        self.client.connect(self.host, self.port, keepalive=60)
        self.client.loop_start()

        try:
            while self.running:
                now = time.time()
                if self.payload_mode == "single":
                    self._publish_single_mode(now)
                else:
                    self._publish_multi_mode(now)
                self._publish_count += 1
                if self._log_every > 0 and self._publish_count % self._log_every == 0:
                    logger.info(
                        "Publish summary count=%d topics=%d interval_ms=%d",
                        self._publish_count,
                        len(self.publishers_by_topic),
                        self.publish_interval_ms,
                    )
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
