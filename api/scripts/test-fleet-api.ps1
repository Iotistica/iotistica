# Fleet Management API - Test Script
# Test all fleet management endpoints

$API_URL = "http://localhost:4002/api/v1"
$CUSTOMER_ID = "00000000-0000-0000-0000-000000000001"

Write-Host "`n==================================================" -ForegroundColor Cyan
Write-Host "Fleet Management API - Test Suite" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

# ============================================================================
# Authentication: Login to get JWT token
# ============================================================================
Write-Host "`n[AUTH] Logging in to get JWT token..." -ForegroundColor Cyan
$loginResponse = curl -s -X POST "$API_URL/auth/login" `
  -H "Content-Type: application/json" `
  -d '{
    "username": "admin",
    "password": "admin123"
  }'
$loginData = $loginResponse | ConvertFrom-Json
$TOKEN = $loginData.data.accessToken

if (-not $TOKEN) {
  Write-Host "ERROR: Failed to get authentication token" -ForegroundColor Red
  Write-Host "Login response: $loginResponse" -ForegroundColor Red
  exit 1
}

Write-Host "✓ Successfully authenticated" -ForegroundColor Green
Start-Sleep -Milliseconds 500

# ============================================================================
# Test 1: Cost Estimation (Virtual Fleet) - PUBLIC endpoint (no auth)
# ============================================================================
Write-Host "`n[TEST 1] POST /fleets/virtual/estimate - Estimate virtual fleet cost (PUBLIC)" -ForegroundColor Yellow
$response1 = curl -s -X POST "$API_URL/fleets/virtual/estimate" `
  -H "Content-Type: application/json" `
  -d '{
    "agent_count": 5,
    "devices_per_agent": 10,
    "billing_mode": "hourly"
  }'
Write-Host $response1 | ConvertFrom-Json | ConvertTo-Json -Depth 10
Start-Sleep -Milliseconds 500

# ============================================================================
# Test 2: Create Physical Fleet
# ============================================================================
Write-Host "`n[TEST 2] POST /fleets - Create physical fleet" -ForegroundColor Yellow
$response2 = curl -s -X POST "$API_URL/fleets" `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer $TOKEN" `
  -d "{
    `"fleet_name`": `"Factory Floor Sensors`",
    `"customer_id`": `"$CUSTOMER_ID`",
    `"fleet_type`": `"physical`",
    `"description`": `"Production line monitoring - Building A`",
    `"environment`": `"production`",
    `"location`": `"Toronto Manufacturing Plant`",
    `"tags`": {
      `"department`": `"manufacturing`",
      `"cost_center`": `"CC-1234`"
    }
  }"
$fleet2 = $response2 | ConvertFrom-Json
Write-Host $response2 | ConvertFrom-Json | ConvertTo-Json -Depth 10
$PHYSICAL_FLEET_ID = $fleet2.fleet_id
Write-Host "`nCreated Physical Fleet ID: $PHYSICAL_FLEET_ID" -ForegroundColor Green
Start-Sleep -Milliseconds 500

# ============================================================================
# Test 3: Create Virtual Fleet
# ============================================================================
Write-Host "`n[TEST 3] POST /fleets - Create virtual fleet with billing" -ForegroundColor Yellow
$response3 = curl -s -X POST "$API_URL/fleets" `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer $TOKEN" `
  -d "{
    `"fleet_name`": `"Development Environment`",
    `"customer_id`": `"$CUSTOMER_ID`",
    `"fleet_type`": `"virtual`",
    `"description`": `"Testing and development virtual agents`",
    `"environment`": `"development`",
    `"billing_enabled`": true,
    `"billing_mode`": `"hourly`",
    `"budget_limit`": 50.00,
    `"tags`": {
      `"team`": `"engineering`",
      `"project`": `"iot-platform`"
    }
  }"
$fleet3 = $response3 | ConvertFrom-Json
Write-Host $response3 | ConvertFrom-Json | ConvertTo-Json -Depth 10
$VIRTUAL_FLEET_ID = $fleet3.fleet_id
Write-Host "`nCreated Virtual Fleet ID: $VIRTUAL_FLEET_ID" -ForegroundColor Green
Start-Sleep -Milliseconds 500

