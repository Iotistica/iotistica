# Kubernetes Image Update Reference

## Switch Context
```bash
# List available contexts
kubectl config get-contexts

# Switch to Azure cluster
kubectl config use-context dev-iotistica-aks-cluster
```

## List Resources
```bash
# List namespaces
kubectl get namespaces

# List deployments in namespace
kubectl get deployments -n demo

# List pods in namespace
kubectl get pods -n demo
```

## Check Current Configuration
```bash
# View CORS environment variable
kubectl get deployment demo-release-iotistic-api -n demo -o yaml | Select-String -Pattern "CORS" -Context 2

# View current image version
kubectl get deployment demo-release-iotistic-api -n demo -o jsonpath='{.spec.template.spec.containers[0].image}'
```

## Update Deployment Image
```bash
# Update to new image version
kubectl set image deployment/demo-release-iotistic-api api=iotistic/api:v0.0.1-rc.20 -n demo

# Watch rollout status
kubectl rollout status deployment/demo-release-iotistic-api -n demo --timeout=60s

# Restart deployment (forces pod recreation)
kubectl rollout restart deployment demo-release-iotistic-api -n demo
```

## Verify Deployment
```bash
# Check pods are running
kubectl get pods -n demo

# Verify new image version
kubectl get deployment demo-release-iotistic-api -n demo -o jsonpath='{.spec.template.spec.containers[0].image}'

# View pod logs
kubectl logs -f deployment/demo-release-iotistic-api -n demo
```
