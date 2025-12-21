-- Migration: Create vendor_configs table
-- Description: Centralized storage for protocol vendor configurations (replaces dataPoints.json file)
-- Benefits: Dynamic updates, API-editable, no container rebuilds needed

CREATE TABLE IF NOT EXISTS vendor_configs (
  id SERIAL PRIMARY KEY,
  vendor_name VARCHAR(100) NOT NULL UNIQUE,
  protocol VARCHAR(50) NOT NULL DEFAULT 'modbus', -- modbus, opcua, snmp, can, etc.
  data_points JSONB NOT NULL, -- Array of data point definitions
  metadata JSONB, -- Optional: vendor info, URLs, descriptions
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast vendor lookups (idempotent)
CREATE INDEX IF NOT EXISTS idx_vendor_configs_vendor_name ON vendor_configs(vendor_name);
CREATE INDEX IF NOT EXISTS idx_vendor_configs_protocol ON vendor_configs(protocol);

-- Seed with existing COMAP configuration (idempotent - skip if already exists)
-- NOTE: Addresses are 0-based (modbus-serial library auto-increments by 1)
-- So address 99 here becomes 100 when read, address 109 becomes 110, etc.
INSERT INTO vendor_configs (vendor_name, protocol, data_points, metadata) VALUES
('COMAP', 'modbus', 
 '[
   {"name": "engine_rpm", "address": 99, "type": "holding", "dataType": "uint16", "base": 1500, "noise_pct": 0.05, "unit": "RPM"},
   {"name": "gen_voltage_a", "address": 109, "type": "holding", "dataType": "uint16", "base": 230, "noise_pct": 0.02, "unit": "V"},
   {"name": "gen_voltage_b", "address": 110, "type": "holding", "dataType": "uint16", "base": 230, "noise_pct": 0.02, "unit": "V"},
   {"name": "gen_voltage_c", "address": 111, "type": "holding", "dataType": "uint16", "base": 230, "noise_pct": 0.02, "unit": "V"},
   {"name": "gen_current_a", "address": 119, "type": "holding", "dataType": "uint16", "base": 50, "noise_pct": 0.1, "unit": "A"},
   {"name": "gen_current_b", "address": 120, "type": "holding", "dataType": "uint16", "base": 50, "noise_pct": 0.1, "unit": "A"},
   {"name": "gen_current_c", "address": 121, "type": "holding", "dataType": "uint16", "base": 50, "noise_pct": 0.1, "unit": "A"},
   {"name": "frequency", "address": 129, "type": "holding", "dataType": "uint16", "base": 50, "noise_pct": 0.01, "unit": "Hz"},
   {"name": "power_kw", "address": 139, "type": "holding", "dataType": "uint16", "base": 100, "noise_pct": 0.15, "unit": "kW"},
   {"name": "engine_temp", "address": 149, "type": "holding", "dataType": "uint16", "base": 85, "noise_pct": 0.05, "unit": "°C"},
   {"name": "fuel_level", "address": 159, "type": "holding", "dataType": "uint16", "base": 75, "noise_pct": 0.02, "unit": "%"},
   {"name": "alarm_1", "address": 0, "type": "coil", "dataType": "boolean"},
   {"name": "alarm_2", "address": 1, "type": "coil", "dataType": "boolean"},
   {"name": "alarm_3", "address": 2, "type": "coil", "dataType": "boolean"},
   {"name": "alarm_4", "address": 3, "type": "coil", "dataType": "boolean"}
 ]'::jsonb,
 '{"description": "COMAP Generator Controller", "vendorUrl": "https://www.comap-control.com/"}'::jsonb
),
('Generic', 'modbus',
 '[
   {"name": "holding_register_0", "address": 1, "type": "holding", "dataType": "uint16", "base": 200, "noise_pct": 0.1, "unit": "count"},
   {"name": "holding_register_1", "address": 2, "type": "holding", "dataType": "uint16", "base": 280, "noise_pct": 0.1, "unit": "count"},
   {"name": "holding_register_2", "address": 3, "type": "holding", "dataType": "uint16", "base": 150, "noise_pct": 0.15, "unit": "count"},
   {"name": "temperature", "address": 10, "type": "holding", "dataType": "uint16", "base": 230, "noise_pct": 0.08, "unit": "°C", "scale": 0.1, "description": "Ambient temperature (scaled ×10, e.g., 230 = 23.0°C)"},
   {"name": "humidity", "address": 11, "type": "holding", "dataType": "uint16", "base": 550, "noise_pct": 0.1, "unit": "%RH", "scale": 0.1, "description": "Relative humidity (scaled ×10, e.g., 550 = 55.0%)"},
   {"name": "pressure", "address": 12, "type": "holding", "dataType": "uint16", "base": 1013, "noise_pct": 0.015, "unit": "hPa", "description": "Atmospheric pressure in hectopascals (1013 hPa = sea level)"}
 ]'::jsonb,
 '{"description": "Generic Modbus Device"}'::jsonb
)
ON CONFLICT (vendor_name) DO NOTHING;

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_vendor_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if exists, then recreate (idempotent)
DROP TRIGGER IF EXISTS trigger_vendor_configs_updated_at ON vendor_configs;
CREATE TRIGGER trigger_vendor_configs_updated_at
  BEFORE UPDATE ON vendor_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_vendor_configs_updated_at();

COMMENT ON TABLE vendor_configs IS 'Centralized vendor protocol configurations - replaces static dataPoints.json file';
COMMENT ON COLUMN vendor_configs.data_points IS 'JSONB array of protocol-specific data point definitions';
COMMENT ON COLUMN vendor_configs.metadata IS 'Additional vendor information (URLs, descriptions, etc.)';
