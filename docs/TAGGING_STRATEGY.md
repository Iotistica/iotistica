# Docker Image Tagging Strategy

## Overview

This document explains the two-stage tagging strategy for Docker images in the Iotistic platform: **CI Stage** (automatic builds) and **Release Stage** (manual semantic versioning).

## Architecture Philosophy

**Key Principle**: Build once, tag multiple times

- **CI workflows** build images on every commit to service directories
- **Release workflow** reuses existing CI-built images, just adding release tags
- No duplicate builds = faster releases, lower costs, guaranteed consistency

## Two-Stage Process

### Stage 1: Continuous Integration (CI)

**Trigger**: Automatic on push to service directories

**Workflows**:
- `.github/workflows/build-modbus-sim-ci.yml` (Modbus simulator)
- `.github/workflows/build-comap-sim-ci.yml` (COMAP generator simulator)
- `.github/workflows/build-mqtt-exporter.yml` (MQTT exporter)
- Individual service CI workflows (future: API, Dashboard, Agent, etc.)

**Path-based triggers**:
```yaml
on:
  push:
    paths:
      - 'sensors/modbus-simulator/**'
      - '.github/workflows/build-modbus-sim-ci.yml'
```

**Tags created** (3 tags per build):
```bash
iotistic/modbus-simulator:latest          # Always latest build
iotistic/modbus-simulator:0.1.5           # From package.json version
iotistic/modbus-simulator:a1b2c3d          # Git commit SHA (short)
```

**Example CI flow**:
```
1. Developer pushes code to sensors/modbus-simulator/
2. CI workflow triggers automatically
3. Tests run (unit, integration)
4. Multi-arch build (amd64, arm64, arm/v7)
5. Push 3 tags to Docker Hub
6. Trigger integration tests with new version
```

**Benefits**:
- Fast feedback loop (5-10 minutes)
- Every commit is buildable and testable
- SHA tags enable precise rollbacks
- Version tags track package.json for semantic meaning

### Stage 2: Release (Manual)

**Trigger**: Manual tag creation with semantic versioning

**Workflow**: `.github/workflows/release.yml`

**Tag format**: `v1.2.3` (semantic versioning)

**Process**:
```bash
# Developer creates release tag
git tag v1.2.3
git push origin v1.2.3

# Release workflow:
1. Validates tag format (must be v*.*.*)
2. Reads service versions from package.json files
3. Verifies CI-built images exist on Docker Hub
4. Pulls existing images (e.g., iotistic/api:2.5.1)
5. Retags with release version (iotistic/api:v1.2.3)
6. Pushes release tags
7. Creates GitHub Release with changelog
```

**Tags created**:
```bash
# Release workflow adds ONE new tag to existing images
iotistic/api:v1.2.3
iotistic/dashboard:v1.2.3
iotistic/mqtt-exporter:v1.2.3
```

**Core services included**:
- **API**: Device management, MQTT ACLs, Neo4j Digital Twin
- **Dashboard**: React admin panel, real-time monitoring
- **MQTT Exporter**: Metrics collection for Prometheus

**Supporting services excluded** (have independent CI):
- **Agent**: Edge device orchestrator (separate versioning)
- **Simulators**: Testing tools (not deployed to production)
- **Billing**: SaaS-only, separate deployment cycle
- **Housekeeper**: Internal service, not customer-facing

## Tag Naming Conventions

### CI Stage Tags

| Tag Type | Format | Example | Purpose |
|----------|--------|---------|---------|
| Latest | `<service>:latest` | `modbus-simulator:latest` | Always points to most recent build |
| Version | `<service>:<version>` | `modbus-simulator:0.1.5` | Semantic version from package.json |
| SHA | `<service>:<sha>` | `modbus-simulator:a1b2c3d` | Exact commit (7-char short SHA) |

### Release Stage Tags

| Tag Type | Format | Example | Purpose |
|----------|--------|---------|---------|
| Release | `<service>:v<major>.<minor>.<patch>` | `api:v1.2.3` | Official production release |

### Tag Validation Rules

**CI Tags**:
- Version must match `^[0-9]+\.[0-9]+\.[0-9]+$` (e.g., 0.1.5)
- Extracted from `package.json` `version` field
- SHA must be 7-character git short hash

**Release Tags**:
- Must start with `v` prefix
- Must match `^v[0-9]+\.[0-9]+\.[0-9]+$` (e.g., v1.2.3)
- Workflow fails if format invalid

