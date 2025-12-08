# Create Kubernetes Secret for MQTT credentials
# Usage: .\create-mqtt-secret.ps1 [-Namespace] [-Username] [-Password]

param(
    [string]$Namespace = "iotistic-nodeport",
    [string]$Username = "admin",
    [Parameter(Mandatory=$false)]
    [string]$Password
)

if (-not $Password) {
    Write-Host "Usage: .\create-mqtt-secret.ps1 [-Namespace <namespace>] [-Username <username>] -Password <password>" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Example:"
    Write-Host "  .\create-mqtt-secret.ps1 -Password 'your-secure-password'" -ForegroundColor Cyan
    Write-Host "  .\create-mqtt-secret.ps1 -Namespace iotistic-nodeport -Username admin -Password 'secret'" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Default namespace: iotistic-nodeport"
    Write-Host "Default username: admin"
    exit 1
}

Write-Host "Creating MQTT credentials secret..." -ForegroundColor Green
Write-Host "  Namespace: $Namespace"
Write-Host "  Username: $Username"
Write-Host "  Password: ********"
Write-Host ""

try {
    # Create or update the secret
    kubectl create secret generic iotistic-mqtt-credentials `
        --from-literal=username="$Username" `
        --from-literal=password="$Password" `
        --namespace="$Namespace" `
        --dry-run=client -o yaml | kubectl apply -f -

    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "✅ Secret created successfully!" -ForegroundColor Green
        Write-Host ""
        Write-Host "To use this secret in your Helm deployment, update values.yaml:" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  api:" -ForegroundColor Gray
        Write-Host "    mqtt:" -ForegroundColor Gray
        Write-Host "      existingSecret: iotistic-mqtt-credentials" -ForegroundColor Gray
        Write-Host ""
        Write-Host "  mqttMonitor:" -ForegroundColor Gray
        Write-Host "    mqtt:" -ForegroundColor Gray
        Write-Host "      existingSecret: iotistic-mqtt-credentials" -ForegroundColor Gray
        Write-Host ""
        Write-Host "Or override via Helm command:" -ForegroundColor Cyan
        Write-Host "  helm upgrade --install iotistic .\k8s\charts\iotistic ``" -ForegroundColor Gray
        Write-Host "    --set api.mqtt.existingSecret=iotistic-mqtt-credentials ``" -ForegroundColor Gray
        Write-Host "    --set mqttMonitor.mqtt.existingSecret=iotistic-mqtt-credentials" -ForegroundColor Gray
    } else {
        Write-Host ""
        Write-Host "❌ Failed to create secret" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host ""
    Write-Host "❌ Error: $_" -ForegroundColor Red
    exit 1
}
