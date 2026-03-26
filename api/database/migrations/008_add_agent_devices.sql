-- Migration: Add agent_devices table
--
-- Stores physical/logical devices as reported by the agent's own `devices`
-- table (edge SQLite).  The agent includes this list in its state report when
-- the device list changes; the cloud stores a copy here so consumers can
-- query agent_devices without re-parsing endpoint metadata.
--
-- Relationship to existing tables:
--   agent_devices.agent_uuid  → agents.uuid      (owning agent)
--   agent_devices.endpoint_uuid → endpoints.uuid  (parent connection, informational)
--
-- Source of truth: the edge agent.  Cloud rows are upserted on each report
-- that includes a `devices` field.

CREATE TABLE IF NOT EXISTS public.agent_devices (
    id           SERIAL PRIMARY KEY,
    uuid         UUID NOT NULL,
    agent_uuid   UUID NOT NULL REFERENCES public.agents(uuid) ON DELETE CASCADE,
    endpoint_uuid UUID,                        -- matches endpoints.uuid; nullable (orphan safe)
    name         VARCHAR(255) NOT NULL,
    protocol     VARCHAR(50)  NOT NULL,
    identifier   VARCHAR(255),                 -- slaveId (Modbus), device_uuid (OPC-UA), null (1:1)
    enabled      BOOLEAN NOT NULL DEFAULT true,
    last_seen_at TIMESTAMP WITH TIME ZONE,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT uq_agent_devices_agent_uuid UNIQUE (agent_uuid, uuid)
);

CREATE INDEX IF NOT EXISTS idx_agent_devices_agent_uuid ON public.agent_devices (agent_uuid);
CREATE INDEX IF NOT EXISTS idx_agent_devices_protocol   ON public.agent_devices (agent_uuid, protocol);
