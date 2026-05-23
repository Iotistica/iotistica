Review the current agent publishing architecture and redesign only the upstream publishing stage to support multi-destination subscription-based publishing, similar to Neuron northbound applications.

Current architecture:

PublishManager already handles:
batching (MessageBatcher)
anomaly enrichment
schema drift detection
pipeline transforms
buffering / durable retry
compression
connection lifecycle
socket-server.ts already implements:
topic-based pub/sub
wildcard subscriptions
per-subscriber routing rules
filtering (metrics/devices/quality)
throttling (minIntervalMs)
flow control (maxPointsPerMessage)
backpressure handling
subscriber lifecycle

Problem:

We currently publish to only one active upstream destination through:
PublishManager → IPublishPlugin
We want to support publishing to multiple upstream destinations simultaneously (Cloud, MQTT, AWS, Google, etc.).
Avoid introducing another broker/router if existing infrastructure can be reused.

Goal:
Reuse socket-server.ts as the internal subscription engine and make upstream publishers behave as subscribers.

Architecture target:

Device
 ↓
PublishManager
 ↓
SocketServer (existing pub/sub)
 ↓
Publisher Subscribers
 ↓
PublishPlugin[]

Requirements:

Keep existing processing pipeline unchanged:
MessageBatcher
anomaly processing
schema drift detection
pipeline transforms
durable buffering
compression
connection lifecycle

Remove the assumption:

private readonly publishPlugin: IPublishPlugin

Introduce:

PublisherHost
UpstreamPublisherClient
PublishSubscription
SubscriptionRepository
PayloadFormatter
Upstream publishers should subscribe through socket-server.ts instead of being called directly.
Persist subscriptions and publisher instances in the main SQLite database.

Suggested tables:

publishers(
  id,
  type,
  config_json,
  enabled
)

publidh_subscriptions(
  id,
  publisher_id,
  topics,
  include_metrics,
  exclude_metrics,
  include_devices,
  exclude_devices,
  qualities,
  min_interval_ms,
  max_points,
  payload_format,
  enabled
)

(JSON fields are acceptable.)

Subscription model should reuse socket-server routing:

{
  "subscribe": ["modbus", "opcua"],
  "route": {
    "includeMetrics": ["temperature"],
    "excludeDevices": ["pump-2"],
    "qualities": ["GOOD"],
    "minIntervalMs": 1000,
    "maxPointsPerMessage": 100
  },
  "publish": {
    "format": "ecp"
  }
}

Move payload formatting out of PublishManager.

Current:

buildPayload()
→ publish()

Target:

socket event
↓
subscription
↓
formatter
↓
publish plugin

Keep support for:

custom
tags
ecp

Migration requirements:

preserve current behavior
automatically create a default subscription to current upstream
existing deployments must continue working unchanged

Deliver:

architecture diagram
proposed class diagram
TypeScript interfaces
SQLite migration
event flow
incremental implementation plan
files to modify
pseudocode
rollback strategy

Constraints:

Do not overengineer
No Kafka
No event sourcing
No distributed queues
No replacing socket-server
Minimal changes to PublishManager
Prefer composition over refactoring core ingestion logic

Focus on converting upstream publishing from single active publisher → subscription-driven fan-out using existing socket infrastructure.