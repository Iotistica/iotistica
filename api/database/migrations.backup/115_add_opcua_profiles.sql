-- Migration: Add OPC UA Protocol Profiles
-- Description: Insert OPC UA simulator profiles (factory, test, workshop, smart-building)
-- Note: These profiles define OPC UA sensor configurations for the OPC UA simulator

-- Add unique constraint if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'profile_configs_profile_name_protocol_key'
  ) THEN
    ALTER TABLE profile_configs 
    ADD CONSTRAINT profile_configs_profile_name_protocol_key 
    UNIQUE (profile_name, protocol);
  END IF;
END $$;

-- Factory Profile - Standard industrial factory
INSERT INTO profile_configs (profile_name, protocol, data_points, metadata) VALUES
('factory', 'opcua', 
 '{
   "sensors": [
     {
       "folder": "Temperature",
       "prefix": "Sensor",
       "model": "temperature",
       "count": 5,
       "unit": "°C",
       "config": {
         "base": 25.0,
         "variation": 5.0,
         "noise": 0.5,
         "period": 30.0,
         "min_value": -50.0,
         "max_value": 150.0
       }
     },
     {
       "folder": "Pressure",
       "prefix": "Sensor",
       "model": "pressure",
       "count": 5,
       "unit": "mbar",
       "config": {
         "base": 1100.0,
         "variation": 50.0,
         "noise": 2.0,
         "period": 45.0,
         "min_value": 0.0,
         "max_value": 2000.0
       }
     },
     {
       "folder": "Flow",
       "prefix": "Sensor",
       "model": "flow",
       "count": 5,
       "unit": "L/min",
       "config": {
         "base": 50.0,
         "variation": 30.0,
         "noise": 2.0,
         "period": 20.0,
         "min_value": 0.0,
         "max_value": 100.0
       }
     },
     {
       "folder": "Level",
       "prefix": "Tank",
       "model": "level",
       "count": 3,
       "unit": "%",
       "config": {
         "base": 75.0,
         "variation": 20.0,
         "noise": 1.0,
         "period": 60.0,
         "min_value": 0.0,
         "max_value": 100.0
       }
     },
     {
       "folder": "Vibration",
       "prefix": "Motor",
       "model": "vibration",
       "count": 4,
       "unit": "mm/s",
       "config": {
         "base": 2.5,
         "variation": 1.0,
         "noise": 0.3,
         "period": 15.0,
         "min_value": 0.0,
         "max_value": 10.0
       }
     },
     {
       "folder": "Power",
       "prefix": "Line",
       "model": "power",
       "count": 3,
       "unit": "kW",
       "config": {
         "base": 150.0,
         "variation": 50.0,
         "noise": 5.0,
         "period": 25.0,
         "min_value": 0.0,
         "max_value": 500.0
       }
     }
   ]
 }'::jsonb,
 '{"description": "Standard industrial factory with multiple sensor types", "sensorTypes": ["temperature", "pressure", "flow", "level", "vibration", "power"], "totalSensors": 26}'::jsonb
)
ON CONFLICT (profile_name, protocol) DO NOTHING;

-- Test Profile - Minimal test configuration
INSERT INTO profile_configs (profile_name, protocol, data_points, metadata) VALUES
('test', 'opcua',
 '{
   "sensors": [
     {
       "folder": "TestSensors",
       "prefix": "TestTemp",
       "model": "temperature",
       "count": 2,
       "unit": "°C",
       "config": {
         "base": 20.0,
         "variation": 5.0,
         "noise": 0.5,
         "period": 10.0,
         "min_value": -10.0,
         "max_value": 50.0
       }
     }
   ]
 }'::jsonb,
 '{"description": "Minimal test profile for development and testing", "sensorTypes": ["temperature"], "totalSensors": 2}'::jsonb
)
ON CONFLICT (profile_name, protocol) DO NOTHING;

-- Workshop Profile - Small workshop environment
INSERT INTO profile_configs (profile_name, protocol, data_points, metadata) VALUES
('workshop', 'opcua',
 '{
   "sensors": [
     {
       "folder": "Workshop",
       "subfolder": "Zone_A",
       "prefix": "Temp",
       "model": "temperature",
       "count": 3,
       "unit": "°C",
       "config": {
         "base": 22.0,
         "variation": 3.0,
         "noise": 0.5,
         "period": 30.0,
         "min_value": 10.0,
         "max_value": 40.0
       }
     },
     {
       "folder": "Workshop",
       "subfolder": "Zone_A",
       "prefix": "Humidity",
       "model": "humidity",
       "count": 2,
       "unit": "%",
       "config": {
         "base": 50.0,
         "variation": 15.0,
         "noise": 2.0,
         "period": 45.0,
         "min_value": 20.0,
         "max_value": 80.0
       }
     },
     {
       "folder": "Workshop",
       "subfolder": "Zone_B",
       "prefix": "AirQuality",
       "model": "pressure",
       "count": 2,
       "unit": "ppm",
       "config": {
         "base": 400.0,
         "variation": 100.0,
         "noise": 10.0,
         "period": 40.0,
         "min_value": 300.0,
         "max_value": 1000.0
       }
     }
   ]
 }'::jsonb,
 '{"description": "Small workshop with environmental monitoring", "sensorTypes": ["temperature", "humidity", "pressure"], "totalSensors": 7}'::jsonb
)
ON CONFLICT (profile_name, protocol) DO NOTHING;