# ============================================================================
# Test 4: List All Fleets
# ============================================================================
Write-Host "`n[TEST 4] GET /fleets - List all fleets" -ForegroundColor Yellow
$response4 = curl -s "$API_URL/fleets?customer_id=$CUSTOMER_ID" `
  -H "Authorization: Bearer $TOKEN"
Write-Host $response4 | ConvertFrom-Json | ConvertTo-Json -Depth 10
Start-Sleep -Milliseconds 500

# ============================================================================
# Test 5: List Fleets by Type (Physical)
# ============================================================================
Write-Host "`n[TEST 5] GET /fleets?fleet_type=physical - List physical fleets only" -ForegroundColor Yellow
$response5 = curl -s "$API_URL/fleets?customer_id=$CUSTOMER_ID&fleet_type=physical" `
  -H "Authorization: Bearer $TOKEN"
Write-Host $response5 | ConvertFrom-Json | ConvertTo-Json -Depth 10
Start-Sleep -Milliseconds 500

# ============================================================================
# Test 6: Get Physical Fleet Details
# ============================================================================
Write-Host "`n[TEST 6] GET /fleets/:fleet_id - Get physical fleet details" -ForegroundColor Yellow
$response6 = curl -s "$API_URL/fleets/$PHYSICAL_FLEET_ID" `
  -H "Authorization: Bearer $TOKEN"
Write-Host $response6 | ConvertFrom-Json | ConvertTo-Json -Depth 10
Start-Sleep -Milliseconds 500

# ============================================================================
# Test 7: Get Virtual Fleet Details
# ============================================================================
Write-Host "`n[TEST 7] GET /fleets/:fleet_id - Get virtual fleet details" -ForegroundColor Yellow
$response7 = curl -s "$API_URL/fleets/$VIRTUAL_FLEET_ID" `
  -H "Authorization: Bearer $TOKEN"
Write-Host $response7 | ConvertFrom-Json | ConvertTo-Json -Depth 10
Start-Sleep -Milliseconds 500

# ============================================================================
# Test 8: Update Fleet
# ============================================================================
Write-Host "`n[TEST 8] PATCH /fleets/:fleet_id - Update fleet" -ForegroundColor Yellow
$response8 = curl -s -X PATCH "$API_URL/fleets/$PHYSICAL_FLEET_ID" `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer $TOKEN" `
  -d '{
    "description": "UPDATED: Production line monitoring - Building A - Floor 2",
    "budget_limit": 100.00,
    "tags": {
      "department": "manufacturing",
      "cost_center": "CC-1234",
      "updated": "true"
    }
  }'
Write-Host $response8 | ConvertFrom-Json | ConvertTo-Json -Depth 10
Start-Sleep -Milliseconds 500

# ============================================================================
# Test 9: Stop Virtual Fleet
# ============================================================================
Write-Host "`n[TEST 9] POST /fleets/:fleet_id/stop - Stop virtual fleet" -ForegroundColor Yellow
$response9 = curl -s -X POST "$API_URL/fleets/$VIRTUAL_FLEET_ID/stop" `
  -H "Authorization: Bearer $TOKEN"
Write-Host $response9 | ConvertFrom-Json | ConvertTo-Json -Depth 10
Start-Sleep -Milliseconds 500

# ============================================================================
# Test 10: Get Fleet Billing Summary
# ============================================================================
Write-Host "`n[TEST 10] GET /fleets/:fleet_id/billing - Get billing summary" -ForegroundColor Yellow
$response10 = curl -s "$API_URL/fleets/$VIRTUAL_FLEET_ID/billing" `
  -H "Authorization: Bearer $TOKEN"
Write-Host $response10 | ConvertFrom-Json | ConvertTo-Json -Depth 10
Start-Sleep -Milliseconds 500

# ============================================================================
# Test 11: Start Virtual Fleet
# ============================================================================
Write-Host "`n[TEST 11] POST /fleets/:fleet_id/start - Start virtual fleet" -ForegroundColor Yellow
$response11 = curl -s -X POST "$API_URL/fleets/$VIRTUAL_FLEET_ID/start" `
  -H "Authorization: Bearer $TOKEN"
Write-Host $response11 | ConvertFrom-Json | ConvertTo-Json -Depth 10
Start-Sleep -Milliseconds 500

# ============================================================================
# Test 12: Get Usage Events
# ============================================================================
Write-Host "`n[TEST 12] GET /fleets/:fleet_id/usage-events - Get usage event history" -ForegroundColor Yellow
$response12 = curl -s "$API_URL/fleets/$VIRTUAL_FLEET_ID/usage-events?limit=10" `
  -H "Authorization: Bearer $TOKEN"
Write-Host $response12 | ConvertFrom-Json | ConvertTo-Json -Depth 10
Start-Sleep -Milliseconds 500

# ============================================================================
# Test 13: List Fleets by Environment
# ============================================================================
Write-Host "`n[TEST 13] GET /fleets?environment=production - List production fleets" -ForegroundColor Yellow
$response13 = curl -s "$API_URL/fleets?customer_id=$CUSTOMER_ID&environment=production" `
  -H "Authorization: Bearer $TOKEN"
Write-Host $response13 | ConvertFrom-Json | ConvertTo-Json -Depth 10
Start-Sleep -Milliseconds 500

# ============================================================================
# Test 14: Delete Virtual Fleet
# ============================================================================
Write-Host "`n[TEST 14] DELETE /fleets/:fleet_id - Delete virtual fleet" -ForegroundColor Yellow
$response14 = curl -s -X DELETE "$API_URL/fleets/$VIRTUAL_FLEET_ID" `
  -H "Authorization: Bearer $TOKEN"
Write-Host $response14 | ConvertFrom-Json | ConvertTo-Json -Depth 10
Start-Sleep -Milliseconds 500

# ============================================================================
# Test 15: Verify Deletion (should not appear in active fleets)
# ============================================================================
Write-Host "`n[TEST 15] GET /fleets - Verify deleted fleet doesn't appear" -ForegroundColor Yellow
$response15 = curl -s "$API_URL/fleets?customer_id=$CUSTOMER_ID" `
  -H "Authorization: Bearer $TOKEN"
Write-Host $response15 | ConvertFrom-Json | ConvertTo-Json -Depth 10

# ============================================================================
# Summary
# ============================================================================
Write-Host "`n==================================================" -ForegroundColor Cyan
Write-Host "Test Summary" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Physical Fleet ID: $PHYSICAL_FLEET_ID" -ForegroundColor Green
Write-Host "Virtual Fleet ID: $VIRTUAL_FLEET_ID (deleted)" -ForegroundColor Yellow
Write-Host "`nAll tests completed!" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Cyan
