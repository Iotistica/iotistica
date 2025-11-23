################################################################################
# Iotistic K8s Cluster Setup Script (PowerShell)
# 
# One-time setup for production Kubernetes clusters
# Installs all required cluster-level components before deploying customer instances
#
# Usage:
#   .\cluster-setup.ps1 [-SkipIngress] [-SkipCertManager] [-SkipMonitoring] [-Domain <domain>] [-Email <email>] [-DryRun]
#
# Parameters:
#   -SkipIngress        Skip Nginx Ingress installation
#   -SkipCertManager    Skip cert-manager installation
#   -SkipMonitoring     Skip Prometheus Operator installation
#   -Domain             Domain for Let's Encrypt (required if using cert-manager)
#   -Email              Email for Let's Encrypt (required if using cert-manager)
#   -DryRun             Show what would be installed without actually installing
#   -Help               Show this help message
#
# Example:
#   .\cluster-setup.ps1 -Domain iotistic.ca -Email admin@iotistic.ca
#
################################################################################

param(
    [switch]$SkipIngress = $false,
    [switch]$SkipCertManager = $false,
    [switch]$SkipMonitoring = $false,
    [string]$Domain = "",
    [string]$Email = "",
    [switch]$DryRun = $false,
    [switch]$Help = $false
)

# Show help
if ($Help) {
    Get-Help $MyInvocation.MyCommand.Path
    exit 0
}

# Helper functions
function Write-Header {
    param([string]$Message)
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Blue
    Write-Host "  $Message" -ForegroundColor Blue
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Blue
    Write-Host ""
}

function Write-Success {
    param([string]$Message)
    Write-Host "✓ $Message" -ForegroundColor Green
}

function Write-Warning {
    param([string]$Message)
    Write-Host "⚠ $Message" -ForegroundColor Yellow
}

function Write-Error {
    param([string]$Message)
    Write-Host "✗ $Message" -ForegroundColor Red
}

function Write-Info {
    param([string]$Message)
    Write-Host "ℹ $Message" -ForegroundColor Cyan
}

function Test-Command {
    param([string]$Command)
    $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

function Invoke-RunCommand {
    param(
        [string]$Command,
        [string[]]$Arguments = @()
    )
    
    if ($DryRun) {
        Write-Host "[DRY RUN] $Command $($Arguments -join ' ')" -ForegroundColor Yellow
    } else {
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed: $Command $($Arguments -join ' ')"
        }
    }
}

# Validation
Write-Header "Validating Prerequisites"

# Check required commands
Write-Info "Checking required tools..."
if (-not (Test-Command "kubectl")) {
    Write-Error "kubectl is not installed"
    Write-Info "Install from: https://kubernetes.io/docs/tasks/tools/"
    exit 1
}

# Helm is optional - only needed for advanced monitoring features
$helmAvailable = Test-Command "helm"
if (-not $helmAvailable) {
    Write-Warning "helm is not installed (optional - will use kubectl for all installations)"
    if (-not $SkipMonitoring) {
        Write-Info "Monitoring will be installed using kubectl manifests instead of Helm"
    }
}
Write-Success "Required tools are available"

# Check kubectl connection
Write-Info "Checking Kubernetes cluster connection..."
try {
    $null = kubectl cluster-info 2>$null
    Write-Success "Connected to Kubernetes cluster"
} catch {
    Write-Error "Cannot connect to Kubernetes cluster"
    Write-Info "Make sure kubectl is configured and cluster is accessible"
    exit 1
}

# Get cluster info
$clusterName = kubectl config current-context
$clusterVersion = (kubectl version --short 2>$null | Select-String "Server Version" | ForEach-Object { $_.Line.Split()[-1] })
Write-Info "Cluster: $clusterName"
Write-Info "Kubernetes version: $clusterVersion"

