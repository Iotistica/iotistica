BEGIN TRANSACTION;
CREATE TABLE IF NOT EXISTS "agent_metadata" (
	"key"	varchar(255),
	"value"	text NOT NULL,
	"createdAt"	datetime DEFAULT CURRENT_TIMESTAMP,
	"updatedAt"	datetime DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY("key")
);
CREATE TABLE IF NOT EXISTS "anomaly_alerts" (
	"id"	integer NOT NULL,
	"alert_id"	varchar(255) NOT NULL,
	"severity"	varchar(50) NOT NULL,
	"metric"	varchar(255) NOT NULL,
	"value"	float NOT NULL,
	"expected_min"	float,
	"expected_max"	float,
	"deviation"	float NOT NULL,
	"detection_method"	varchar(50) NOT NULL,
	"timestamp"	bigint NOT NULL,
	"confidence"	float NOT NULL,
	"context"	text,
	"message"	varchar(1000),
	"fingerprint"	varchar(255) NOT NULL,
	"count"	integer DEFAULT '1',
	"created_at"	datetime DEFAULT CURRENT_TIMESTAMP,
	"cooldown_sec"	integer NOT NULL DEFAULT '300',
	"first_seen"	bigint NOT NULL DEFAULT '0',
	"consecutive_count"	integer NOT NULL DEFAULT '1',
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "anomaly_baselines" (
	"id"	integer NOT NULL,
	"metric"	varchar(255) NOT NULL,
	"profile"	varchar(100),
	"time_slot"	integer NOT NULL DEFAULT '-1',
	"device_state"	varchar(20) NOT NULL DEFAULT 'unknown',
	"mean"	float,
	"median"	float,
	"std_dev"	float,
	"mad"	float,
	"min"	float,
	"max"	float,
	"q1"	float,
	"q3"	float,
	"iqr"	float,
	"sample_count"	integer NOT NULL,
	"calculated_at"	bigint NOT NULL,
	"window_start"	bigint,
	"window_end"	bigint,
	"created_at"	datetime DEFAULT CURRENT_TIMESTAMP,
	"updated_at"	datetime DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "agent" (
	"id"	integer NOT NULL,
	"uuid"	varchar(255) NOT NULL,
	"name"	varchar(255),
	"type"	varchar(255),
	"apiKey"	varchar(255),
	"apiEndpoint"	varchar(255),
	"registeredAt"	bigint,
	"provisioned"	boolean DEFAULT '0',
	"deviceApiKey"	varchar(255),
	"provisioningApiKey"	varchar(255),
	"mqttBrokerConfig"	text,
	"apiTlsConfig"	text,
	"applicationId"	integer,
	"agentVersion"	varchar(50),
	"macAddress"	varchar(255),
	"osVersion"	varchar(255),
	"createdAt"	datetime DEFAULT CURRENT_TIMESTAMP,
	"updatedAt"	datetime DEFAULT CURRENT_TIMESTAMP,
	"lastSeenAt"	datetime,
	"provisioningState"	varchar(255),
	"tenantId"	varchar(255),
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "dictionary_deltas" (
	"id"	INTEGER,
	"version"	INTEGER NOT NULL,
	"field_name"	TEXT NOT NULL,
	"field_index"	INTEGER NOT NULL,
	"domain"	TEXT NOT NULL DEFAULT 'metric' CHECK("domain" IN ('key', 'metric', 'unit', 'quality', 'device')),
	"synced_to_cloud"	BOOLEAN NOT NULL DEFAULT 0,
	"synced_at"	DATETIME,
	"created_at"	DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE("domain","field_index"),
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "dictionary_entries" (
	"id"	INTEGER,
	"field_name"	TEXT NOT NULL UNIQUE,
	"field_index"	INTEGER NOT NULL,
	"domain"	TEXT NOT NULL DEFAULT 'key' CHECK("domain" IN ('key', 'metric', 'unit', 'quality', 'device')),
	"version_added"	INTEGER NOT NULL,
	"created_at"	DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE("domain","field_index"),
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "dictionary_metadata" (
	"key"	varchar(100),
	"value"	text NOT NULL,
	"updated_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY("key")
);
CREATE TABLE IF NOT EXISTS "devices" (
	"id"	integer NOT NULL,
	"uuid"	varchar(255) NOT NULL UNIQUE,
	"endpoint_id"	integer NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
	"name"	varchar(255) NOT NULL,
	"protocol"	varchar(50) NOT NULL,
	"enabled"	boolean NOT NULL DEFAULT '1',
	"identifier"	varchar(255),
	"metadata"	text,
	"lastSeenAt"	datetime,
	"created_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE INDEX IF NOT EXISTS "idx_devices_endpoint_id" ON "devices" ("endpoint_id");
CREATE INDEX IF NOT EXISTS "idx_devices_protocol" ON "devices" ("protocol");
CREATE TABLE IF NOT EXISTS `endpoint_outputs` (`id` integer not null primary key autoincrement, `protocol` varchar(50) not null, `socket_path` varchar(500) not null, `data_format` varchar(50) not null default 'json', `delimiter` varchar(10) not null default '
', `include_timestamp` boolean not null default '1', `include_device_name` boolean not null default '1', `logging` text null, `created_at` datetime not null default CURRENT_TIMESTAMP, `updated_at` datetime not null default CURRENT_TIMESTAMP, `buffer_capacity` integer null);
CREATE TABLE IF NOT EXISTS "publish_destinations" (
	"id"	integer NOT NULL,
	"name"	varchar(255) NOT NULL,
	"type"	varchar(50) NOT NULL,
	"config_json"	text,
	"enabled"	boolean NOT NULL DEFAULT '1',
	"last_error"	text,
	"last_error_at"	datetime,
	"created_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "publish_subscriptions" (
	"id"	integer NOT NULL,
	"publish_destination_id"	integer NOT NULL REFERENCES publish_destinations(id) ON DELETE CASCADE,
	"topics"	text NOT NULL DEFAULT '[]',
	"route_json"	text,
	"payload_format"	varchar(20) NOT NULL DEFAULT 'custom',
	"compression"	varchar(50),
	"enabled"	boolean NOT NULL DEFAULT '1',
	"created_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "endpoints" (
	"id"	integer NOT NULL,
	"uuid"	varchar(255),
	"name"	varchar(255) NOT NULL,
	"protocol"	varchar(50) NOT NULL,
	"group_name"	varchar(255),
	"enabled"	boolean NOT NULL DEFAULT '1',
	"poll_interval"	integer NOT NULL DEFAULT '5000',
	"connection"	text NOT NULL,
	"data_points"	text,
	"metadata"	text,
	"created_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"lastSeenAt"	datetime,
	"fingerprint"	varchar(255),
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "enum_devices" (
	"id"	integer NOT NULL,
	"protocol"	varchar(32) NOT NULL,
	"device_name"	varchar(255) NOT NULL,
	"enum_index"	integer NOT NULL,
	"observation_count"	integer NOT NULL DEFAULT '0',
	"promoted_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"created_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"inactive"	boolean NOT NULL DEFAULT '0',
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "enum_metrics" (
	"id"	integer NOT NULL,
	"protocol"	varchar(32) NOT NULL,
	"metric_name"	varchar(255) NOT NULL,
	"enum_index"	integer NOT NULL,
	"observation_count"	integer NOT NULL DEFAULT '0',
	"promoted_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"created_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"inactive"	boolean NOT NULL DEFAULT '0',
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "enum_observations" (
	"id"	integer NOT NULL,
	"category"	varchar(32) NOT NULL,
	"namespace"	varchar(32),
	"value"	varchar(255) NOT NULL,
	"observation_count"	integer NOT NULL DEFAULT '1',
	"unique_value_count"	integer,
	"first_seen"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"last_seen"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"promoted_at"	datetime,
	"is_promoted"	boolean NOT NULL DEFAULT '0',
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "enum_quality_codes" (
	"id"	integer NOT NULL,
	"code_value"	varchar(64) NOT NULL,
	"enum_index"	integer NOT NULL,
	"observation_count"	integer NOT NULL DEFAULT '0',
	"promoted_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"created_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"inactive"	boolean NOT NULL DEFAULT '0',
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "schema_migrations" (
	"id"	integer NOT NULL,
	"name"	varchar(255),
	"batch"	integer,
	"migration_time"	datetime,
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "schema_migrations_lock" (
	"index"	integer NOT NULL,
	"is_locked"	integer,
	PRIMARY KEY("index" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "message_buffer" (
	"id"	integer NOT NULL,
	"endpoint_name"	varchar(255) NOT NULL,
	"topic"	varchar(500) NOT NULL,
	"qos"	integer NOT NULL DEFAULT '1',
	"payload"	text NOT NULL,
	"payload_bytes"	integer NOT NULL,
	"retry_count"	integer NOT NULL DEFAULT '0',
	"last_retry_at"	datetime,
	"last_error"	text,
	"created_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"expires_at"	datetime NOT NULL,
	"msg_id"	varchar(255),
	"next_retry_at"	datetime,
	"is_critical"	integer NOT NULL DEFAULT '0',
	"status"	varchar(20) NOT NULL DEFAULT 'queued',
	"lock_id"	varchar(64),
	"locked_at"	datetime,
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "message_buffer_metadata" (
	"key"	varchar(100),
	"value"	text NOT NULL,
	"updated_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY("key")
);
INSERT OR IGNORE INTO "message_buffer_metadata" ("key", "value", "updated_at") VALUES
	('max_records', '10000', CURRENT_TIMESTAMP),
	('max_bytes', '52428800', CURRENT_TIMESTAMP),
	('ttl_hours', '72', CURRENT_TIMESTAMP),
	('last_cleanup_at', '1970-01-01T00:00:00.000Z', CURRENT_TIMESTAMP),
	('total_buffered', '0', CURRENT_TIMESTAMP),
	('total_flushed', '0', CURRENT_TIMESTAMP),
	('total_dropped', '0', CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS "mqtt_acls" (
	"id"	integer NOT NULL,
	"username"	varchar(255),
	"clientid"	varchar(255),
	"topic"	varchar(255) NOT NULL,
	"access"	integer NOT NULL,
	"priority"	integer NOT NULL DEFAULT '0',
	"created_at"	datetime DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "mqtt_users" (
	"id"	integer NOT NULL,
	"username"	varchar(255) NOT NULL,
	"password_hash"	varchar(255) NOT NULL,
	"is_superuser"	boolean NOT NULL DEFAULT '0',
	"is_active"	boolean NOT NULL DEFAULT '1',
	"created_at"	datetime DEFAULT CURRENT_TIMESTAMP,
	"updated_at"	datetime DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "offline_queue" (
	"id"	integer NOT NULL,
	"queueName"	varchar(255) NOT NULL,
	"payload"	text NOT NULL,
	"createdAt"	bigint NOT NULL,
	"attempts"	integer DEFAULT '0',
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "retry_state" (
	"key"	varchar(255) NOT NULL,
	"count"	integer NOT NULL DEFAULT '0',
	"next_retry"	varchar(255) NOT NULL,
	"last_error"	text NOT NULL,
	"terminal"	integer NOT NULL DEFAULT '0',
	"retryable"	integer NOT NULL DEFAULT '1',
	"updated_at"	varchar(255) NOT NULL,
	PRIMARY KEY("key")
);
CREATE TABLE IF NOT EXISTS "message_schema_drift_log" (
	"id"	integer NOT NULL,
	"endpoint_name"	text NOT NULL,
	"drift_type"	text NOT NULL,
	"field_name"	text,
	"severity"	text NOT NULL,
	"expected_type"	text,
	"observed_types"	text,
	"rename_candidate_from"	text,
	"rename_candidate_to"	text,
	"rename_similarity"	real,
	"detected_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"details_json"	text,
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE TABLE IF NOT EXISTS "message_schema_baseline" (
	"endpoint_name"	text,
	"baseline_json"	text NOT NULL,
	"updated_at"	datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY("endpoint_name")
);
CREATE TABLE IF NOT EXISTS "stateSnapshot" (
	"id"	integer NOT NULL,
	"type"	varchar(50) NOT NULL,
	"state"	text,
	"stateHash"	varchar(64),
	"createdAt"	datetime DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE UNIQUE INDEX IF NOT EXISTS "anomaly_alerts_alert_id_unique" ON "anomaly_alerts" (
	"alert_id"
);
CREATE INDEX IF NOT EXISTS "anomaly_alerts_fingerprint_index" ON "anomaly_alerts" (
	"fingerprint"
);
CREATE INDEX IF NOT EXISTS "anomaly_alerts_metric_index" ON "anomaly_alerts" (
	"metric"
);
CREATE INDEX IF NOT EXISTS "anomaly_alerts_metric_timestamp_index" ON "anomaly_alerts" (
	"metric",
	"timestamp"
);
CREATE INDEX IF NOT EXISTS "anomaly_alerts_severity_index" ON "anomaly_alerts" (
	"severity"
);
CREATE INDEX IF NOT EXISTS "anomaly_alerts_timestamp_index" ON "anomaly_alerts" (
	"timestamp"
);
CREATE UNIQUE INDEX IF NOT EXISTS "anomaly_baselines_new_metric_profile_time_slot_unique" ON "anomaly_baselines" (
	"metric",
	"profile",
	"time_slot",
	"device_state"
);
CREATE INDEX IF NOT EXISTS "idx_anomaly_baselines_lookup" ON "anomaly_baselines" (
	"metric",
	"time_slot",
	"device_state",
	"calculated_at"
);
CREATE UNIQUE INDEX IF NOT EXISTS "agent_uuid_unique" ON "agent" (
	"uuid"
);
CREATE INDEX IF NOT EXISTS "dictionary_deltas_domain" ON "dictionary_deltas" (
	"domain"
);
CREATE INDEX IF NOT EXISTS "dictionary_deltas_domain_synced_to_cloud" ON "dictionary_deltas" (
	"domain",
	"synced_to_cloud"
);
CREATE INDEX IF NOT EXISTS "dictionary_deltas_synced_to_cloud" ON "dictionary_deltas" (
	"synced_to_cloud"
);
CREATE INDEX IF NOT EXISTS "dictionary_deltas_version" ON "dictionary_deltas" (
	"version"
);
CREATE INDEX IF NOT EXISTS "dictionary_deltas_version_synced" ON "dictionary_deltas" (
	"version",
	"synced_to_cloud"
);
CREATE INDEX IF NOT EXISTS "dictionary_entries_domain" ON "dictionary_entries" (
	"domain"
);
CREATE INDEX IF NOT EXISTS "dictionary_entries_domain_field_index" ON "dictionary_entries" (
	"domain",
	"field_index"
);
CREATE INDEX IF NOT EXISTS "dictionary_entries_field_name" ON "dictionary_entries" (
	"field_name"
);
CREATE INDEX IF NOT EXISTS "dictionary_entries_version_added" ON "dictionary_entries" (
	"version_added"
);
CREATE UNIQUE INDEX IF NOT EXISTS "endpoint_outputs_protocol_unique" ON "endpoint_outputs" (
	"protocol"
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_publish_destinations_name_unique" ON "publish_destinations" (
	"name"
);
CREATE INDEX IF NOT EXISTS "idx_publish_destinations_type_enabled" ON "publish_destinations" (
	"type",
	"enabled"
);
CREATE INDEX IF NOT EXISTS "idx_publish_subscriptions_publish_destination_id" ON "publish_subscriptions" (
	"publish_destination_id"
);
CREATE INDEX IF NOT EXISTS "idx_publish_subscriptions_enabled" ON "publish_subscriptions" (
	"enabled"
);
CREATE INDEX IF NOT EXISTS "endpoints_enabled_index" ON "endpoints" (
	"enabled"
);
CREATE UNIQUE INDEX IF NOT EXISTS "endpoints_name_unique" ON "endpoints" (
	"name"
);
CREATE INDEX IF NOT EXISTS "endpoints_protocol_index" ON "endpoints" (
	"protocol"
);
CREATE INDEX IF NOT EXISTS "endpoints_uuid_index" ON "endpoints" (
	"uuid"
);
CREATE UNIQUE INDEX IF NOT EXISTS "endpoints_uuid_unique" ON "endpoints" (
	"uuid"
);
CREATE INDEX IF NOT EXISTS "idx_message_schema_drift_log_endpoint_time" ON "message_schema_drift_log" (
	"endpoint_name",
	"detected_at" DESC
);
CREATE UNIQUE INDEX IF NOT EXISTS "enum_devices_protocol_device_name_unique" ON "enum_devices" (
	"protocol",
	"device_name"
);
CREATE UNIQUE INDEX IF NOT EXISTS "enum_devices_protocol_enum_index_unique" ON "enum_devices" (
	"protocol",
	"enum_index"
);
CREATE INDEX IF NOT EXISTS "enum_devices_protocol_inactive_index" ON "enum_devices" (
	"protocol",
	"inactive"
);
CREATE INDEX IF NOT EXISTS "enum_devices_protocol_index" ON "enum_devices" (
	"protocol"
);
CREATE UNIQUE INDEX IF NOT EXISTS "enum_metrics_protocol_enum_index_unique" ON "enum_metrics" (
	"protocol",
	"enum_index"
);
CREATE INDEX IF NOT EXISTS "enum_metrics_protocol_inactive_index" ON "enum_metrics" (
	"protocol",
	"inactive"
);
CREATE INDEX IF NOT EXISTS "enum_metrics_protocol_index" ON "enum_metrics" (
	"protocol"
);
CREATE UNIQUE INDEX IF NOT EXISTS "enum_metrics_protocol_metric_name_unique" ON "enum_metrics" (
	"protocol",
	"metric_name"
);
CREATE INDEX IF NOT EXISTS "enum_observations_category_is_promoted_index" ON "enum_observations" (
	"category",
	"is_promoted"
);
CREATE UNIQUE INDEX IF NOT EXISTS "enum_observations_category_namespace_value_unique" ON "enum_observations" (
	"category",
	"namespace",
	"value"
);
CREATE INDEX IF NOT EXISTS "enum_observations_namespace_index" ON "enum_observations" (
	"namespace"
);
CREATE UNIQUE INDEX IF NOT EXISTS "enum_quality_codes_code_value_unique" ON "enum_quality_codes" (
	"code_value"
);
CREATE UNIQUE INDEX IF NOT EXISTS "enum_quality_codes_enum_index_unique" ON "enum_quality_codes" (
	"enum_index"
);
CREATE INDEX IF NOT EXISTS "enum_quality_codes_inactive_index" ON "enum_quality_codes" (
	"inactive"
);
CREATE INDEX IF NOT EXISTS "idx_anomaly_alerts_consecutive" ON "anomaly_alerts" (
	"metric",
	"consecutive_count",
	"first_seen"
);
CREATE INDEX IF NOT EXISTS "idx_anomaly_alerts_flapping" ON "anomaly_alerts" (
	"fingerprint",
	"count",
	"consecutive_count"
);
CREATE INDEX IF NOT EXISTS "idx_endpoints_fingerprint" ON "endpoints" (
	"fingerprint"
);
CREATE INDEX IF NOT EXISTS "idx_message_buffer_endpoint_name" ON "message_buffer" (
	"endpoint_name"
);
CREATE INDEX IF NOT EXISTS "idx_message_buffer_expires_at" ON "message_buffer" (
	"expires_at"
);
CREATE INDEX IF NOT EXISTS "idx_message_buffer_lock_id" ON "message_buffer" (
	"lock_id"
);
CREATE INDEX IF NOT EXISTS "idx_message_buffer_lock_recovery" ON "message_buffer" (
	"status",
	"locked_at"
);
CREATE INDEX IF NOT EXISTS "idx_message_buffer_ready" ON "message_buffer" (
	"status",
	"next_retry_at",
	"created_at"
);
CREATE INDEX IF NOT EXISTS "idx_message_buffer_status_lock_created" ON "message_buffer" (
	"status",
	"lock_id",
	"created_at"
);
CREATE INDEX IF NOT EXISTS "idx_message_buffer_status_retry" ON "message_buffer" (
	"status",
	"next_retry_at"
);
CREATE INDEX IF NOT EXISTS "idx_mqtt_acls_topic" ON "mqtt_acls" (
	"topic"
);
CREATE INDEX IF NOT EXISTS "idx_mqtt_acls_username" ON "mqtt_acls" (
	"username"
);
CREATE INDEX IF NOT EXISTS "idx_retry_state_retryable" ON "retry_state" (
	"retryable",
	"terminal"
);
CREATE INDEX IF NOT EXISTS "idx_retry_state_terminal" ON "retry_state" (
	"terminal",
	"updated_at"
);
CREATE INDEX IF NOT EXISTS "idx_retry_state_updated_at" ON "retry_state" (
	"updated_at"
);
CREATE INDEX IF NOT EXISTS "message_buffer_created_at_index" ON "message_buffer" (
	"created_at"
);
CREATE INDEX IF NOT EXISTS "message_buffer_endpoint_name_created_at_index" ON "message_buffer" (
	"endpoint_name",
	"created_at"
);
CREATE INDEX IF NOT EXISTS "message_buffer_expires_at_index" ON "message_buffer" (
	"expires_at"
);
CREATE INDEX IF NOT EXISTS "message_buffer_is_critical_index" ON "message_buffer" (
	"is_critical"
);
CREATE INDEX IF NOT EXISTS "message_buffer_lock_id_index" ON "message_buffer" (
	"lock_id"
);
CREATE INDEX IF NOT EXISTS "message_buffer_locked_at_index" ON "message_buffer" (
	"locked_at"
);
CREATE INDEX IF NOT EXISTS "message_buffer_msg_id_index" ON "message_buffer" (
	"msg_id"
);
CREATE INDEX IF NOT EXISTS "message_buffer_next_retry_at_index" ON "message_buffer" (
	"next_retry_at"
);
CREATE INDEX IF NOT EXISTS "message_buffer_status_index" ON "message_buffer" (
	"status"
);
CREATE UNIQUE INDEX IF NOT EXISTS "mqtt_users_username_unique" ON "mqtt_users" (
	"username"
);
CREATE INDEX IF NOT EXISTS "offline_queue_queuename_createdat_index" ON "offline_queue" (
	"queueName",
	"createdAt"
);
CREATE INDEX IF NOT EXISTS "statesnapshot_statehash_index" ON "stateSnapshot" (
	"stateHash"
);
CREATE INDEX IF NOT EXISTS "statesnapshot_type_index" ON "stateSnapshot" (
	"type"
);
COMMIT;
