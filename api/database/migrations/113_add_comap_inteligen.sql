-- Migration: Add ComAp InteliGen 200 vendor configuration
-- Description: Professional genset controller with enhanced monitoring and control capabilities
-- Note: Addresses are 0-based (modbus-serial auto-increments by 1)

INSERT INTO vendor_configs (vendor_name, protocol, data_points, metadata) VALUES
('ComAp-InteliGen', 'modbus', 
 '[
   {"name": "engine_speed", "address": 0, "type": "holding", "dataType": "uint16", "base": 1800, "noise_pct": 0.01, "unit": "RPM", "scale": 1, "description": "Engine speed in RPM"},
   {"name": "generator_voltage", "address": 1, "type": "holding", "dataType": "uint16", "base": 480, "noise_pct": 0.02, "unit": "V", "scale": 1, "description": "Generator output voltage"},
   {"name": "generator_current", "address": 2, "type": "holding", "dataType": "uint16", "base": 200, "noise_pct": 0.05, "unit": "A", "scale": 1, "description": "Generator output current"},
   {"name": "coolant_temperature", "address": 3, "type": "holding", "dataType": "uint16", "base": 85, "noise_pct": 0.03, "unit": "C", "description": "Engine coolant temperature"},
   {"name": "run_mode", "address": 9, "type": "holding", "dataType": "uint16", "base": 1, "noise_pct": 0, "unit": "enum", "enum": {"0": "STOP", "1": "AUTO", "2": "MANUAL"}, "description": "Operating mode selection"},
   {"name": "alarm_word_1", "address": 19, "type": "holding", "dataType": "uint16", "base": 0, "noise_pct": 0, "unit": "bitmask", "bitmask": {"0": "EmergencyStop", "1": "LowOilPressure", "2": "HighCoolantTemp", "3": "OverSpeed"}, "description": "Alarm status bitmask"},
   {"name": "start_command", "address": 0, "type": "coil", "dataType": "boolean", "description": "Start genset command"},
   {"name": "stop_command", "address": 1, "type": "coil", "dataType": "boolean", "description": "Stop genset command"}
 ]'::jsonb,
 '{"description": "ComAp InteliGen 200 Generator Controller", "vendorUrl": "https://www.comap-control.com", "model": "InteliGen 200", "version": "4.0"}'::jsonb
)
ON CONFLICT (vendor_name) DO NOTHING;

-- Add comment for reference
COMMENT ON TABLE vendor_configs IS 'Centralized vendor protocol configurations - now includes ComAp InteliGen 200';
