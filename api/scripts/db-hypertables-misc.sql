SELECT
  hypertable_name,
  compression_enabled
FROM timescaledb_information.hypertables
WHERE hypertable_name = 'readings';


SELECT
  chunk_name,
  range_start,
  range_end,
  is_compressed
FROM timescaledb_information.chunks
WHERE hypertable_name = 'readings'
ORDER BY range_start;


SELECT
  chunk_name,
  range_start,
  range_end,
  is_compressed
FROM timescaledb_information.chunks
WHERE hypertable_name = 'device_logs'
ORDER BY range_start;



SELECT compress_chunk('_timescaledb_internal._hyper_100_147_chunk'::regclass);


SELECT compress_chunk('_timescaledb_internal._hyper_96_137_chunk'::regclass);


SELECT
  chunk_name,
  is_compressed
FROM timescaledb_information.chunks
WHERE chunk_name = '_hyper_100_147_chunk';



SELECT
    chunk_name,
    is_compressed,
    pg_size_pretty(pg_total_relation_size(('_timescaledb_internal.' || chunk_name)::regclass)) AS size
FROM timescaledb_information.chunks
WHERE hypertable_name = 'readings'
ORDER BY chunk_name;



SELECT remove_compression_policy('readings');


SELECT add_compression_policy(
    'readings',
    INTERVAL '1 day'
);






