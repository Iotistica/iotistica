#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Generate a single provisioning key and print it to stdout.
.DESCRIPTION
    Inserts a new provisioning key directly into the database and outputs only the raw key.
    Defaults target the self-hosted stack (docker-compose.self.yml).
.EXAMPLE
    .\generate-provisioning-key.ps1
.EXAMPLE
    .\generate-provisioning-key.ps1 -DbPassword "secret"
.EXAMPLE
    .\generate-provisioning-key.ps1 -DbHost 20.220.137.172 -DbName demo -DbUser billing -DbPassword "pass"
#>

param(
    [string]$DbHost     = "localhost",
    [int]$DbPort        = 5433,
    [string]$DbName     = "iotistica",
    [string]$DbUser     = "postgres",
    [string]$DbPassword = "change-me",
    [string]$DbSslMode  = "",
    [string]$DatabaseUrl = "",
    [string]$FleetUuid  = ""
)

$ErrorActionPreference = "Stop"

# ── Locate psql ───────────────────────────────────────────────────────────────
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    $pgBinCandidates = 14..20 | ForEach-Object { "C:\Program Files\PostgreSQL\$_\bin" }
    $found = $pgBinCandidates | Where-Object { Test-Path "$_\psql.exe" } | Select-Object -First 1
    if ($found) { $env:PATH = "$env:PATH;$found" }
}
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    Write-Error "psql not found. Install PostgreSQL client tools or add psql to PATH."
    exit 1
}

# ── Helpers ───────────────────────────────────────────────────────────────────
function Get-ConnectionString {
    if (-not [string]::IsNullOrWhiteSpace($DatabaseUrl)) { return $DatabaseUrl }
    $ssl = if ([string]::IsNullOrWhiteSpace($DbSslMode)) { "" } else { " sslmode=$DbSslMode" }
    return "host=$DbHost port=$DbPort dbname=$DbName user=$DbUser$ssl"
}

function Get-FleetUuid {
    $env:PGPASSWORD = $DbPassword
    $cs = Get-ConnectionString

    if (-not [string]::IsNullOrWhiteSpace($FleetUuid)) {
        $escaped = $FleetUuid -replace "'", "''"
        $existing = psql -d $cs -t -A -q -c "SELECT fleet_uuid::text FROM fleets WHERE fleet_uuid = '$escaped'::uuid LIMIT 1" 2>&1
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($existing)) {
            return $existing.Trim()
        }
    }

    $query = @"
SELECT fleet_uuid::text FROM fleets
WHERE lower(COALESCE(fleet_id,'')) IN ('default','default-fleet')
   OR lower(COALESCE(fleet_name,'')) IN ('default','default fleet')
ORDER BY CASE
    WHEN lower(COALESCE(fleet_id,'')) = 'default-fleet' THEN 1
    WHEN lower(COALESCE(fleet_name,'')) = 'default fleet' THEN 2
    ELSE 3 END, created_at ASC LIMIT 1;
"@
    $existing = psql -d $cs -t -A -q -c $query 2>&1
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($existing)) {
        return $existing.Trim()
    }

    $newUuid = [guid]::NewGuid().ToString()
    $escaped = $newUuid -replace "'", "''"
    $customerId = '00000000-0000-0000-0000-000000000001'
    $sql = @"
INSERT INTO fleets (fleet_uuid,fleet_id,fleet_name,customer_id,fleet_type,description,status,created_by,created_at,updated_at)
VALUES ('$escaped'::uuid,'default-fleet','Default Fleet','$customerId'::uuid,'physical',
        'Auto-created by generate-provisioning-key.ps1','active','generate-provisioning-key.ps1',NOW(),NOW());
"@
    psql -d $cs -v ON_ERROR_STOP=1 -q -c $sql 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Error "Failed to create default fleet."; exit 1 }
    return $newUuid
}

function New-ProvisioningKey ([string]$resolvedFleetUuid) {
    $env:PGPASSWORD = $DbPassword
    $cs = Get-ConnectionString

    # Generate raw key
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    $key = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''

    # Resolve pepper
    $pepper = $env:SECRET_DIGEST_PEPPER
    if ([string]::IsNullOrWhiteSpace($pepper)) { $pepper = $env:JWT_SECRET }
    if ([string]::IsNullOrWhiteSpace($pepper)) {
        $envFile = Join-Path $PSScriptRoot ".." ".env.self"
        if (-not (Test-Path $envFile)) { $envFile = Join-Path $PSScriptRoot ".." ".env" }
        if (Test-Path $envFile) {
            foreach ($line in (Get-Content $envFile)) {
                if ($line -match '^\s*#') { continue }
                if ($line -match '^\s*SECRET_DIGEST_PEPPER\s*=\s*(.+)$') { $pepper = $matches[1].Trim().Trim('"'); break }
                if ([string]::IsNullOrWhiteSpace($pepper) -and $line -match '^\s*JWT_SECRET\s*=\s*(.+)$') { $pepper = $matches[1].Trim().Trim('"') }
            }
        }
    }
    if ([string]::IsNullOrWhiteSpace($pepper)) { $pepper = 'iotistic-dev-secret-digest-pepper' }

    # Compute HMAC-SHA256
    $hmac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($pepper))
    try {
        $digest = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("provisioning-key:$key"))
    } finally { $hmac.Dispose() }
    $keyHashFast = ([System.BitConverter]::ToString($digest)).Replace('-','').ToLowerInvariant()
    $keyHash = "hmac-sha256`$provisioning-key`$$keyHashFast"

    # Detect available columns
    $hasKeyHashFast = psql -d $cs -t -A -q -c "SELECT 1 FROM information_schema.columns WHERE table_name='provisioning_keys' AND column_name='key_hash_fast'" 2>&1
    $hasFleetUuid   = psql -d $cs -t -A -q -c "SELECT 1 FROM information_schema.columns WHERE table_name='provisioning_keys' AND column_name='fleet_uuid'" 2>&1
    $hasFleetId     = psql -d $cs -t -A -q -c "SELECT 1 FROM information_schema.columns WHERE table_name='provisioning_keys' AND column_name='fleet_id'" 2>&1

    $ek  = $key          -replace "'","''"
    $ekh = $keyHash      -replace "'","''"
    $ekhf= $keyHashFast  -replace "'","''"
    $efu = $resolvedFleetUuid -replace "'","''"

    $cols = @('key_hash','description','max_agents','expires_at','created_by')
    $vals = @("'$ekh'","'Script-generated provisioning key'","1","NOW() + interval '30 days'","'script'")

    if ($hasKeyHashFast -match '1') { $cols += 'key_hash_fast'; $vals += "'$ekhf'" }
    if ($hasFleetUuid   -match '1') { $cols += 'fleet_uuid';    $vals += if ($efu) { "'$efu'::uuid" } else { 'NULL' } }
    if ($hasFleetId     -match '1') { $cols += 'fleet_id';      $vals += if ($efu) { "'$efu'" }       else { 'NULL' } }

    $sql = "INSERT INTO provisioning_keys ($($cols -join ',')) VALUES ($($vals -join ',')) RETURNING id;"
    $result = psql -d $cs -v ON_ERROR_STOP=1 -t -A -q -c $sql 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Error "Failed to insert provisioning key: $result"; exit 1 }

    return $key
}

# ── Main ──────────────────────────────────────────────────────────────────────
$fleetUuid = Get-FleetUuid
$key = New-ProvisioningKey -resolvedFleetUuid $fleetUuid
Write-Output $key