-- Smart Building Profile - Multi-story commercial building
INSERT INTO profile_configs (profile_name, protocol, data_points, metadata) VALUES
('smart-building', 'opcua',
 '{
   "sensors": [
     {
       "folder": "Building_A",
       "subfolder": "Floor_1",
       "zone": "Zone_North",
       "prefix": "HVAC",
       "model": "temperature",
       "count": 3,
       "unit": "°C",
       "config": {
         "base": 21.5,
         "variation": 2.0,
         "noise": 0.3,
         "period": 60.0,
         "min_value": 18.0,
         "max_value": 26.0
       }
     },
     {
       "folder": "Building_A",
       "subfolder": "Floor_1",
       "zone": "Zone_North",
       "prefix": "AirQuality",
       "model": "pressure",
       "count": 2,
       "unit": "ppm",
       "config": {
         "base": 450.0,
         "variation": 100.0,
         "noise": 15.0,
         "period": 45.0,
         "min_value": 300.0,
         "max_value": 1000.0
       }
     },
     {
       "folder": "Building_A",
       "subfolder": "Floor_1",
       "zone": "Zone_South",
       "prefix": "HVAC",
       "model": "temperature",
       "count": 3,
       "unit": "°C",
       "config": {
         "base": 22.0,
         "variation": 1.8,
         "noise": 0.3,
         "period": 60.0,
         "min_value": 18.0,
         "max_value": 26.0
       }
     },
     {
       "folder": "Building_A",
       "subfolder": "Floor_2",
       "zone": "Office_Area",
       "prefix": "Occupancy",
       "model": "occupancy",
       "count": 4,
       "unit": "people",
       "config": {
         "base": 15.0,
         "variation": 10.0,
         "noise": 2.0,
         "period": 90.0,
         "min_value": 0.0,
         "max_value": 50.0
       }
     },
     {
       "folder": "Building_A",
       "subfolder": "Floor_2",
       "zone": "Office_Area",
       "prefix": "Lighting",
       "model": "illuminance",
       "count": 3,
       "unit": "lux",
       "config": {
         "base": 500.0,
         "variation": 200.0,
         "noise": 20.0,
         "period": 75.0,
         "min_value": 100.0,
         "max_value": 1000.0
       }
     },
     {
       "folder": "Building_A",
       "subfolder": "Roof",
       "zone": "Solar_Array",
       "prefix": "Panel",
       "model": "power",
       "count": 4,
       "unit": "kW",
       "config": {
         "base": 50.0,
         "variation": 30.0,
         "noise": 2.0,
         "period": 120.0,
         "min_value": 0.0,
         "max_value": 100.0
       }
     },
     {
       "folder": "Building_A",
       "subfolder": "Basement",
       "zone": "Mechanical",
       "prefix": "Chiller",
       "model": "temperature",
       "count": 2,
       "unit": "°C",
       "config": {
         "base": 7.0,
         "variation": 2.0,
         "noise": 0.5,
         "period": 50.0,
         "min_value": 4.0,
         "max_value": 12.0
       }
     },
     {
       "folder": "Building_A",
       "subfolder": "Basement",
       "zone": "Mechanical",
       "prefix": "CoolingWater",
       "model": "flow",
       "count": 2,
       "unit": "L/min",
       "config": {
         "base": 150.0,
         "variation": 50.0,
         "noise": 5.0,
         "period": 40.0,
         "min_value": 50.0,
         "max_value": 300.0
       }
     },
     {
       "folder": "Building_A",
       "subfolder": "Basement",
       "zone": "Parking",
       "prefix": "Vehicle",
       "model": "occupancy",
       "count": 1,
       "unit": "vehicles",
       "config": {
         "base": 25.0,
         "variation": 15.0,
         "noise": 1.0,
         "period": 180.0,
         "min_value": 0.0,
         "max_value": 100.0
       }
     }
   ]
 }'::jsonb,
 '{"description": "Multi-story commercial building with HVAC, lighting, and energy monitoring across zones", "sensorTypes": ["temperature", "pressure", "occupancy", "illuminance", "power", "flow"], "totalSensors": 24}'::jsonb
)
ON CONFLICT (profile_name, protocol) DO NOTHING;

-- Log migration
DO $$
BEGIN
  RAISE NOTICE 'Successfully added OPC UA profiles';
  RAISE NOTICE 'Profiles: factory (26 sensors), test (2 sensors), workshop (7 sensors), smart-building (24 sensors)';
  RAISE NOTICE 'These profiles can now be selected from the OPC UA web GUI at http://localhost:5002';
END $$;
