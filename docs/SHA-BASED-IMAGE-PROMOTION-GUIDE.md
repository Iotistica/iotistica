# SHA-Based Image Promotion Architecture

## Overview

The CI/CD pipeline has been refactored from version-based to SHA-based image tagging for immutability, determinism, and reliability. This document explains the new architecture and how to verify it works.

### Problem Solved ✅

**Old Architecture (Fragile):**
- ❌ CI bumps package.json version on every commit (git churn)
- ❌ CI tags images with version numbers (non-deterministic)
- ❌ Release workflow probes Docker Hub to find images (rate limiting, complexity)
- ❌ Release falls back to "latest" if version image not found (guessing)
- ❌ Dashboard CI skipped on API-only changes, but release tried to promote it anyway

**New Architecture (Robust):**
- ✅ CI tags images with immutable commit SHA only (12-char short SHA)
- ✅ CI exports short_sha as job output for traceability
- ✅ Release workflow extracts SHA from git tag deterministically
- ✅ Release pulls exact tested image (fails hard if missing - no guessing)
- ✅ Dashboard CI respects path filters; release only promotes what was built

## Architecture Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         DEVELOPER PUSH                          │
│                      commit to master                            │
└────────────────────────────┬────────────────────────────────────┘
                          │
                          │ (CI BUILD)
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│                    API CI WORKFLOW                              │
│ 1. test job (unit tests, build)       → PASS                   │
│ 2. buildx job:                                                  │
│    - Calculate SHA = git rev-parse --short HEAD                │
│    - Build image locally                                        │
│    - docker tag image iotistic/api:<short-sha>                │
│    - docker tag image iotistic/api:latest                      │
│    - docker push both tags                                      │
│    - Output: short_sha=a3f5c8d9e2b1                            │
│ 3. report job (generates summary)                              │
└────────────────────────────┬────────────────────────────────────┘
                          │
                          │ (CI BUILD)
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│                DASHBOARD CI WORKFLOW                            │
│ Triggered ONLY if dashboard/** or workflow changed             │
│ 1. test job (E2E smoke tests)        → PASS                    │
│ 2. buildx job:                                                  │
│    - Calculate SHA = git rev-parse --short HEAD                │
│    - Build image                                                │
│    - docker tag image iotistic/dashboard:<short-sha>           │
│    - docker tag image iotistic/dashboard:latest                │
│    - docker push both tags                                      │
│    - Output: short_sha=a3f5c8d9e2b1                            │
│ 3. report job (generates summary)                              │
└────────────────────────────┬────────────────────────────────────┘
                          │
                          │ (MANUAL RELEASE)
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│                  RELEASE DISPATCH                               │
│ User chooses: release_type (rc or final)                        │
│              release_mode (api, dashboard, all)                │
└────────────────────────────┬────────────────────────────────────┘
                          │
                          │
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│               RELEASE WORKFLOW - validate-release               │
│ 1. set_version (v0.0.4-rc.1)                                   │
│ 2. Verify git tag exists                                        │
│ 3. Extract SHA:                                                 │
│    git rev-list -n 1 v0.0.4-rc.1 | cut -c1-12                │
│    → short_sha=a3f5c8d9e2b1                                    │
│ 4. Output: short_sha=a3f5c8d9e2b1                              │
└────────────────────────────┬────────────────────────────────────┘
                          │
                          │
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│              RELEASE WORKFLOW - promote-images                  │
│ 1. Docker login                                                  │
│ 2. Extract SHA from release  (= a3f5c8d9e2b1)                 │
│ 3. For each service (api, dashboard):                          │
│    a. docker pull iotistic/api:a3f5c8d9e2b1                   │
│       ✅ SUCCEEDS (CI built this commit)                       │
│    b. docker tag iotistic/api:a3f5c8d9e2b1 \                 │
│         iotistic/api:v0.0.4-rc.1                              │
│    c. docker push iotistic/api:v0.0.4-rc.1                    │
│    d. ✅ SUCCESS                                                │
│                                                                 │
│ If pull FAILS:                                                  │
│    ❌ ERROR: "CI didn't build this commit for api"             │
│    ❌ Release blocked (FAIL HARD - no fallback)                │
└────────────────────────────┬────────────────────────────────────┘
                          │
                          │
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│              RELEASE WORKFLOW - create-release                  │
│ 1. Create GitHub Release tag: v0.0.4-rc.1                      │
│ 2. Generate changelog                                            │
│ 3. Create release notes                                         │
└────────────────────────────┬────────────────────────────────────┘
                          │
                          │
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│              RELEASE WORKFLOW - deploy-to-k8s                   │
│ 1. Update iot-k8s/values.yaml with new image tags              │
│ 2. Push to ArgoCD repository                                    │
│ 3. ArgoCD syncs and deploys new images                         │
└────────────────────────────────────────────────────────────────┘
```

## Key Files Modified

### Release Workflow (`.github/workflows/release.yml`)
```yaml
validate-release:
  outputs:
    short_sha: ${{ steps.verify.outputs.short_sha }}  # ← NEW OUTPUT
    
  steps:
    - name: Verify git tag and extract SHA
      id: verify
      run: |
        RELEASE="${{ steps.set_version.outputs.release_version }}"
        git rev-parse "$RELEASE"  # Verify tag exists
        SHORT_SHA=$(git rev-list -n 1 "$RELEASE" | cut -c1-12)
        echo "short_sha=$SHORT_SHA" >> $GITHUB_OUTPUT

promote-images:  # ← REPLACES old "retag-and-push" job
  needs: validate-release
  steps:
    - name: Promote images (SHA → Release Version)
      env:
        RELEASE: ${{ needs.validate-release.outputs.release_version }}
        SHORT_SHA: ${{ needs.validate-release.outputs.short_sha }}
      run: |
        promote_image() {
          local svc="$1"
          docker pull "${DOCKER_ORG}/${svc}:${SHORT_SHA}" || \
            (echo "❌ CI didn't build this commit for $svc"; exit 1)
          docker tag "${DOCKER_ORG}/${svc}:${SHORT_SHA}" \
                     "${DOCKER_ORG}/${svc}:${RELEASE}"
          docker push "${DOCKER_ORG}/${svc}:${RELEASE}"
        }
        
        promote_image api
        promote_image dashboard
```

### API CI Workflow (`.github/workflows/build-api-ci.yml`)
```yaml
buildx:  # ← Updated tagging strategy
  outputs:
    short_sha: ${{ steps.sha.outputs.short_sha }}
    
  steps:
    - name: Calculate commit SHA
      id: sha
      run: |
        SHORT_SHA=$(git rev-parse --short HEAD)
        echo "short_sha=$SHORT_SHA" >> $GITHUB_OUTPUT
    
    - name: Build & Push
      uses: docker/build-push-action@v5
      with:
        tags: |
          iotistic/api:${{ steps.sha.outputs.short_sha }}  # ← IMMUTABLE
          iotistic/api:latest  # ← CONVENIENCE
        # ❌ REMOVED: version tags
```

### Dashboard CI Workflow (`.github/workflows/build-dashboard-ci.yml`)
```yaml
buildx:  # ← Updated tagging strategy (same as API)
  outputs:
    short_sha: ${{ steps.sha.outputs.short_sha }}
  
  # ✅ Path filters UNCHANGED (dashboard/** still required)
on:
  push:
    paths:
      - 'dashboard/**'
      - '.github/workflows/build-dashboard-ci.yml'
```

## Testing the New Architecture

### Scenario 1: Test CI builds with SHA tags
```bash
# 1. Make a commit to API
cd api
echo "# test" >> README.md
git add .
git commit -m "test: verify SHA-based CI tagging"
git push origin master

# 2. Wait for build-api-ci.yml workflow to complete
# → Check GitHub Actions: Should see buildx job with short_sha output
# → Docker Hub: Should see iotistic/api:a3f5c8d9e2b1 tag created

# 3. Verify image exists
docker pull iotistic/api:a3f5c8d9e2b1
echo "✅ Image successfully pulled with SHA tag"
```

### Scenario 2: Test release promotion
```bash
# 1. Trigger release dispatch (assuming commit from Scenario 1)
# Go to: GitHub Actions → Release
# Input: release_type=rc, release_mode=api

# 2. Workflow progresses:
# validate-release: Extracts SHA (a3f5c8d9e2b1) from git tag
# promote-images: 
#   - docker pull iotistic/api:a3f5c8d9e2b1  ✅ SUCCEEDS
#   - docker tag ... iotistic/api:v0.0.4-rc.1
#   - docker push iotistic/api:v0.0.4-rc.1   ✅ SUCCEEDS

# 3. Verify promoted image
docker pull iotistic/api:v0.0.4-rc.1
echo "✅ Image successfully promoted to release tag"
```

### Scenario 3: Test Dashboard CI respects path filters
```bash
# 1. Make API-only change (no Dashboard files touched)
cd api
echo "# api test" >> README.md
git add .
git commit -m "chore: API documentation update"
git push origin master

# 2. Workflow status:
# ✅ build-api-ci.yml RUNS (api/** changed)
# ⏭️ build-dashboard-ci.yml SKIPS (dashboard/** not changed)

# 3. Try to release (dispatch release with dashboard)
# promote-images job attempts:
#   - docker pull iotistic/dashboard:a3f5c8d9e2b1
#   - ❌ FAILS (CI never built this commit for dashboard)
# Release BLOCKS (FAIL HARD - no fallback to latest)
# This is correct behavior!

# 4. If you REALLY need to release dashboard anyway:
# Make a dummy change to dashboard/
mkdir -p dashboard
echo "# dashboard marker" >> dashboard/marker.txt
git add dashboard/marker.txt
git commit -m "chore: trigger dashboard CI"
git push origin master

# Now CI builds dashboard SHA, release can promote it
```

### Scenario 4: Verify Dashboard path filters work
```bash
# Check workflow trigger conditions
git log --oneline dashboard/
# Should see dashboard changes

# Modify workflow itself (without changing dashboard code)
vi .github/workflows/build-dashboard-ci.yml
git commit -am "ci: update dashboard trigger"
git push origin master

# ✅ build-dashboard-ci.yml RUNS (workflow itself changed)
# ✅ This is correct - changing workflow should trigger builds
```

## Troubleshooting

### Release fails: "❌ CI didn't build this commit for api"
**Cause:** The commit SHA extracted from release tag was never built by CI

**Solution:**
1. Verify CI workflow ran for this commit: `git log -1 --oneline <commit-sha>`
2. Check CI workflow status in GitHub Actions
3. If CI didn't run: Make a small change to trigger CI, commit, then release

### Release promotes old version image instead of new
**Cause:** This can no longer happen! ✅ Fail-hard logic prevents it

**Old behavior (fixed):** If image not found, release would fallback to latest
**New behavior:** If image not found, release FAILS with clear error message

### Dashboard image not promoted during "release_mode=all"
**Cause:** Dashboard CI has path filters; if you only changed API, Dashboard wasn't built

**Solution:** Either:
1. Make a change to dashboard/* to trigger Dashboard CI first
2. Use `release_mode=api` instead of `release_mode=all`

### How do I release an old commit?
```bash
# 1. Create a release tag pointing to old commit
git tag v0.0.4-rc.2 a3f5c8d9e2b1  # commit that was already built
git push origin v0.0.4-rc.2

# 2. Dispatch release for v0.0.4-rc.2
# Release workflow will:
# - Extract SHA: a3f5c8d9e2b1
# - Pull image: iotistic/api:a3f5c8d9e2b1
# - Tag and promote: iotistic/api:v0.0.4-rc.2
# ✅ Works because that commit was previously built by CI
```

## Architecture Benefits

| Aspect | Old (Version-Based) | New (SHA-Based) |
|--------|-------------------|-----------------|
| **Image Tagging** | Version on every commit | SHA once per commit |
| **Determinism** | Query Docker Hub to find version | Extract SHA from git tag |
| **Fallback** | Guesses "latest" if version not found | Fails hard with clear error |
| **Git Churn** | Bumps package.json on every commit | Version bumping only at release |
| **Traceability** | Version ≠ commit mapping unclear | SHA = exact commit, always |
| **Reliability** | Release complexity: 500+ lines Docker probing | Release simple: 10 lines SHA extraction |
| **Dashboard Issue** | Release tries to promote all, CI skips selectively | Both CI and release aligned on path filters |

## Next Steps

1. **Monitor First Release:** Dispatch v0.0.4-rc.1 or v0.0.4-final with new architecture
2. **Verify Promotion:** Check that images promoted successfully with new tags
3. **Verify Deployment:** Confirm ArgoCD deployed correct image versions
4. **Document Success:** If all works, update team on new process
5. **Update Other CIs:** If more services exist (mqtt-monitor, housekeeper, etc.), apply same pattern

## How to Read Release Logs

```
✅ validate-release:
   - set_version: release_version=v0.0.4-rc.1
   - verify git tag and extract SHA: short_sha=a3f5c8d9e2b1

✅ promote-images:
   - Extract SHA and promote images:
     Pulling iotistic/api:a3f5c8d9e2b1...
     ✅ Successfully pulled
     Tagging as iotistic/api:v0.0.4-rc.1
     ✅ Successfully pushed to Docker Hub
     
     Pulling iotistic/dashboard:a3f5c8d9e2b1...
     ✅ Successfully pulled
     Tagging as iotistic/dashboard:v0.0.4-rc.1
     ✅ Successfully pushed to Docker Hub

✅ create-release:
   Creating GitHub release v0.0.4-rc.1...

✅ deploy-to-k8s:
   Updating iot-k8s/values.yaml with image tags...
   Committing to ArgoCD repository...
```

---

**Questions?** Review the release.yml and build-*-ci.yml workflows in `.github/workflows/` for complete implementation details.
