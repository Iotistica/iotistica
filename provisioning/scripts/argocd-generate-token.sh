#!/bin/bash
# Generate Argo CD API token using kubectl backend access
# Usage: ./argocd-generate-token.sh [account-name] [namespace]

set -e

ACCOUNT_NAME="${1:-provisioning-automation}"
NAMESPACE="${2:-argocd}"

echo "================================================================================"
echo "  Argo CD API Token Generator (kubectl backend)"
echo "================================================================================"
echo ""

# Check kubectl
if ! command -v kubectl &> /dev/null; then
    echo "❌ Error: kubectl not found"
    echo "   Install: https://kubernetes.io/docs/tasks/tools/"
    exit 1
fi
echo "✅ kubectl is available"

# Check namespace access
if ! kubectl get namespace "$NAMESPACE" &> /dev/null; then
    echo "❌ Error: Cannot access namespace '$NAMESPACE'"
    echo "   Make sure you're connected to the correct cluster"
    echo "   Run: kubectl config current-context"
    exit 1
fi
echo "✅ Namespace accessible"
echo ""

# Step 1: Check/Create Account
echo "================================================================================"
echo "Step 1: Configure Service Account"
echo "================================================================================"
echo ""

ACCOUNT_EXISTS=$(kubectl get configmap argocd-cm -n "$NAMESPACE" -o jsonpath="{.data.accounts\\.${ACCOUNT_NAME}}" 2>/dev/null || echo "")

if [ -z "$ACCOUNT_EXISTS" ]; then
    echo "⏳ Creating account '$ACCOUNT_NAME' with apiKey capability..."
    kubectl patch configmap argocd-cm -n "$NAMESPACE" --type merge -p "{\"data\":{\"accounts.${ACCOUNT_NAME}\":\"apiKey, login\"}}"
    echo "✅ Account created"
    echo "⏳ Waiting 5 seconds for changes to propagate..."
    sleep 5
else
    echo "✅ Account '$ACCOUNT_NAME' already exists"
fi
echo ""

# Step 2: Configure RBAC
echo "================================================================================"
echo "Step 2: Configure RBAC Permissions"
echo "================================================================================"
echo ""

echo "⏳ Setting up RBAC permissions..."

# Create policy for provisioning role
kubectl patch configmap argocd-rbac-cm -n "$NAMESPACE" --type merge -p "$(cat <<EOF
{
  "data": {
    "policy.csv": "p, role:provisioning, applications, get, */*, allow\np, role:provisioning, applications, list, *, allow\ng, ${ACCOUNT_NAME}, role:provisioning"
  }
}
EOF
)"

echo "✅ RBAC permissions configured"
echo "⏳ Waiting 5 seconds for RBAC changes to propagate..."
sleep 5
echo ""

# Step 3: Generate Token
echo "================================================================================"
echo "Step 3: Generate API Token"
echo "================================================================================"
echo ""

SERVER_POD=$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/name=argocd-server -o jsonpath='{.items[0].metadata.name}')

if [ -z "$SERVER_POD" ]; then
    echo "❌ Error: Argo CD server pod not found"
    exit 1
fi

echo "✅ Found pod: $SERVER_POD"
echo ""

echo "⏳ Generating token..."
TOKEN=$(kubectl exec -n "$NAMESPACE" "$SERVER_POD" -- argocd account generate-token --account "$ACCOUNT_NAME" 2>&1)

if [ $? -ne 0 ]; then
    echo "❌ Error generating token:"
    echo "$TOKEN"
    echo ""
    echo "Troubleshooting:"
    echo "  1. Restart Argo CD server: kubectl rollout restart deployment argocd-server -n $NAMESPACE"
    echo "  2. Wait 30 seconds and try again"
    exit 1
fi

echo "✅ Token generated successfully!"
echo ""

# Display Results
echo "================================================================================"
echo "🎉 SUCCESS - Your Argo CD API Token"
echo "================================================================================"
echo ""
echo "Account: $ACCOUNT_NAME"
echo "Token:   $TOKEN"
echo ""
echo "Update your .env file:"
echo "ARGOCD_TOKEN=$TOKEN"
echo ""

# Test Token
echo "================================================================================"
echo "Testing Token"
echo "================================================================================"
echo ""

BASE_URL=$(kubectl get configmap argocd-cm -n "$NAMESPACE" -o jsonpath='{.data.url}' 2>/dev/null || echo "")
if [ -z "$BASE_URL" ]; then
    BASE_URL=$(kubectl get ingress -n "$NAMESPACE" -o jsonpath='{.items[0].spec.rules[0].host}' 2>/dev/null || echo "")
    if [ -n "$BASE_URL" ]; then
        BASE_URL="https://$BASE_URL"
    fi
fi

if [ -n "$BASE_URL" ]; then
    echo "⏳ Testing token against: $BASE_URL..."
    
    VERSION=$(curl -sk -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/version" 2>/dev/null | grep -o '"Version":"[^"]*"' | cut -d'"' -f4)
    
    if [ -n "$VERSION" ]; then
        echo "✅ Token works! Argo CD version: $VERSION"
    else
        echo "⚠️  Could not test token automatically"
        echo "   Test manually: npx ts-node tests/test-argocd-connection.ts"
    fi
else
    echo "ℹ️  Auto-test skipped (base URL not found)"
    echo "   Test manually: npx ts-node tests/test-argocd-connection.ts"
fi
echo ""

echo "================================================================================"
echo "✅ COMPLETE"
echo "================================================================================"
echo ""
echo "Next Steps:"
echo "  1. Copy the token above to your .env file"
echo "  2. Run test: npx ts-node tests/test-argocd-connection.ts"
echo "  3. Restart provisioning services: docker-compose restart"
echo ""
