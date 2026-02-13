-- Test OPC UA Profile for API loading
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
    }
  ]'::jsonb, 
  '{"description": "Test factory for API loading"}'::jsonb, 
  NOW(), 
  NOW()
) 
ON CONFLICT (profile_name, protocol) 
DO UPDATE SET 
  data_points = EXCLUDED.data_points, 
  metadata = EXCLUDED.metadata, 
  updated_at = NOW();
