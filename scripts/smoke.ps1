# Quick checks against a locally running API on :4000
# Run:  & "C:\Program Files\nodejs\node.exe" apps\api\dist\server.js   (in one window)
# then: powershell -ExecutionPolicy Bypass -File scripts\smoke.ps1     (in another)

$base = 'http://localhost:4000'
$script:pass = 0
$script:fail = 0

function Check($name, [scriptblock]$test) {
  try {
    & $test
    Write-Host "PASS  $name" -ForegroundColor Green
    $script:pass++
  } catch {
    Write-Host "FAIL  $name  ->  $($_.Exception.Message)" -ForegroundColor Red
    $script:fail++
  }
}

function Expect-Status($url, $method, $body, $want) {
  try {
    Invoke-WebRequest $url -Method $method -Body $body -ContentType 'application/json' -UseBasicParsing | Out-Null
    throw "expected HTTP $want but the request succeeded"
  } catch {
    $resp = $_.Exception.Response
    if (-not $resp) { throw $_.Exception.Message }
    $got = [int]$resp.StatusCode
    if ($got -ne $want) { throw "expected HTTP $want, got $got" }
  }
}

Check "GET /health -> { ok: true }" {
  $r = Invoke-RestMethod "$base/health"
  if (-not $r.ok) { throw "body was $($r | ConvertTo-Json -Compress)" }
}

Check "POST /api/webhooks/stripe unsigned -> 400" {
  Expect-Status "$base/api/webhooks/stripe" 'Post' '{}' 400
}

Check "POST /api/onboarding/claim malformed -> 422" {
  Expect-Status "$base/api/onboarding/claim" 'Post' '{"token":"x"}' 422
}

Check "POST /api/onboarding/claim unknown token -> 400" {
  $body = @{ token = ('z' * 40); password = 'correct-horse-battery' } | ConvertTo-Json
  try {
    Expect-Status "$base/api/onboarding/claim" 'Post' $body 400
  } catch {
    throw "$($_.Exception.Message)  (a 500 here means SUPABASE_SERVICE_ROLE_KEY in apps\api\.env is still REPLACE_ME)"
  }
}

Write-Host ""
Write-Host "$script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }
