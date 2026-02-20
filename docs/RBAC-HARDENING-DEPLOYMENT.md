# RBAC Hardening & Kyverno Policies Deployment Guide

## ⚠️ CRITICAL: Kyverno is REQUIRED

The RBAC configuration in `iot-k8s-main/charts/iotistica-app/templates/rbac.yaml` defines safe permissions, but **Kyverno admission policies are REQUIRED** to enforce constraints that RBAC cannot.

**Without Kyverno**, the API retains a privilege escalation vector: it can create RoleBindings that reference `cluster-admin`.

## 📋 Deployment Order

1. **Install Kyverno** (admission controller framework)
2. **Deploy Kyverno ClusterPolicies** (security rules)
3. **Deploy API with hardened RBAC** (safe permissions)

## 🚀 Step 1: Install Kyverno

```bash
# Add Kyverno Helm repository
helm repo add kyverno https://kyverno.github.io/kyverno/
helm repo update

# Install Kyverno in kyverno namespace
helm install kyverno kyverno/kyverno \
  --namespace kyverno \
  --create-namespace \
  --set config.webhooks=[{"namespaceSelector":{"matchExpressions":[{"key":"kubernetes.io/metadata.name","operator":"NotIn","values":["kyverno"]}]}}]

# Wait for Kyverno to be ready
kubectl wait --for=condition=Ready pod -l app.kubernetes.io/name=kyverno -n kyverno --timeout=300s

# Verify installation
kubectl get pods -n kyverno
kubectl get validatingwebhookconfigurations | grep kyverno
```

## 🔐 Step 2: Deploy Kyverno ClusterPolicies

The policies are embedded in the RBAC template, but you can also apply them separately:

```bash
# Extract policies from the Helm chart
helm template iotistic ./iot-k8s-main/charts/iotistica-app -n billing \
  -f ./iot-k8s-main/charts/iotistica-app/values.yaml | \
  grep -A 500 "kind: ClusterPolicy" | \
  kubectl apply -f -

# OR apply the policies file directly
kubectl apply -f - << 'EOF'
---
# Policy 1: Restrict RoleBinding role references (CRITICAL)
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-fleet-namespace-rolebindings
  namespace: kyverno
spec:
  validationFailureAction: enforce
  rules:
  - name: only-fleet-namespace-manager-role
    match:
      resources:
        kinds:
        - RoleBinding
        selector:
          matchLabels:
            app.kubernetes.io/managed-by: iotistic-api
    validate:
      message: "RoleBindings created by API can only reference fleet-namespace-manager role"
      pattern:
        roleRef:
          apiGroup: rbac.authorization.k8s.io
          kind: ClusterRole
          name: iotistic-fleet-namespace-manager
  
  - name: prevent-cluster-admin-binding
    match:
      resources:
        kinds:
        - RoleBinding
    validate:
      message: "Binding cluster-admin role is forbidden"
      pattern:
        =(roleRef):
          X(name): "cluster-admin | system:masters | *admin*"

---
# Policy 2: Enforce namespace naming (fleet-*)
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-fleet-namespace-names
  namespace: kyverno
spec:
  validationFailureAction: enforce
  rules:
  - name: fleet-naming-pattern
    match:
      resources:
        kinds:
        - Namespace
        selector:
          matchLabels:
            app.kubernetes.io/managed-by: iotistic-api
    validate:
      message: "Fleet namespaces must match pattern 'fleet-*'"
      pattern:
        metadata:
          name: "fleet-*"

---
# Policy 3: Enforce pod security (no privileged containers)
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-privileged-containers
  namespace: kyverno
spec:
  validationFailureAction: enforce
  rules:
  - name: deny-privileged
    match:
      resources:
        kinds:
        - Pod
        - Deployment
    validate:
      message: "Privileged containers are not allowed"
      pattern:
        spec:
          containers:
          - securityContext:
              privileged: false
              runAsNonRoot: true
              allowPrivilegeEscalation: false

EOF

# Verify policies are active
kubectl get clusterpolicies
kubectl describe clusterpolicy restrict-fleet-namespace-rolebindings

# Check policy reports (audit trail)
kubectl get policyreport -A
```

## 🧪 Step 3: Test Policies (Before Production Deployment)

### Test 1: Verify RoleBinding restriction

```bash
# Create a test fleet namespace
kubectl create namespace fleet-test
kubectl label namespace fleet-test app.kubernetes.io/managed-by=iotistic-api

# Attempt to create a dangerous RoleBinding (should be DENIED)
kubectl create rolebinding dangerous-binding \
  --clusterrole=cluster-admin \
  --serviceaccount=default:default \
  -n fleet-test

# Expected output: Error from server (Forbidden): rolebindings.rbac.authorization.k8s.io "dangerous-binding" 
# is forbidden: policy "restrict-fleet-namespace-rolebindings" violates PreconditionFailed rule

# Attempt to create a safe RoleBinding (should SUCCEED)
kubectl create rolebinding safe-binding \
  --clusterrole=iotistic-fleet-namespace-manager \
  --serviceaccount=default:default \
  -n fleet-test

# Should succeed with: rolebinding.rbac.authorization.k8s.io/safe-binding created

# Cleanup
kubectl delete namespace fleet-test
```

### Test 2: Verify namespace naming restriction

```bash
# Attempt to create namespace without fleet- prefix (should be DENIED)
kubectl create namespace bad-namespace
# Expected: Error

# Create namespace with fleet- prefix (should SUCCEED)
kubectl create namespace fleet-badtest
kubectl label namespace fleet-badtest app.kubernetes.io/managed-by=iotistic-api

# Cleanup
kubectl delete namespace fleet-badtest
```

### Test 3: Verify pod security restriction

```bash
# Attempt to create privileged pod (should be DENIED)
kubectl run privileged-test --image=nginx --privileged -n fleet-test
# Expected: Error

# Attempt to create unprivileged pod (should SUCCEED)
kubectl run unprivileged-test --image=nginx -n fleet-test
# Should succeed
```

## ⚙️ Step 4: Deploy API with Hardened RBAC

```bash
# Deploy the Helm chart (now with hardened RBAC + Kyverno enforcement)
helm install iotistic ./iot-k8s-main/charts/iotistica-app \
  --namespace billing \
  --create-namespace \
  --set api.enabled=true

# Verify API permissions
kubectl auth can-i create rolebindings \
  --as=system:serviceaccount:billing:iotistic-api
# Should return: yes

kubectl auth can-i create roles \
  --as=system:serviceaccount:billing:iotistic-api
# Should return: no

kubectl auth can-i delete namespaces \
  --as=system:serviceaccount:billing:iotistic-api
# Should return: no
```

## 🔍 Verification Checklist

After deployment, verify all security controls:

```bash
# 1. Kyverno is running
kubectl get deployment -n kyverno
kubectl get validatingwebhookconfigurations | grep kyverno

# 2. Policies are active
kubectl get clusterpolicies | grep -E "restrict-|require-"

# 3. API ServiceAccount has correct permissions
kubectl auth can-i create rolebindings \
  --as=system:serviceaccount:billing:iotistic-api
# YES - required for fleet provisioning

kubectl auth can-i create roles \
  --as=system:serviceaccount:billing:iotistic-api
# NO - prevented privilege escalation

kubectl auth can-i delete namespaces \
  --as=system:serviceaccount:billing:iotistic-api
# NO - soft-delete only

kubectl auth can-i get secrets \
  --as=system:serviceaccount:billing:iotistic-api
# YES - but Kyverno limits to fleet namespace only (namespace-scoped binding)

# 4. Test RoleBinding creation in fleet namespace
FLEET_NS="fleet-$(uuidgen | cut -c1-8)"
kubectl create namespace $FLEET_NS
kubectl label namespace $FLEET_NS app.kubernetes.io/managed-by=iotistic-api

# This should succeed (safe binding)
kubectl create rolebinding fleet-binding \
  --clusterrole=iotistic-fleet-namespace-manager \
  --serviceaccount=billing:iotistic-api \
  -n $FLEET_NS && echo "✅ Safe binding allowed"

# This should fail (dangerous binding)
kubectl create rolebinding admin-binding \
  --clusterrole=cluster-admin \
  --serviceaccount=billing:iotistic-api \
  -n $FLEET_NS 2>&1 | grep -q "forbidden" && echo "✅ Dangerous binding blocked"

# Cleanup
kubectl delete namespace $FLEET_NS
```

