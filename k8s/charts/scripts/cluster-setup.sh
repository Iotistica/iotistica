#!/bin/bash

################################################################################
# Iotistic K8s Cluster Setup Script
# 
# One-time setup for production Kubernetes clusters
# Installs all required cluster-level components before deploying customer instances
#
# Usage:
#   ./cluster-setup.sh [options]
#
# Options:
#   --skip-ingress          Skip Nginx Ingress installation
#   --skip-cert-manager     Skip cert-manager installation
#   --skip-monitoring       Skip Prometheus Operator installation
#   --domain DOMAIN         Domain for Let's Encrypt (required if using cert-manager)
#   --email EMAIL           Email for Let's Encrypt (required if using cert-manager)
#   --dry-run               Show what would be installed without actually installing
#   --help                  Show this help message
#
# Example:
#   ./cluster-setup.sh --domain iotistic.ca --email admin@iotistic.ca
#
################################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default options
SKIP_INGRESS=false
SKIP_CERT_MANAGER=false
SKIP_MONITORING=false
DRY_RUN=false
DOMAIN=""
EMAIL=""

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-ingress)
      SKIP_INGRESS=true
      shift
      ;;
    --skip-cert-manager)
      SKIP_CERT_MANAGER=true
      shift
      ;;
    --skip-monitoring)
      SKIP_MONITORING=false
      shift
      ;;
    --domain)
      DOMAIN="$2"
      shift 2
      ;;
    --email)
      EMAIL="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --help)
      head -n 30 "$0" | tail -n 28
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

# Helper functions
print_header() {
  echo ""
  echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}  $1${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
  echo ""
}

print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

print_warning() {
  echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
  echo -e "${RED}✗ $1${NC}"
}

print_info() {
  echo -e "${BLUE}ℹ $1${NC}"
}

check_command() {
  if ! command -v "$1" &> /dev/null; then
    print_error "$1 is not installed"
    exit 1
  fi
}

run_command() {
  if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}[DRY RUN]${NC} $*"
  else
    "$@"
  fi
}

# Validation
print_header "Validating Prerequisites"

# Check required commands
print_info "Checking required tools..."
check_command kubectl
check_command helm
print_success "All required tools are installed"

# Check kubectl connection
print_info "Checking Kubernetes cluster connection..."
if ! kubectl cluster-info &> /dev/null; then
  print_error "Cannot connect to Kubernetes cluster"
  print_info "Make sure kubectl is configured and cluster is accessible"
  exit 1
fi
print_success "Connected to Kubernetes cluster"

# Get cluster info
CLUSTER_VERSION=$(kubectl version --short 2>/dev/null | grep "Server Version" | awk '{print $3}' || echo "unknown")
CLUSTER_NAME=$(kubectl config current-context)
print_info "Cluster: ${CLUSTER_NAME}"
print_info "Kubernetes version: ${CLUSTER_VERSION}"

# Validate cert-manager requirements
if [ "$SKIP_CERT_MANAGER" = false ]; then
  if [ -z "$DOMAIN" ]; then
    print_warning "No domain specified. Use --domain to enable Let's Encrypt"
    print_warning "Skipping cert-manager installation"
    SKIP_CERT_MANAGER=true
  elif [ -z "$EMAIL" ]; then
    print_warning "No email specified. Use --email for Let's Encrypt notifications"
    print_warning "Skipping cert-manager installation"
    SKIP_CERT_MANAGER=true
  fi
fi

# Summary
echo ""
print_info "Installation Summary:"
echo "  • Nginx Ingress Controller: $([ "$SKIP_INGRESS" = false ] && echo "YES" || echo "SKIP")"
echo "  • cert-manager (TLS): $([ "$SKIP_CERT_MANAGER" = false ] && echo "YES" || echo "SKIP")"
echo "  • ServiceMonitor CRD: YES (REQUIRED)"
echo "  • Prometheus Operator: $([ "$SKIP_MONITORING" = false ] && echo "YES" || echo "SKIP")"
if [ "$SKIP_CERT_MANAGER" = false ]; then
  echo "  • Domain: ${DOMAIN}"
  echo "  • Email: ${EMAIL}"
fi
echo ""

if [ "$DRY_RUN" = true ]; then
  print_warning "DRY RUN MODE - No changes will be made"
  echo ""
fi

# Confirm before proceeding
if [ "$DRY_RUN" = false ]; then
  read -p "Proceed with installation? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_info "Installation cancelled"
    exit 0
  fi
fi

################################################################################
# Installation Steps
################################################################################

# Step 1: Install ServiceMonitor CRD (ALWAYS REQUIRED)
print_header "Step 1: Installing ServiceMonitor CRD (REQUIRED)"

print_info "This CRD is REQUIRED for customer deployments even without Prometheus"
print_info "Customer instances will fail to deploy without it"