# Validate cert-manager requirements
if (-not $SkipCertManager) {
    if ([string]::IsNullOrEmpty($Domain)) {
        Write-Warning "No domain specified. Use -Domain to enable Let's Encrypt"
        Write-Warning "Skipping cert-manager installation"
        $SkipCertManager = $true
    } elseif ([string]::IsNullOrEmpty($Email)) {
        Write-Warning "No email specified. Use -Email for Let's Encrypt notifications"
        Write-Warning "Skipping cert-manager installation"
        $SkipCertManager = $true
    }
}

# Summary
Write-Host ""
Write-Info "Installation Summary:"
Write-Host "  • Nginx Ingress Controller: $(if (-not $SkipIngress) { 'YES' } else { 'SKIP' })"
Write-Host "  • cert-manager (TLS): $(if (-not $SkipCertManager) { 'YES' } else { 'SKIP' })"
Write-Host "  • ServiceMonitor CRD: YES (REQUIRED)"
Write-Host "  • Prometheus Operator: $(if (-not $SkipMonitoring) { 'YES' } else { 'SKIP' })"
if (-not $SkipCertManager) {
    Write-Host "  • Domain: $Domain"
    Write-Host "  • Email: $Email"
}
Write-Host ""

if ($DryRun) {
    Write-Warning "DRY RUN MODE - No changes will be made"
    Write-Host ""
}

# Confirm before proceeding
if (-not $DryRun) {
    $confirmation = Read-Host "Proceed with installation? (y/N)"
    if ($confirmation -ne 'y' -and $confirmation -ne 'Y') {
        Write-Info "Installation cancelled"
        exit 0
    }
}

################################################################################
# Installation Steps
################################################################################

