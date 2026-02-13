-- Complete OPC UA Test Profile
-- Delete old one first
DELETE FROM profile_configs WHERE profile_name = 'TestFactory' AND protocol = 'opcua';

-- Insert with correct format (data_points as direct array, not nested in sensors)
INSERT INTO profile_configs (profile_name, protocol, data_points, metadata, created_at, updated_at) 
VALUES (
  'TestFactory', 
  'opcua', 
  '[
    {
      "folder": "Temperature",
      "prefix": "Sensor",
      "model": "temperature",
      "count": 3,
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
      "count": 2,
      "unit": "mbar",
      "config": {
        "base": 1000.0,
        "variation": 50.0,
        "noise": 2.0,
        "period": 45.0,
        "min_value": 0.0,
        "max_value": 2000.0
      }
    },
    {
      "folder": "Flow",
      "prefix": "Meter",
      "model": "flow",
      "count": 2,
      "unit": "L/min",
      "config": {
        "base": 50.0,
        "variation": 30.0,
        "noise": 2.0,
        "period": 20.0,
        "min_value": 0.0,
        "max_value": 100.0
      }
    }
  ]'::jsonb, 
  '{
    "description": "Test factory profile - loaded from API",
    "sensorTypes": ["temperature", "pressure", "flow"],
    "totalSensors": 7
  }'::jsonb, 
  NOW(), 
  NOW()
);

-- Verify it was inserted correctly
SELECT 
  profile_name, 
  protocol, 
  jsonb_array_length(data_points) as sensor_groups,
  metadata->>'description' as description
FROM profile_configs 
WHERE profile_name = 'TestFactory' AND protocol = 'opcua';
