$ErrorActionPreference = "Stop"

Write-Host "`n🧪 Testing Deployment Queue`n" -ForegroundColor Cyan

$API_URL = "http://localhost:3100"

# Test 1: Create customer (triggers queue job)
Write-Host "Test 1: Create customer and queue deployment..." -ForegroundColor Yellow
$signup = Invoke-RestMethod -Method POST -Uri "$API_URL/api/customers/signup" `
  -ContentType "application/json" `
  -Body (@{
    email = "queue-test-$(Get-Date -Format 'yyyyMMddHHmmss')@example.com"
    password = "TestPass123"
    company_name = "Queue Test Corp"
  } | ConvertTo-Json)

$customerId = $signup.customer.customer_id
$jobId = $signup.deployment.job_id

Write-Host "✅ Customer created: $customerId" -ForegroundColor Green
Write-Host "✅ Job queued: $jobId" -ForegroundColor Green
Write-Host "✅ Instance URL: $($signup.deployment.instance_url)" -ForegroundColor Green

# Test 2: Check job status
Start-Sleep -Seconds 2
Write-Host "`nTest 2: Check job status..." -ForegroundColor Yellow
$job = Invoke-RestMethod -Uri "$API_URL/api/queue/jobs/$jobId"

Write-Host "Job ID: $($job.id)" -ForegroundColor White
Write-Host "State: $($job.state)" -ForegroundColor White
Write-Host "Progress: $($job.progress)%" -ForegroundColor White
Write-Host "Attempts: $($job.attempts)/$($job.maxAttempts)" -ForegroundColor White

# Test 3: Get queue stats
Write-Host "`nTest 3: Get queue statistics..." -ForegroundColor Yellow
$stats = Invoke-RestMethod -Uri "$API_URL/api/queue/stats"

Write-Host "Waiting: $($stats.waiting)" -ForegroundColor White
Write-Host "Active: $($stats.active)" -ForegroundColor White
Write-Host "Completed: $($stats.completed)" -ForegroundColor White
Write-Host "Failed: $($stats.failed)" -ForegroundColor White
Write-Host "Total: $($stats.total)" -ForegroundColor White

# Test 4: Get customer jobs
Write-Host "`nTest 4: Get all jobs for customer..." -ForegroundColor Yellow
$customerJobs = Invoke-RestMethod -Uri "$API_URL/api/queue/customer/$customerId/jobs"

Write-Host "Found $($customerJobs.jobs.Count) job(s) for customer $customerId" -ForegroundColor White
foreach ($job in $customerJobs.jobs) {
  Write-Host "  - Job $($job.id): $($job.name) - $($job.state)" -ForegroundColor Gray
}

# Test 5: Wait for completion (optional)
if ($env:WAIT_FOR_COMPLETION -eq "true") {
  Write-Host "`nTest 5: Waiting for deployment to complete..." -ForegroundColor Yellow
  $maxWait = 300  # 5 minutes
  $waited = 0

  while ($waited -lt $maxWait) {
    $job = Invoke-RestMethod -Uri "$API_URL/api/queue/jobs/$jobId"
    
    if ($job.state -eq "completed") {
      Write-Host "✅ Deployment completed!" -ForegroundColor Green
      break
    }
    
    if ($job.state -eq "failed") {
      Write-Host "❌ Deployment failed: $($job.failedReason)" -ForegroundColor Red
      exit 1
    }
    
    Write-Host "⏳ Status: $($job.state) - Progress: $($job.progress)%" -ForegroundColor Yellow
    Start-Sleep -Seconds 10
    $waited += 10
  }

  if ($waited -ge $maxWait) {
    Write-Host "⚠️  Timeout waiting for deployment" -ForegroundColor Yellow
  }
}

Write-Host "`n🎉 ALL QUEUE TESTS PASSED!" -ForegroundColor Green
Write-Host "`nNext steps:" -ForegroundColor Cyan
Write-Host "  1. Check job status: curl $API_URL/api/queue/jobs/$jobId" -ForegroundColor White
Write-Host "  2. View queue stats: curl $API_URL/api/queue/stats" -ForegroundColor White
Write-Host "  3. Set WAIT_FOR_COMPLETION=true to wait for deployment" -ForegroundColor White