try {
    # Step 1: Install ServiceMonitor CRD (ALWAYS REQUIRED)
    Write-Header "Step 1: Installing ServiceMonitor CRD (REQUIRED)"

    Write-Info "This CRD is REQUIRED for customer deployments even without Prometheus"
    Write-Info "Customer instances will fail to deploy without it"

    $crdExists = kubectl get crd servicemonitors.monitoring.coreos.com 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Warning "ServiceMonitor CRD already exists"
    } else {
        Write-Info "Installing ServiceMonitor CRD..."
        Invoke-RunCommand "kubectl" @("apply", "-f", "https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/example/prometheus-operator-crd/monitoring.coreos.com_servicemonitors.yaml")
        
        if (-not $DryRun) {
            Start-Sleep -Seconds 2
            $crdExists = kubectl get crd servicemonitors.monitoring.coreos.com 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Success "ServiceMonitor CRD installed successfully"
            } else {
                Write-Error "Failed to install ServiceMonitor CRD"
                exit 1
            }
        }
    }

    # Step 2: Install Nginx Ingress Controller
    if (-not $SkipIngress) {
        Write-Header "Step 2: Installing Nginx Ingress Controller"
        
        # Add Helm repo
        Write-Info "Adding ingress-nginx Helm repository..."
        Invoke-RunCommand "helm" @("repo", "add", "ingress-nginx", "https://kubernetes.github.io/ingress-nginx")
        Invoke-RunCommand "helm" @("repo", "update")
        
        # Check if already installed
        $ingressInstalled = helm list -n ingress-nginx 2>$null | Select-String "ingress-nginx"
        if ($ingressInstalled) {
            Write-Warning "Nginx Ingress already installed"
        } else {
            Write-Info "Installing Nginx Ingress Controller..."
            Invoke-RunCommand "helm" @(
                "install", "ingress-nginx", "ingress-nginx/ingress-nginx",
                "--namespace", "ingress-nginx",
                "--create-namespace",
                "--set", "controller.service.type=LoadBalancer",
                "--set", "controller.metrics.enabled=true",
                "--set", "controller.podAnnotations.prometheus\.io/scrape=true",
                "--set", "controller.podAnnotations.prometheus\.io/port=10254"
            )
            
            if (-not $DryRun) {
                Write-Info "Waiting for Nginx Ingress to be ready..."
                kubectl wait --namespace ingress-nginx `
                    --for=condition=ready pod `
                    --selector=app.kubernetes.io/component=controller `
                    --timeout=300s
                
                Write-Success "Nginx Ingress Controller installed successfully"
                
                # Get LoadBalancer IP/Hostname
                Write-Info "Retrieving LoadBalancer external IP..."
                Start-Sleep -Seconds 5
                $externalIP = kubectl get service -n ingress-nginx ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>$null
                $externalHostname = kubectl get service -n ingress-nginx ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>$null
                
                if (-not [string]::IsNullOrEmpty($externalIP)) {
                    Write-Success "External IP: $externalIP"
                    Write-Info "Configure DNS: *.$Domain → $externalIP"
                } elseif (-not [string]::IsNullOrEmpty($externalHostname)) {
                    Write-Success "External Hostname: $externalHostname"
                    Write-Info "Configure DNS: *.$Domain → $externalHostname"
                } else {
                    Write-Warning "LoadBalancer external IP pending. Check with:"
                    Write-Info "kubectl get service -n ingress-nginx ingress-nginx-controller"
                }
            }
        }
    } else {
        Write-Header "Step 2: Skipping Nginx Ingress Controller"
    }

    # Step 3: Install cert-manager
    if (-not $SkipCertManager) {
        Write-Header "Step 3: Installing cert-manager"
        
        # Add Helm repo
        Write-Info "Adding jetstack Helm repository..."
        Invoke-RunCommand "helm" @("repo", "add", "jetstack", "https://charts.jetstack.io")
        Invoke-RunCommand "helm" @("repo", "update")
        
        # Check if already installed
        $certManagerInstalled = helm list -n cert-manager 2>$null | Select-String "cert-manager"
        if ($certManagerInstalled) {
            Write-Warning "cert-manager already installed"
        } else {
            Write-Info "Installing cert-manager..."
            Invoke-RunCommand "helm" @(
                "install", "cert-manager", "jetstack/cert-manager",
                "--namespace", "cert-manager",
                "--create-namespace",
                "--version", "v1.13.0",
                "--set", "installCRDs=true",
                "--set", "prometheus.enabled=true"
            )
            
            if (-not $DryRun) {
                Write-Info "Waiting for cert-manager to be ready..."
                kubectl wait --namespace cert-manager `
                    --for=condition=ready pod `
                    --selector=app.kubernetes.io/instance=cert-manager `
                    --timeout=300s
                
                Write-Success "cert-manager installed successfully"
            }
        }
        
        # Create ClusterIssuer for Let's Encrypt
        if (-not $DryRun) {
            Write-Info "Creating Let's Encrypt ClusterIssuer..."
            
            $clusterIssuerYaml = @"
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: $Email
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
    email: $Email
    privateKeySecretRef:
      name: letsencrypt-staging
    solvers:
    - http01:
        ingress:
          class: nginx
"@
            
            $clusterIssuerYaml | kubectl apply -f -
            
            Write-Success "ClusterIssuers created (production and staging)"
            Write-Info "Use annotation: cert-manager.io/cluster-issuer: letsencrypt-prod"
        } else {
            Write-Host "[DRY RUN] Would create ClusterIssuers for Let's Encrypt" -ForegroundColor Yellow
        }
    } else {
        Write-Header "Step 3: Skipping cert-manager"
    }

    # Step 4: Install Prometheus Operator
    if (-not $SkipMonitoring) {
        Write-Header "Step 4: Installing Prometheus Operator Stack"
        
        # Create monitoring namespace
        Write-Info "Creating monitoring namespace..."
        $namespaceExists = kubectl get namespace monitoring 2>$null
        if ($LASTEXITCODE -ne 0) {
            Invoke-RunCommand "kubectl" @("create", "namespace", "monitoring")
        } else {
            Write-Warning "Namespace 'monitoring' already exists"
        }
        
        # Install Prometheus Operator bundle
        Write-Info "Installing Prometheus Operator and CRDs..."
        Invoke-RunCommand "kubectl" @("apply", "-f", "https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/bundle.yaml")
        
        if (-not $DryRun) {
            Write-Info "Waiting for Prometheus Operator to be ready..."
            Start-Sleep -Seconds 5
            
            # Install Prometheus CRD (needed for Prometheus instance)
            Write-Info "Installing Prometheus CRD..."
            Invoke-RunCommand "kubectl" @("apply", "--server-side", "-f", "https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/example/prometheus-operator-crd/monitoring.coreos.com_prometheuses.yaml")
            
            # Restart operator to pick up new CRDs
            Write-Info "Restarting Prometheus Operator to detect new CRDs..."
            kubectl rollout restart deployment prometheus-operator -n default 2>$null
            Start-Sleep -Seconds 10
            
            # Create monitoring stack YAML
            Write-Info "Creating Prometheus and Grafana instances..."
            
            $monitoringYaml = @"
---
# Service Account for Prometheus
apiVersion: v1
kind: ServiceAccount
metadata:
  name: prometheus
  namespace: monitoring
---
# ClusterRole for Prometheus
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus
rules:
- apiGroups: [""]
  resources:
  - nodes
  - nodes/metrics
  - services
  - endpoints
  - pods
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources:
  - configmaps
  verbs: ["get"]
- apiGroups:
  - networking.k8s.io
  resources:
  - ingresses
  verbs: ["get", "list", "watch"]
- nonResourceURLs: ["/metrics"]
  verbs: ["get"]
---
# ClusterRoleBinding for Prometheus
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: prometheus
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: prometheus
subjects:
- kind: ServiceAccount
  name: prometheus
  namespace: monitoring
---
# Prometheus Instance
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
  namespace: monitoring
spec:
  serviceAccountName: prometheus
  replicas: 1
  retention: 30d
  storage:
    volumeClaimTemplate:
      spec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 10Gi
  serviceMonitorSelector: {}
  serviceMonitorNamespaceSelector: {}
  podMonitorSelector: {}
  podMonitorNamespaceSelector: {}
  resources:
    requests:
      memory: 400Mi
      cpu: 250m
    limits:
      memory: 2Gi
      cpu: 1000m
---
# Prometheus Service
apiVersion: v1
kind: Service
metadata:
  name: prometheus
  namespace: monitoring
spec:
  type: ClusterIP
  ports:
  - name: web
    port: 9090
    targetPort: 9090
  selector:
    prometheus: prometheus
---
# Grafana Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: grafana
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: grafana
  template:
    metadata:
      labels:
        app: grafana
    spec:
      containers:
      - name: grafana
        image: grafana/grafana:latest
        ports:
        - containerPort: 3000
        env:
        - name: GF_SECURITY_ADMIN_PASSWORD
          value: admin
        - name: GF_SECURITY_ADMIN_USER
          value: admin
        - name: GF_AUTH_ANONYMOUS_ENABLED
          value: "false"
        volumeMounts:
        - name: grafana-storage
          mountPath: /var/lib/grafana
        - name: grafana-datasources
          mountPath: /etc/grafana/provisioning/datasources
        resources:
          requests:
            memory: 128Mi
            cpu: 100m
          limits:
            memory: 512Mi
            cpu: 500m
      volumes:
      - name: grafana-storage
        emptyDir: {}
      - name: grafana-datasources
        configMap:
          name: grafana-datasources
---
# Grafana Service
apiVersion: v1
kind: Service
metadata:
  name: grafana
  namespace: monitoring
spec:
  type: ClusterIP
  ports:
  - name: web
    port: 3000
    targetPort: 3000
  selector:
    app: grafana
---
# Grafana Datasource ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: monitoring
data:
  datasource.yaml: |
    apiVersion: 1
    datasources:
    - name: Prometheus
      type: prometheus
      access: proxy
      url: http://prometheus.monitoring.svc:9090
      isDefault: true
      editable: false
"@
            
            $monitoringYaml | kubectl apply -f -
            
            Write-Info "Waiting for Prometheus and Grafana to be ready..."
            Start-Sleep -Seconds 15
            
            # Check status
            $prometheusReady = kubectl get pods -n monitoring -l prometheus=prometheus -o jsonpath='{.items[0].status.phase}' 2>$null
            $grafanaReady = kubectl get pods -n monitoring -l app=grafana -o jsonpath='{.items[0].status.phase}' 2>$null
            
            if ($prometheusReady -eq "Running" -and $grafanaReady -eq "Running") {
                Write-Success "Prometheus Operator stack installed successfully"
            } else {
                Write-Warning "Stack deployed but pods may still be starting..."
                Write-Info "Check status with: kubectl get pods -n monitoring"
            }
            
            Write-Host ""
            Write-Info "Access Grafana:"
            Write-Info "  kubectl port-forward -n monitoring svc/grafana 3000:3000"
            Write-Info "  URL: http://localhost:3000"
            Write-Info "  Credentials: admin/admin"
            Write-Host ""
            Write-Info "Access Prometheus:"
            Write-Info "  kubectl port-forward -n monitoring svc/prometheus 9090:9090"
            Write-Info "  URL: http://localhost:9090"
        }
    } else {
        Write-Header "Step 4: Skipping Prometheus Operator"
        Write-Warning "Monitoring stack not installed"
        Write-Info "ServiceMonitor resources will be created but not scraped"
    }

    ################################################################################
    # Installation Complete
    ################################################################################

    Write-Header "Installation Complete!"

    Write-Success "Cluster is ready for customer instance deployments"
    Write-Host ""

    Write-Info "Installed Components:"
    Write-Host "  ✓ ServiceMonitor CRD (REQUIRED)"
    if (-not $SkipIngress) { Write-Host "  ✓ Nginx Ingress Controller" } else { Write-Host "  - Nginx Ingress (skipped)" }
    if (-not $SkipCertManager) { Write-Host "  ✓ cert-manager + Let's Encrypt" } else { Write-Host "  - cert-manager (skipped)" }
    if (-not $SkipMonitoring) { Write-Host "  ✓ Prometheus Operator + Grafana" } else { Write-Host "  - Monitoring (skipped)" }

    Write-Host ""
    Write-Header "Next Steps"

    Write-Host "1. Deploy Billing Service:"
    Write-Host "   cd billing"
    Write-Host "   helm install billing ./k8s/"
    Write-Host ""

    Write-Host "2. Verify DNS Configuration (if using custom domain):"
    if (-not [string]::IsNullOrEmpty($Domain)) {
        Write-Host "   nslookup billing.$Domain"
        Write-Host "   nslookup test.$Domain"
    } else {
        Write-Host "   Configure wildcard DNS: *.yourdomain.com → <LoadBalancer-IP>"
    }
    Write-Host ""

    Write-Host "3. Deploy First Customer Instance:"
    $billingDomain = if (-not [string]::IsNullOrEmpty($Domain)) { "billing.$Domain" } else { "localhost:3100" }
    Write-Host "   `$body = @{"
    Write-Host "     email = 'test@example.com'"
    Write-Host "     password = 'Pass123'"
    Write-Host "     company_name = 'Test Corp'"
    Write-Host "   } | ConvertTo-Json"
    Write-Host "   Invoke-RestMethod -Uri 'http://$billingDomain/api/customers/signup' -Method Post -ContentType 'application/json' -Body `$body"
    Write-Host ""

    Write-Host "4. Monitor Deployments:"
    Write-Host "   kubectl get pods -A"
    Write-Host "   kubectl get ingress -A"
    if (-not $SkipMonitoring) {
        Write-Host "   kubectl port-forward -n monitoring svc/grafana 3000:3000"
        Write-Host "   # Open http://localhost:3000 (admin/admin)"
    }
    Write-Host ""

    Write-Header "Useful Commands"

    Write-Host @"
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
kubectl get events -A --sort-by='.lastTimestamp' | Select-Object -Last 20
"@

    Write-Host ""
    Write-Header "Documentation"

    Write-Host "📚 Full guides available in:"
    Write-Host "  • .\charts\customer-instance\INSTALL.md"
    Write-Host "  • .\charts\customer-instance\README.md"
    Write-Host "  • .\docs\K8S-DEPLOYMENT-GUIDE.md"
    Write-Host ""

    Write-Success "Cluster setup complete! 🎉"

} catch {
    Write-Error "Installation failed: $_"
    Write-Info "Check logs above for details"
    exit 1
}
