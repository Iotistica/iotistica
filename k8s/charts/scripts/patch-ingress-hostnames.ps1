# Script to patch existing ingress hostnames to use short customer IDs
# This fixes the long Stripe customer IDs in the hostnames

$customers = @(
    @{ namespace = "customer-407c7bd3"; shortId = "407c7bd3"; release = "c407c7bd3-customer-instance" },
    @{ namespace = "customer-6f60b3ef"; shortId = "6f60b3ef"; release = "c6f60b3ef-customer-instance" },
    @{ namespace = "customer-c7e190b5"; shortId = "c7e190b5"; release = "cc7e190b5-customer-instance" },
    @{ namespace = "customer-d5f8c71b"; shortId = "d5f8c71b"; release = "cd5f8c71b-customer-instance" }
)

$domain = "iotistic.local"

Write-Host "Patching ingress hostnames to use short customer IDs..." -ForegroundColor Cyan
Write-Host ""

foreach ($customer in $customers) {
    $ingressName = $customer.release
    $namespace = $customer.namespace
    $newHost = "$($customer.shortId).$domain"
    
    Write-Host "Patching $ingressName in $namespace..." -ForegroundColor Yellow
    Write-Host "  New hostname: $newHost" -ForegroundColor Gray
    
    # Create a patch JSON for the ingress
    $patch = @"
{
  "spec": {
    "rules": [
      {
        "host": "$newHost",
        "http": {
          "paths": [
            {
              "path": "/",
              "pathType": "Prefix",
              "backend": {
                "service": {
                  "name": "${ingressName}-dashboard",
                  "port": {
                    "number": 80
                  }
                }
              }
            },
            {
              "path": "/api",
              "pathType": "Prefix",
              "backend": {
                "service": {
                  "name": "${ingressName}-api",
                  "port": {
                    "number": 3002
                  }
                }
              }
            },
            {
              "path": "/metrics",
              "pathType": "Prefix",
              "backend": {
                "service": {
                  "name": "${ingressName}-exporter",
                  "port": {
                    "number": 8080
                  }
                }
              }
            }
          ]
        }
      }
    ],
    "tls": null
  },
  "metadata": {
    "annotations": {
      "nginx.ingress.kubernetes.io/ssl-redirect": "false"
    }
  }
}
"@
    
    # Apply the patch
    $patch | kubectl patch ingress $ingressName -n $namespace --type merge -p (Get-Content -Raw)
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✓ Successfully patched $ingressName" -ForegroundColor Green
    } else {
        Write-Host "  ✗ Failed to patch $ingressName" -ForegroundColor Red
    }
    Write-Host ""
}

Write-Host "Verifying patched ingresses:" -ForegroundColor Cyan
kubectl get ingress --all-namespaces -o custom-columns="NAMESPACE:.metadata.namespace,NAME:.metadata.name,HOSTS:.spec.rules[0].host"

Write-Host ""
Write-Host "Next step: Run configure-local-ingress.ps1 as Administrator to update hosts file" -ForegroundColor Yellow
