-- Emergency script to create missing events partitions
-- Run this if you get "no partition of relation events found for row" error

-- Create partitions for today + next 30 days
SELECT create_events_partition((CURRENT_DATE + (i || ' days')::INTERVAL)::DATE) as result
FROM generate_series(0, 30) AS i;

-- Show created partitions
SELECT 
  tablename,
  TO_DATE(SUBSTRING(tablename FROM 'events_(.*)'), 'YYYY_MM_DD') as partition_date
FROM pg_tables 
WHERE schemaname = 'public' 
AND tablename LIKE 'events_%'
AND tablename ~ '^events_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
ORDER BY partition_date DESC
LIMIT 10;