## Service Categorization

### Core Services (Unified Releases)

**Included in release workflow** - customer-facing, deployed together:

| Service | Docker Image | Repository Path | Description |
|---------|--------------|-----------------|-------------|
| API | `iotistic/api` | `api/` | Device management, MQTT ACLs, Neo4j Digital Twin |
| Dashboard | `iotistic/dashboard` | `dashboard/` | React UI, real-time monitoring, Digital Twin viewer |
| MQTT Exporter | `iotistic/mqtt-exporter` | `mqtt-exporter/` | Metrics collection for Prometheus |

**Why these?**
- Customer-facing services
- Deploy together in Kubernetes (per-customer namespace)
- Share semantic version for marketing clarity
- Single release = coordinated feature updates

### Supporting Services (Independent CI)

**NOT in release workflow** - separate versioning, different deployment schedules:

| Service | Docker Image | CI Workflow | Why Separate |
|---------|--------------|-------------|--------------|
| Agent | `iotistic/agent` | `build-agent-ci.yml` | Edge device orchestrator, deployed to Raspberry Pi/x86_64, different release cycle |
| Modbus Simulator | `iotistic/modbus-simulator` | `build-modbus-sim-ci.yml` | Testing tool, not deployed to production |
| COMAP Simulator | `iotistic/comap-simulator` | `build-comap-sim-ci.yml` | Testing tool, E2E tests only |
| Billing | `iotistic/billing` | TBD | SaaS-only, separate namespace, different deployment schedule |
| Housekeeper | `iotistic/housekeeper` | TBD | Internal service, not customer-facing |
| VPN Server | `iotistic/vpn-server` | TBD | Global service (one instance for all customers) |

## Deployment Workflows

### Using CI Tags (Development/Staging)

**Scenario**: Testing latest builds before release

```yaml
# docker-compose.dev.yml
services:
  api:
    image: iotistic/api:latest  # Latest CI build
  dashboard:
    image: iotistic/dashboard:2.5.1  # Specific version
  mqtt-exporter:
    image: iotistic/mqtt-exporter:a1b2c3d  # Exact commit
```

**Benefits**:
- Test latest features immediately
- Pin specific commits for debugging
- Rollback by changing SHA tag

### Using Release Tags (Production)

**Scenario**: Production deployment with semantic versioning

```yaml
# Kubernetes deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  template:
    spec:
      containers:
      - name: api
        image: iotistic/api:v1.2.3  # Release version
```

```bash
# Update to new release
kubectl set image deployment/api api=iotistic/api:v1.2.3
kubectl set image deployment/dashboard dashboard=iotistic/dashboard:v1.2.3
kubectl set image deployment/mqtt-exporter mqtt-exporter=iotistic/mqtt-exporter:v1.2.3
```

**Benefits**:
- Clear semantic versioning for customers
- All core services use same release tag
- Easy rollback: `kubectl set image ... :v1.2.2`

## Practical Examples

### Example 1: Feature Development

**Scenario**: Develop new dashboard feature

```bash
# 1. Developer commits code
git add dashboard/src/components/NewFeature.tsx
git commit -m "Add new feature to dashboard"
git push origin main

# 2. CI workflow triggers automatically
# - Builds dashboard (takes 5 min)
# - Tags: dashboard:latest, dashboard:2.5.2, dashboard:b3c4d5e
# - Runs integration tests

# 3. Test on staging
kubectl set image deployment/dashboard dashboard=iotistic/dashboard:2.5.2 -n staging

# 4. Ready for release? Create tag
git tag v1.3.0
git push origin v1.3.0

# 5. Release workflow:
# - Pulls iotistic/dashboard:2.5.2 (already built)
# - Retags as iotistic/dashboard:v1.3.0
# - Creates GitHub Release
```

**Timeline**:
- CI build: 5 minutes (once)
- Release: 2 minutes (just retagging)
- Total: 7 minutes vs 12+ with rebuild

### Example 2: Hotfix

**Scenario**: Critical bug in production API

```bash
# 1. Fix on hotfix branch
git checkout -b hotfix/critical-bug
# ... fix code ...
git commit -m "Fix critical bug in API"
git push origin hotfix/critical-bug

# 2. CI builds API automatically
# Tags: api:latest, api:2.5.2-hotfix, api:c5d6e7f

# 3. Test hotfix
kubectl set image deployment/api api=iotistic/api:2.5.2-hotfix -n staging

# 4. Merge and release
git checkout main
git merge hotfix/critical-bug
git tag v1.2.4
git push origin v1.2.4

# 5. Deploy to production
kubectl set image deployment/api api=iotistic/api:v1.2.4
```