if kubectl get crd servicemonitors.monitoring.coreos.com &> /dev/null; then
  print_warning "ServiceMonitor CRD already exists"
else
  print_info "Installing ServiceMonitor CRD..."
  run_command kubectl apply -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/example/prometheus-operator-crd/monitoring.coreos.com_servicemonitors.yaml
  
  if [ "$DRY_RUN" = false ]; then
    sleep 2
    if kubectl get crd servicemonitors.monitoring.coreos.com &> /dev/null; then
      print_success "ServiceMonitor CRD installed successfully"
    else
      print_error "Failed to install ServiceMonitor CRD"
      exit 1
    fi
  fi
fi

# Step 2: Install Nginx Ingress Controller
if [ "$SKIP_INGRESS" = false ]; then
  print_header "Step 2: Installing Nginx Ingress Controller"
  
  # Add Helm repo
  print_info "Adding ingress-nginx Helm repository..."
  run_command helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
  run_command helm repo update
  
  # Check if already installed
  if helm list -n ingress-nginx | grep -q ingress-nginx; then
    print_warning "Nginx Ingress already installed"
  else
    print_info "Installing Nginx Ingress Controller..."
    run_command helm install ingress-nginx ingress-nginx/ingress-nginx \
      --namespace ingress-nginx \
      --create-namespace \
      --set controller.service.type=LoadBalancer \
      --set controller.metrics.enabled=true \
      --set controller.podAnnotations."prometheus\.io/scrape"=true \
      --set controller.podAnnotations."prometheus\.io/port"=10254
    
    if [ "$DRY_RUN" = false ]; then
      print_info "Waiting for Nginx Ingress to be ready..."
      kubectl wait --namespace ingress-nginx \
        --for=condition=ready pod \
        --selector=app.kubernetes.io/component=controller \
        --timeout=300s
      
      print_success "Nginx Ingress Controller installed successfully"
      
      # Get LoadBalancer IP/Hostname
      print_info "Retrieving LoadBalancer external IP..."
      sleep 5
      EXTERNAL_IP=$(kubectl get service -n ingress-nginx ingress-nginx-controller \
        -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
      EXTERNAL_HOSTNAME=$(kubectl get service -n ingress-nginx ingress-nginx-controller \
        -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
      
      if [ -n "$EXTERNAL_IP" ]; then
        print_success "External IP: ${EXTERNAL_IP}"
        print_info "Configure DNS: *.${DOMAIN} → ${EXTERNAL_IP}"
      elif [ -n "$EXTERNAL_HOSTNAME" ]; then
        print_success "External Hostname: ${EXTERNAL_HOSTNAME}"
        print_info "Configure DNS: *.${DOMAIN} → ${EXTERNAL_HOSTNAME}"
      else
        print_warning "LoadBalancer external IP pending. Check with:"
        print_info "kubectl get service -n ingress-nginx ingress-nginx-controller"
      fi
    fi
  fi
else
  print_header "Step 2: Skipping Nginx Ingress Controller"
fi

# Step 3: Install cert-manager
if [ "$SKIP_CERT_MANAGER" = false ]; then
  print_header "Step 3: Installing cert-manager"
  
  # Add Helm repo
  print_info "Adding jetstack Helm repository..."
  run_command helm repo add jetstack https://charts.jetstack.io
  run_command helm repo update
  
  # Check if already installed
  if helm list -n cert-manager | grep -q cert-manager; then
    print_warning "cert-manager already installed"
  else
    print_info "Installing cert-manager..."
    run_command helm install cert-manager jetstack/cert-manager \
      --namespace cert-manager \
      --create-namespace \
      --version v1.13.0 \
      --set installCRDs=true \
      --set prometheus.enabled=true
    
    if [ "$DRY_RUN" = false ]; then
      print_info "Waiting for cert-manager to be ready..."
      kubectl wait --namespace cert-manager \
        --for=condition=ready pod \
        --selector=app.kubernetes.io/instance=cert-manager \
        --timeout=300s
      
      print_success "cert-manager installed successfully"
    fi
  fi
  
  # Create ClusterIssuer for Let's Encrypt
  if [ "$DRY_RUN" = false ]; then
    print_info "Creating Let's Encrypt ClusterIssuer..."
    
    cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ${EMAIL}
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: nginx
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: ${EMAIL}
    privateKeySecretRef:
      name: letsencrypt-staging
    solvers:
    - http01:
        ingress:
          class: nginx
EOF
    
    print_success "ClusterIssuers created (production and staging)"
    print_info "Use annotation: cert-manager.io/cluster-issuer: letsencrypt-prod"
  else
    echo -e "${YELLOW}[DRY RUN]${NC} Would create ClusterIssuers for Let's Encrypt"
  fi
else
  print_header "Step 3: Skipping cert-manager"
fi

# Step 4: Install Prometheus Operator
if [ "$SKIP_MONITORING" = false ]; then
  print_header "Step 4: Installing Prometheus Operator"
  
  # Add Helm repo
  print_info "Adding prometheus-community Helm repository..."
  run_command helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
  run_command helm repo update
  
  # Check if already installed
  if helm list -n monitoring | grep -q prometheus-operator; then
    print_warning "Prometheus Operator already installed"
  else
    print_info "Installing Prometheus Operator (kube-prometheus-stack)..."
    print_info "This includes: Prometheus, Grafana, AlertManager, and node exporters"
    
    run_command helm install prometheus-operator prometheus-community/kube-prometheus-stack \
      --namespace monitoring \
      --create-namespace \
      --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false \
      --set prometheus.prometheusSpec.podMonitorSelectorNilUsesHelmValues=false \
      --set prometheus.prometheusSpec.retention=30d \
      --set prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage=50Gi \
      --set grafana.adminPassword=admin \
      --set grafana.persistence.enabled=true \
      --set grafana.persistence.size=10Gi
    
    if [ "$DRY_RUN" = false ]; then
      print_info "Waiting for Prometheus Operator to be ready..."
      print_info "This may take a few minutes..."
      
      kubectl wait --namespace monitoring \
        --for=condition=ready pod \
        --selector=app.kubernetes.io/name=prometheus \
        --timeout=300s
      
      print_success "Prometheus Operator installed successfully"
      
      print_info "Access Grafana:"
      print_info "  kubectl port-forward -n monitoring svc/prometheus-operator-grafana 3000:80"
      print_info "  Default credentials: admin/admin"
      print_info ""
      print_info "Access Prometheus:"
      print_info "  kubectl port-forward -n monitoring svc/prometheus-operator-kube-prom-prometheus 9090:9090"
    fi
  fi
else
  print_header "Step 4: Skipping Prometheus Operator"
  print_warning "Monitoring stack not installed"
  print_info "ServiceMonitor resources will be created but not scraped"
fi

################################################################################
# Installation Complete
################################################################################

print_header "Installation Complete!"

print_success "Cluster is ready for customer instance deployments"
echo ""

print_info "Installed Components:"
echo "  ✓ ServiceMonitor CRD (REQUIRED)"
[ "$SKIP_INGRESS" = false ] && echo "  ✓ Nginx Ingress Controller" || echo "  - Nginx Ingress (skipped)"
[ "$SKIP_CERT_MANAGER" = false ] && echo "  ✓ cert-manager + Let's Encrypt" || echo "  - cert-manager (skipped)"
[ "$SKIP_MONITORING" = false ] && echo "  ✓ Prometheus Operator + Grafana" || echo "  - Monitoring (skipped)"

echo ""
print_header "Next Steps"

echo "1. Deploy Billing Service:"
echo "   cd billing"
echo "   helm install billing ./k8s/"
echo ""

echo "2. Verify DNS Configuration (if using custom domain):"
if [ -n "$DOMAIN" ]; then
  echo "   nslookup billing.${DOMAIN}"
  echo "   nslookup test.${DOMAIN}"
else
  echo "   Configure wildcard DNS: *.yourdomain.com → <LoadBalancer-IP>"
fi
echo ""

echo "3. Deploy First Customer Instance:"
echo "   curl -X POST http://billing.${DOMAIN:-localhost:3100}/api/customers/signup \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"email\":\"test@example.com\",\"password\":\"Pass123\",\"company_name\":\"Test Corp\"}'"
echo ""

echo "4. Monitor Deployments:"
echo "   kubectl get pods -A"
echo "   kubectl get ingress -A"
if [ "$SKIP_MONITORING" = false ]; then
  echo "   kubectl port-forward -n monitoring svc/prometheus-operator-grafana 3000:80"
fi
echo ""

print_header "Useful Commands"

cat <<'EOF'
# List all namespaces
kubectl get namespaces

# Check ingress controller
kubectl get pods -n ingress-nginx
kubectl get service -n ingress-nginx

# Check cert-manager
kubectl get pods -n cert-manager
kubectl get clusterissuer

# Check monitoring
kubectl get pods -n monitoring
kubectl get servicemonitor -A

# Check customer deployments
kubectl get namespaces -l managed-by=iotistic
kubectl get pods -n customer-<id>

# View cluster events
kubectl get events -A --sort-by='.lastTimestamp' | tail -20
EOF

echo ""
print_header "Documentation"

echo "📚 Full guides available in:"
echo "  • ./charts/customer-instance/INSTALL.md"
echo "  • ./charts/customer-instance/README.md"
echo "  • ./docs/K8S-DEPLOYMENT-GUIDE.md"
echo ""

print_success "Cluster setup complete! 🎉"
