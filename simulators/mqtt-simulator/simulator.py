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


LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("mqtt-simulator")


def parse_metric_overrides(raw_value: str | None, env_name: str, value_parser):
    overrides = {}
    if not raw_value:
        return overrides

    for entry in raw_value.split(","):
        item = entry.strip()
        if not item:
            continue

        metric_name, separator, raw_metric_value = item.partition(":")
        if not separator:
            raise ValueError(f"{env_name} entries must use metric:value format")

        metric_key = metric_name.strip().lower()
        metric_value = raw_metric_value.strip()
        if not metric_key:
            raise ValueError(f"{env_name} contains an empty metric name")
        if not metric_value:
            raise ValueError(f"{env_name} contains an empty value for metric '{metric_name.strip()}'")

        try:
            overrides[metric_key] = value_parser(metric_value)
        except Exception as exc:
            raise ValueError(
                f"{env_name} contains an invalid value for metric '{metric_name.strip()}': {metric_value}"
            ) from exc

    return overrides


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
        self.device_uuid = datapoint.get("device_uuid", "")

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
        payload = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "name": self.name,
            "value": value,
            "unit": self.unit,
        }
        if self.device_uuid:
            payload["device_uuid"] = self.device_uuid
        return payload


class MqttSimulator:
    def __init__(self):
        self.broker_url = os.environ["MQTT_BROKER_URL"]
        self.username = os.environ.get("MQTT_USERNAME") 
        self.password = os.environ.get("MQTT_PASSWORD") 
        self.client_id = os.environ.get("MQTT_CLIENT_ID", "iotistic-mqtt-simulator")
        self.device_uuid = os.environ.get("MQTT_DEVICE_UUID", "")
        self.publish_topic = os.environ.get("MQTT_TOPIC", "sensor/temperature")
        metric_names_raw = os.environ.get("MQTT_METRIC_NAMES", "temperature")
        self.metric_names = [name.strip() for name in metric_names_raw.split(",") if name.strip()]
        self.default_qos = int(os.environ.get("MQTT_QOS", "0"))
        self.default_retain = os.environ.get("MQTT_RETAIN", "false").lower() == "true"
        self.publish_interval_ms = int(os.environ.get("PUBLISH_INTERVAL_MS", "1000"))
        self.payload_mode = os.environ.get("MQTT_PAYLOAD_MODE", "multi").lower()
        self.timestamp_field = os.environ.get("MQTT_TIMESTAMP_FIELD", "ts")
        self.timestamp_format = os.environ.get("MQTT_TIMESTAMP_FORMAT", "epoch_ms").lower()
        self.log_publish_events = os.environ.get("LOG_PUBLISH_EVENTS", "true").lower() == "true"
        self.metric_unit_overrides = parse_metric_overrides(
            os.environ.get("MQTT_METRIC_UNITS"),
            "MQTT_METRIC_UNITS",
            lambda value: value,
        )
        self.metric_base_overrides = parse_metric_overrides(
            os.environ.get("MQTT_METRIC_BASES"),
            "MQTT_METRIC_BASES",
            float,
        )

        if not self.username or not self.password:
            raise ValueError("MQTT auth is required: set MQTT_USERNAME and MQTT_PASSWORD")

        if not self.device_uuid:
            raise ValueError("MQTT_DEVICE_UUID is required")

        if self.publish_interval_ms < 100:
            raise ValueError("PUBLISH_INTERVAL_MS must be >= 100")

        if not self.metric_names:
            raise ValueError("MQTT_METRIC_NAMES must contain at least one metric name")

        if self.payload_mode not in ("single", "multi"):
            raise ValueError("MQTT_PAYLOAD_MODE must be one of: single, multi")

        if self.default_qos not in (0, 1, 2):
            raise ValueError("MQTT_QOS must be one of: 0, 1, 2")

        if self.timestamp_format not in ("epoch_ms", "iso"):
            raise ValueError("MQTT_TIMESTAMP_FORMAT must be one of: epoch_ms, iso")

        parsed = urlparse(self.broker_url)
        if parsed.scheme not in ("mqtt", "tcp"):
            raise ValueError("MQTT_BROKER_URL must use mqtt:// or tcp://")
        if not parsed.hostname or not parsed.port:
            raise ValueError("MQTT_BROKER_URL must include host and port")

        self.host = parsed.hostname
        self.port = parsed.port

        datapoints = []
        metric_defaults = {
            "temperature": {"unit": "C", "base": 23.0, "min": -20.0, "max": 80.0},
            "humidity": {"unit": "%", "base": 45.0, "min": 0.0, "max": 100.0},
            "pressure": {"unit": "kPa", "base": 101.3, "min": 90.0, "max": 110.0},
            "vibration": {"unit": "mm/s", "base": 5.0, "min": 0.0, "max": 30.0},
        }

        for metric_name in self.metric_names:
            metric_key = metric_name.lower()
            defaults = dict(metric_defaults.get(metric_key, {"unit": "", "base": 50.0}))

            if metric_key in self.metric_unit_overrides:
                defaults["unit"] = self.metric_unit_overrides[metric_key]

            if metric_key in self.metric_base_overrides:
                defaults["base"] = self.metric_base_overrides[metric_key]

            datapoints.append({
                "name": metric_name,
                "topic": self.publish_topic,
                "qos": self.default_qos,
                "retain": self.default_retain,
                "dataType": "float",
                "unit": defaults.get("unit", ""),
                "base": defaults.get("base", 50.0),
                "noise_pct": 0.02,
                "min": defaults.get("min"),
                "max": defaults.get("max"),
                "period_s": 30.0,
                "device_uuid": self.device_uuid,
            })

        if self.metric_unit_overrides or self.metric_base_overrides:
            logger.info(
                "Applying MQTT metric overrides units=%s bases=%s",
                sorted(self.metric_unit_overrides.keys()),
                sorted(self.metric_base_overrides.keys()),
            )

        self.publishers = [DataPointPublisher(dp) for dp in datapoints]
        self.publishers_by_topic = defaultdict(list)
        for publisher in self.publishers:
            self.publishers_by_topic[publisher.topic].append(publisher)

        self.client = mqtt.Client(client_id=self.client_id)
        self.client.username_pw_set(self.username, self.password)
        self.client.will_set(f"device/{self.device_uuid}/status", payload="offline", qos=1, retain=True)
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
            client.publish(f"device/{self.device_uuid}/status", "online", qos=1, retain=True)
            logger.info("Published LWT online status topic=device/%s/status", self.device_uuid)

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

        device_uuid = next((p.device_uuid for p in publishers if p.device_uuid), None)
        if device_uuid:
            payload["device_uuid"] = device_uuid

        units = {}

        for pub in publishers:
            payload[pub.name] = pub.next_value(now)
            if pub.unit:
                units[pub.name] = pub.unit

        if units:
            payload["units"] = units

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
            "Starting MQTT simulator topic=%s metrics=%s datapoints=%d mode=%s topics=%d",
            self.publish_topic,
            ",".join(self.metric_names),
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