### Example 3: Rollback

**Scenario**: Release v1.3.0 has issue, rollback to v1.2.3

```bash
# Option 1: Use previous release tag
kubectl set image deployment/api api=iotistic/api:v1.2.3
kubectl set image deployment/dashboard dashboard=iotistic/dashboard:v1.2.3

# Option 2: Use specific SHA if needed
kubectl set image deployment/api api=iotistic/api:a1b2c3d

# Option 3: Use version tag
kubectl set image deployment/api api=iotistic/api:2.5.1
```

**All three options work because CI builds are preserved!**

## Benefits of This Strategy

### 1. **No Duplicate Builds**
- CI builds once per commit
- Release just retags (2 minutes vs 10+ minutes)
- Lower Docker Hub storage costs
- Faster releases

### 2. **Guaranteed Consistency**
- Release uses exact same image that passed tests
- No "works in CI but fails in release" surprises
- SHA tags enable forensic debugging

### 3. **Flexible Versioning**
- Development: Use `:latest` or `:version` tags
- Staging: Test specific commits with `:sha` tags
- Production: Semantic `:v1.2.3` tags for clarity

### 4. **Fast Rollbacks**
- Multiple tag types preserved (latest, version, SHA, release)
- Roll back to previous release: `kubectl set image ... :v1.2.2`
- Roll back to specific commit: `kubectl set image ... :a1b2c3d`
- Roll back to version: `kubectl set image ... :2.5.1`

### 5. **Clear Separation**
- **CI**: Auto-build everything, fast feedback
- **Release**: Manual control, marketing-friendly versions
- **Core services**: Unified release for customer deployments
- **Supporting services**: Independent versioning

## Troubleshooting

### Issue: Release workflow fails with "image not found"

**Cause**: CI workflow didn't run or failed

**Solution**:
```bash
# Check CI workflow status
gh run list --workflow=build-api-ci.yml

# Manually trigger CI build
gh workflow run build-api-ci.yml

# Wait for CI to complete, then retry release
git push origin v1.2.3 --force
```

### Issue: Wrong version in release

**Cause**: package.json version doesn't match intended release

**Solution**:
```bash
# Update package.json first
cd api
npm version 2.5.3
git commit -am "Bump API version to 2.5.3"
git push

# Wait for CI build, then create release tag
git tag v1.2.3
git push origin v1.2.3
```

### Issue: Release tag format invalid

**Cause**: Tag doesn't match `v*.*.*` pattern

**Solution**:
```bash
# Delete invalid tag
git tag -d 1.2.3
git push origin :refs/tags/1.2.3

# Create correct tag with 'v' prefix
git tag v1.2.3
git push origin v1.2.3
```

## Migration Path

### Current State (Legacy)
- Release workflow builds from source (10+ minutes)
- Conditional builds based on git diff
- Rebuilds even if code unchanged

### Target State (New Strategy)
- CI workflows build on every commit
- Release workflow only retags (2 minutes)
- No rebuilds, just tag management

### Migration Steps

1. **Add CI workflows for core services**:
   - Create `build-api-ci.yml`
   - Create `build-dashboard-ci.yml`
   - Copy pattern from `build-modbus-sim-ci.yml`

2. **Refactor release workflow** (DONE):
   - Remove build jobs
   - Add retag jobs
   - Update to use 3 core services only

3. **Update deployment docs**:
   - Document CI vs Release tags
   - Add examples for each environment
   - Update Kubernetes manifests

4. **Test with release candidate**:
   - Create `v1.0.0-rc1` tag
   - Verify retagging works
   - Test deployment with new tags

## References

- [CI Workflow Example](../.github/workflows/build-modbus-sim-ci.yml)
- [Release Workflow](../.github/workflows/release.yml)
- [Docker Multi-Platform Builds](https://docs.docker.com/build/building/multi-platform/)
- [Semantic Versioning](https://semver.org/)
- [GitHub Actions Workflow Syntax](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions)

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2025-01-15 | Initial tagging strategy documentation |
| 1.1 | 2025-01-15 | Added service categorization and practical examples |
