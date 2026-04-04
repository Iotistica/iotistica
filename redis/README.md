# Redis OOM Test Scripts

This folder contains helper scripts for forcing Redis into memory pressure so you can verify API fallback behavior such as disk spooling and circuit-breaker handling.

## Scripts

- `test-redis-oom.ps1`
  - Targets the local Docker Compose environment.
- `test-redis-oom-k8s.ps1`
  - Targets a Redis deployment running in Kubernetes.

## Local Docker Compose

Start the OOM fill test:

```powershell
.\redis\test-redis-oom.ps1 -Mode start -ShowApiLogs
```

Check Redis memory status only:

```powershell
.\redis\test-redis-oom.ps1 -Mode status
```

Restore normal Redis settings and delete test keys:

```powershell
.\redis\test-redis-oom.ps1 -Mode restore -ShowApiLogs
```

Example with custom limits:

```powershell
.\redis\test-redis-oom.ps1 -Mode start -OomMaxMemoryMb 64 -FillKeys 800 -PayloadBytes 32768
```

## Kubernetes

Run against the default `demo` namespace:

```powershell
.\redis\test-redis-oom-k8s.ps1 -Mode start -Namespace demo -ShowApiLogs
```

Check Redis status only:

```powershell
.\redis\test-redis-oom-k8s.ps1 -Mode status -Namespace demo
```

Restore Redis memory settings and delete OOM test keys:

```powershell
.\redis\test-redis-oom-k8s.ps1 -Mode restore -Namespace demo -ShowApiLogs
```

Example with explicit deployment names:

```powershell
.\redis\test-redis-oom-k8s.ps1 -Mode start -Namespace demo -RedisDeployment demo-iotistica-app-redis -ApiDeployment demo-iotistica-api -ShowApiLogs
```

Example with explicit Redis secret name:

```powershell
.\redis\test-redis-oom-k8s.ps1 -Mode start -Namespace demo -RedisSecretName demo-iotistica-app-redis-auth -ShowApiLogs
```

## What The Scripts Do

In `start` mode the scripts:

1. Delete old `oom:test:*` keys.
2. Lower Redis `maxmemory` to trigger pressure quickly.
3. Fill Redis with large test keys until an OOM response occurs.
4. Optionally show recent API logs so you can confirm spool/circuit-breaker behavior.

In `restore` mode the scripts:

1. Delete the `oom:test:*` keys.
2. Restore Redis `maxmemory` to the normal configured level.
3. Optionally show recent API logs.

## Notes

- The Kubernetes script uses `kubectl exec` against the Redis deployment, not Docker.
- If Redis auth is enabled in Kubernetes, the script tries to read the password from the Redis secret automatically.
- The demo namespace currently uses `noeviction`, which is the correct policy for exercising spool fallback behavior.