## 📊 Monitoring & Audit

### View Policy Violations

```bash
# See all policy violations (audit mode)
kubectl get policyreport -A -o jsonpath='{.items[*].results[*]}'

# Watch for policy violations in real-time
kubectl get events -A --sort-by='.lastTimestamp' | grep -i kyverno

# Detailed policy report
kubectl describe policyreport -n default
```

### Enable Audit Logging

```bash
# Enable Kubernetes audit logging to audit RBAC decisions
# Add to kubeadm config or API server flags:
# --audit-policy-file=/etc/kubernetes/audit-policy.yaml
# --audit-log-path=/var/log/kubernetes/audit.log

# View RBAC decision logs
kubectl get events -A | grep RBAC
tail -f /var/log/kubernetes/audit.log | grep '"verb":"create"' | grep rolebinding
```

## 🛠️ Troubleshooting

### Policies not being enforced

```bash
# Check Kyverno webhook is registered
kubectl get validatingwebhookconfigurations
kubectl get mutatingwebhookconfigurations

# Check webhook is working
kubectl logs -n kyverno -l app.kubernetes.io/name=kyverno --tail=50

# Check policy is loaded
kubectl get clusterpolicy restrict-fleet-namespace-rolebindings -o yaml

# Test webhook connectivity
kubectl rollout restart deployment/kyverno -n kyverno
```

### API cannot create RoleBindings

```bash
# Check permissions
kubectl auth can-i create rolebindings \
  --as=system:serviceaccount:billing:iotistic-api -n fleet-test

# Check for policy violations
kubectl describe policyreport

# Check API logs for detailed error
kubectl logs -n billing deployment/api --tail=100 | grep -i rolebinding
```

### Pods failing due to security policies

```bash
# Check pod security violations
kubectl describe pod -n fleet-xxx | grep -i security

# Verify pod has correct security context
kubectl get pod -n fleet-xxx -o jsonpath='{.items[*].spec.containers[*].securityContext}'

# Temporarily audit policy (not enforce) for debugging
kubectl patch clusterpolicy restrict-privileged-containers \
  -p '{"spec":{"validationFailureAction":"audit"}}'
```

## 🔄 Updating Policies

To update policies without breaking deployments:

```bash
# Start with audit mode (log violations but don't block)
kubectl patch clusterpolicy restrict-fleet-namespace-rolebindings \
  -p '{"spec":{"validationFailureAction":"audit"}}'

# Monitor policy report
kubectl get policyreport -A

# Once no violations, switch to enforce
kubectl patch clusterpolicy restrict-fleet-namespace-rolebindings \
  -p '{"spec":{"validationFailureAction":"enforce"}}'
```

## 📚 References

- [Kyverno Documentation](https://kyverno.io)
- [Kyverno ClusterPolicy](https://kyverno.io/docs/writing-policies/clusterpolicies/)
- [RBAC Best Practices](https://kubernetes.io/docs/concepts/security/rbac-good-practices/)
- [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)

## ✅ Security Checklist

- [ ] Kyverno deployed and running
- [ ] All 7 ClusterPolicies active in `enforce` mode
- [ ] API cannot delete namespaces
- [ ] API cannot bind cluster-admin
- [ ] API cannot create arbitrary Roles
- [ ] Namespace naming pattern enforced (fleet-*)
- [ ] Pod security policies enforced
- [ ] ResourceQuota configured per fleet namespace
- [ ] Audit logging enabled
- [ ] Policy reports monitored regularly
