# TimescaleDB with CloudNativePG

This Dockerfile builds a PostgreSQL 17 image with TimescaleDB extension, compatible with the CloudNativePG Kubernetes operator.

## What's Included

- **PostgreSQL 17** - CloudNativePG base image (Debian 12 Bookworm)
- **TimescaleDB 2.x** - Time-series database extension

## What's NOT Included

This image does **not** include vector search extensions (pgvector, pgvectorscale). It's optimized for TimescaleDB time-series functionality only.

## Why Not Use timescaledb-ha Image?

The official `timescale/timescaledb-ha` image is designed for Patroni-based clustering and is incompatible with CloudNativePG's operator-driven model due to:

- Custom data directory paths (`/home/postgres/pgdata` vs `/var/lib/postgresql/data`)
- Patroni-specific entrypoint scripts
- Root-level initialization requirements

CloudNativePG requires PostgreSQL official image patterns with standard paths and postgres-user ownership from startup.

## Building the Image

```bash
cd timescaledb

# Build for your registry
docker build -t YOUR_REGISTRY/timescaledb-cnpg:pg17 .

# Push to registry
docker push YOUR_REGISTRY/timescaledb-cnpg:pg17
```

## Deploying with CloudNativePG

### 1. Create ImageCatalog

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: ImageCatalog
metadata:
  name: timescaledb
  namespace: default
spec:
  images:
  - major: 17
    image: YOUR_REGISTRY/timescaledb-cnpg:pg17
```

### 2. Deploy Cluster

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: timescaledb-cluster
  namespace: default
spec:
  instances: 3
  imageCatalogRef:
    apiGroup: postgresql.cnpg.io
    kind: ImageCatalog
    name: timescaledb
    major: 17
  
  storage:
    size: 10Gi
  
  postgresql:
    shared_preload_libraries:
      - timescaledb
    parameters:
      work_mem: '128MB'
      maintenance_work_mem: '1GB'
      shared_buffers: '512MB'
      effective_cache_size: '1536MB'
      max_connections: '100'
      timescaledb.max_background_workers: '4'
  
  bootstrap:
    initdb:
      database: app
      owner: app
      postInitApplicationSQL:
        - CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
```

## Key Configuration Notes

### Required: shared_preload_libraries

TimescaleDB **must** be loaded at PostgreSQL startup:

```yaml
shared_preload_libraries:
  - timescaledb
```

CloudNativePG won't allow TimescaleDB to load dynamically after startup.

### Recommended Memory Settings

For production deployments, tune based on pod size:

**1-2GB pods (edge nodes):**
- `shared_buffers: 256MB`
- `work_mem: 64MB`
- `maintenance_work_mem: 512MB`

**2-4GB pods (standard nodes):**
- `shared_buffers: 512MB-1GB`
- `work_mem: 128-256MB`
- `maintenance_work_mem: 1-2GB`

**4GB+ pods (larger workloads):**
- Tune based on actual query patterns and dataset size

### TimescaleDB-Specific Parameters

```yaml
timescaledb.max_background_workers: '4'
```

Controls background job concurrency for compression and continuous aggregates.

## Verifying the Deployment

Connect to the primary instance:

```bash
kubectl exec -it timescaledb-cluster-1 -n default -- \
  psql -U postgres -d app
```

Verify TimescaleDB is installed:

```sql
-- Check extension version
SELECT extname, extversion FROM pg_extension 
WHERE extname = 'timescaledb';

-- Test hypertable creation
CREATE TABLE IF NOT EXISTS metrics (
  time TIMESTAMPTZ NOT NULL, 
  value DOUBLE PRECISION
);
SELECT create_hypertable('metrics', 'time', if_not_exists => TRUE);

-- Confirm operational
SELECT 'TimescaleDB operational!' as status;
```

## Architecture Compatibility

This image follows CloudNativePG requirements:

- ✅ Standard PostgreSQL data directory paths
- ✅ Init container-based bootstrapping
- ✅ postgres-user (UID 26) ownership from startup
- ✅ No custom entrypoint scripts
- ✅ CloudNativePG operator reconciliation compatible

## Production Considerations

### Backup Configuration

Configure CloudNativePG backup policies:

```yaml
spec:
  backup:
    barmanObjectStore:
      destinationPath: s3://your-bucket/timescaledb-backups
      s3Credentials:
        accessKeyId:
          name: backup-credentials
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: backup-credentials
          key: SECRET_ACCESS_KEY
      wal:
        compression: gzip
    retentionPolicy: "30d"
```

### Monitoring

Enable Prometheus metrics:

```yaml
spec:
  monitoring:
    enablePodMonitor: true
```

### Connection Pooling

For AI/IoT workloads with bursty traffic:

```yaml
spec:
  pooler:
    enabled: true
    type: rw
    instances: 2
    pgbouncer:
      poolMode: transaction
      parameters:
        max_client_conn: "1000"
        default_pool_size: "25"
```

## Resource Limits

Always define explicit resource limits in production:

```yaml
spec:
  resources:
    requests:
      memory: "2Gi"
      cpu: "1"
    limits:
      memory: "4Gi"
      cpu: "2"
```

Then tune PostgreSQL parameters proportionally to pod size.

## Related Documentation

- [CloudNativePG Documentation](https://cloudnative-pg.io/documentation/)
- [TimescaleDB Best Practices](https://docs.timescale.com/timescaledb/latest/how-to-guides/)
- [Tiger Data Article](https://www.tigerdata.com/blog/deploying-timescaledb-vector-search-cloudnativepg-kubernetes-operator)

## Troubleshooting

### Extensions Not Loading

Verify shared_preload_libraries is set before cluster initialization. Cannot be changed after cluster creation without recreating the cluster.

### Memory Issues

Check pod memory usage:

```bash
kubectl top pods -n default | grep timescaledb
```

Calculate max concurrent operations:
```
(Total RAM - shared_buffers) / work_mem = Max operations
```

Monitor for OOM kills:
```bash
kubectl get events -n default | grep OOM
```

### Storage Performance

TimescaleDB compression moves data from hot to cold storage automatically. Recent uncompressed data benefits from fast storage (SSD), while compressed historical chunks tolerate higher latency.

## License

This Dockerfile is part of the Iotistic IoT Platform and follows the project's license.
