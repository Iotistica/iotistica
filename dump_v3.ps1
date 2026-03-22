$ErrorActionPreference = "Stop"

# Step 1: Build the exclude flags and run pg_dump inside the container
$script = @'
EXCLUDES=$(psql -U postgres -d iotistic -Atc "
SELECT '--exclude-table=' || viewname FROM pg_views WHERE schemaname = 'public'
UNION ALL
SELECT '--exclude-table=' || matviewname FROM pg_matviews WHERE schemaname = 'public'
" | tr "\n" " ")

pg_dump -U postgres -d iotistic --schema-only --no-comments --no-owner --no-privileges --schema=public \
  $EXCLUDES \
  -f /tmp/schema_v3.sql 2>/tmp/schema_v3_err.txt

echo "exit:$?" > /tmp/schema_v3_status.txt
wc -l /tmp/schema_v3.sql >> /tmp/schema_v3_status.txt
grep -c "CREATE VIEW\|MATERIALIZED VIEW" /tmp/schema_v3.sql >> /tmp/schema_v3_status.txt || echo "0" >> /tmp/schema_v3_status.txt
'@

docker exec iotistic-postgres bash -c $script

# Step 2: Copy results to Windows
docker cp iotistic-postgres:/tmp/schema_v3_status.txt "C:\Users\Dan\iotistica\schema_v3_status.txt"
docker cp iotistic-postgres:/tmp/schema_v3_err.txt "C:\Users\Dan\iotistica\schema_v3_err.txt"
docker cp iotistica-postgres:/tmp/schema_v3.sql "C:\Users\Dan\iotistica\api\database\migrations\001_dump_raw.sql"

Write-Host "=== Status ==="
Get-Content "C:\Users\Dan\iotistica\schema_v3_status.txt"
Write-Host "=== Errors ==="
Get-Content "C:\Users\Dan\iotistica\schema_v3_err.txt"
