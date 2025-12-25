#!/bin/bash
set -e

echo "========================================"
echo "TimescaleDB CloudNativePG Deployment"
echo "========================================"
echo ""

# Configuration
NAMESPACE="${NAMESPACE:-iotistic-system}"
CLUSTER_NAME="${CLUSTER_NAME:-timescaledb-cluster}"

# Check if CloudNativePG operator is installed
echo "Checking CloudNativePG operator..."
if ! kubectl get deployment -n cnpg-system cnpg-controller-manager &> /dev/null; then
    echo "✗ CloudNativePG operator not found"
    echo ""
    echo "Install CloudNativePG operator first:"
    echo "  kubectl apply -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.0.yaml"
    echo ""
    exit 1
fi
echo "✓ CloudNativePG operator is installed"

# Create namespace
echo ""
echo "Creating namespace: $NAMESPACE"
kubectl create namespace $NAMESPACE --dry-run=client -o yaml | kubectl apply -f -
echo "✓ Namespace ready"

# Apply ImageCatalog
echo ""
echo "Deploying ImageCatalog..."
if ! kubectl get imagecatalog timescaledb -n $NAMESPACE &> /dev/null; then
    if grep -q "YOUR_REGISTRY" k8s/imagecatalog.yaml; then
        echo "✗ Error: ImageCatalog still contains placeholder YOUR_REGISTRY"
        echo ""
        echo "Update k8s/imagecatalog.yaml with your actual image registry:"
        echo "  sed -i 's|YOUR_REGISTRY|ghcr.io/iotistica|g' k8s/imagecatalog.yaml"
        echo ""
        exit 1
    fi
    kubectl apply -f k8s/imagecatalog.yaml
    echo "✓ ImageCatalog created"
else
    echo "ℹ ImageCatalog already exists"
fi

# Apply Cluster
echo ""
echo "Deploying TimescaleDB cluster..."
kubectl apply -f k8s/cluster.yaml
echo "✓ Cluster manifest applied"

# Wait for cluster to be ready
echo ""
echo "Waiting for cluster to initialize (this may take 2-3 minutes)..."
kubectl wait --for=condition=Ready cluster/$CLUSTER_NAME -n $NAMESPACE --timeout=300s || {
    echo ""
    echo "⚠ Cluster initialization timeout"
    echo "Check cluster status:"
    echo "  kubectl get cluster -n $NAMESPACE"
    echo "  kubectl describe cluster $CLUSTER_NAME -n $NAMESPACE"
    echo "  kubectl get pods -n $NAMESPACE"
    exit 1
}

echo ""
echo "✓ Cluster is ready!"

# Show cluster status
echo ""
echo "========================================="
echo "Cluster Status"
echo "========================================="
kubectl get cluster -n $NAMESPACE
echo ""
kubectl get pods -n $NAMESPACE

# Verify TimescaleDB extension
echo ""
echo "========================================="
echo "Verifying TimescaleDB Extension"
echo "========================================="
echo ""
sleep 5  # Give cluster a moment to fully stabilize

kubectl exec -it $CLUSTER_NAME-1 -n $NAMESPACE -- \
  psql -U postgres -d iotistic -c "
-- Verify TimescaleDB extension
SELECT extname, extversion FROM pg_extension 
WHERE extname = 'timescaledb';

-- Verify hypertable creation
SELECT * FROM timescaledb_information.hypertables;

-- Test compression policy
SELECT * FROM timescaledb_information.jobs 
WHERE proc_name LIKE '%compression%';
" || {
    echo ""
    echo "⚠ Extension verification failed"
    echo "Check pod logs:"
    echo "  kubectl logs $CLUSTER_NAME-1 -n $NAMESPACE"
}

echo ""
echo "========================================="
echo "Deployment Complete!"
echo "========================================="
echo ""
echo "Cluster: $CLUSTER_NAME"
echo "Namespace: $NAMESPACE"
echo "Database: iotistic"
echo "User: iotistic"
echo ""
echo "Useful commands:"
echo "  kubectl get cluster -n $NAMESPACE"
echo "  kubectl get pods -n $NAMESPACE"
echo "  kubectl exec -it $CLUSTER_NAME-1 -n $NAMESPACE -- psql -U postgres -d iotistic"
echo "  kubectl logs $CLUSTER_NAME-1 -n $NAMESPACE"
echo ""
