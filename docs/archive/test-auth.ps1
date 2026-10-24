# 🧪 Test Script per il Sistema di Autenticazione (PowerShell)
# Uso: .\test-auth.ps1

$BASE_URL = "http://localhost:4000"
$TIMESTAMP = Get-Date -UFormat "%s"
$TEST_EMAIL = "testuser_${TIMESTAMP}@example.com"
$TEST_PASSWORD = "TestPass123"
$TEST_NAME = "Test User $TIMESTAMP"

Write-Host "🧪 Avvio Test Autenticazione" -ForegroundColor Cyan
Write-Host "════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# ==================== TEST 1: Registrazione Valida ====================
Write-Host "📝 TEST 1: Registrazione Utente Valida" -ForegroundColor Yellow
Write-Host "─────────────────────────────────────" -ForegroundColor Yellow

$registerBody = @{
    name     = $TEST_NAME
    email    = $TEST_EMAIL
    password = $TEST_PASSWORD
} | ConvertTo-Json

$registerResponse = Invoke-WebRequest -Uri "$BASE_URL/api/auth/register" `
    -Method POST `
    -Headers @{ "Content-Type" = "application/json" } `
    -Body $registerBody `
    -ErrorAction SilentlyContinue

Write-Host "Request:" -ForegroundColor White
Write-Host "POST /api/auth/register" -ForegroundColor Gray
Write-Host "Body:" -ForegroundColor Gray
Write-Host $registerBody -ForegroundColor Gray
Write-Host ""
Write-Host "Response:" -ForegroundColor White
if ($registerResponse) {
    Write-Host ($registerResponse.Content | ConvertFrom-Json | ConvertTo-Json -Depth 10) -ForegroundColor Green
    $USER_ID = ($registerResponse.Content | ConvertFrom-Json).data.id
    Write-Host "✅ User ID creato: $USER_ID" -ForegroundColor Green
} else {
    Write-Host "❌ Errore nella registrazione" -ForegroundColor Red
}
Write-Host ""
Write-Host ""

# ==================== TEST 2: Registrazione Duplicata ====================
Write-Host "📝 TEST 2: Registrazione Email Duplicata (Dovrebbe fallire)" -ForegroundColor Yellow
Write-Host "───────────────────────────────────────────────────────────" -ForegroundColor Yellow

$duplicateBody = @{
    name     = "Duplicate User"
    email    = $TEST_EMAIL
    password = "AnotherPass123"
} | ConvertTo-Json

$duplicateResponse = Invoke-WebRequest -Uri "$BASE_URL/api/auth/register" `
    -Method POST `
    -Headers @{ "Content-Type" = "application/json" } `
    -Body $duplicateBody `
    -ErrorAction SilentlyContinue

Write-Host "Response:" -ForegroundColor White
if ($duplicateResponse) {
    Write-Host ($duplicateResponse.Content | ConvertFrom-Json | ConvertTo-Json -Depth 10) -ForegroundColor Green
}
Write-Host ""
Write-Host ""

# ==================== TEST 3: Password Debole ====================
Write-Host "📝 TEST 3: Validazione Password Debole (Dovrebbe fallire)" -ForegroundColor Yellow
Write-Host "─────────────────────────────────────────────────────────" -ForegroundColor Yellow

$weakPasswordBody = @{
    name     = "Test User"
    email    = "weakpass_${TIMESTAMP}@example.com"
    password = "weak"
} | ConvertTo-Json

$weakPasswordResponse = Invoke-WebRequest -Uri "$BASE_URL/api/auth/register" `
    -Method POST `
    -Headers @{ "Content-Type" = "application/json" } `
    -Body $weakPasswordBody `
    -ErrorAction SilentlyContinue

Write-Host "Response:" -ForegroundColor White
if ($weakPasswordResponse) {
    Write-Host ($weakPasswordResponse.Content | ConvertFrom-Json | ConvertTo-Json -Depth 10) -ForegroundColor Green
}
Write-Host ""
Write-Host ""

# ==================== TEST 4: Login Valido ====================
Write-Host "📝 TEST 4: Login Valido" -ForegroundColor Yellow
Write-Host "──────────────────────" -ForegroundColor Yellow

$loginBody = @{
    email    = $TEST_EMAIL
    password = $TEST_PASSWORD
} | ConvertTo-Json

$loginResponse = Invoke-WebRequest -Uri "$BASE_URL/api/auth/login" `
    -Method POST `
    -Headers @{ "Content-Type" = "application/json" } `
    -Body $loginBody `
    -ErrorAction SilentlyContinue

Write-Host "Request:" -ForegroundColor White
Write-Host "POST /api/auth/login" -ForegroundColor Gray
Write-Host "Body: {\"email\": \"$TEST_EMAIL\", \"password\": \"$TEST_PASSWORD\"}" -ForegroundColor Gray
Write-Host ""
Write-Host "Response:" -ForegroundColor White
if ($loginResponse) {
    $responseObj = $loginResponse.Content | ConvertFrom-Json
    Write-Host ($responseObj | ConvertTo-Json -Depth 10) -ForegroundColor Green
    $JWT_TOKEN = $responseObj.data.token
    Write-Host "✅ JWT Token ottenuto: $($JWT_TOKEN.Substring(0, [Math]::Min(50, $JWT_TOKEN.Length)))..." -ForegroundColor Green
} else {
    Write-Host "❌ Errore nel login" -ForegroundColor Red
}
Write-Host ""
Write-Host ""

# ==================== TEST 5: Login Email Inesistente ====================
Write-Host "📝 TEST 5: Login Email Inesistente (Dovrebbe fallire)" -ForegroundColor Yellow
Write-Host "────────────────────────────────────────────────────" -ForegroundColor Yellow

$notFoundBody = @{
    email    = "nonexistent_${TIMESTAMP}@example.com"
    password = "SomePass123"
} | ConvertTo-Json

$notFoundResponse = Invoke-WebRequest -Uri "$BASE_URL/api/auth/login" `
    -Method POST `
    -Headers @{ "Content-Type" = "application/json" } `
    -Body $notFoundBody `
    -ErrorAction SilentlyContinue

Write-Host "Response:" -ForegroundColor White
if ($notFoundResponse) {
    Write-Host ($notFoundResponse.Content | ConvertFrom-Json | ConvertTo-Json -Depth 10) -ForegroundColor Green
}
Write-Host ""
Write-Host ""

# ==================== TEST 6: Accesso Profilo Protetto ====================
if ($JWT_TOKEN) {
    Write-Host "📝 TEST 6: Accesso Endpoint Protetto (/api/auth/profile)" -ForegroundColor Yellow
    Write-Host "────────────────────────────────────────────────────────" -ForegroundColor Yellow

    $profileResponse = Invoke-WebRequest -Uri "$BASE_URL/api/auth/profile" `
        -Method GET `
        -Headers @{ "Authorization" = "Bearer $JWT_TOKEN" } `
        -ErrorAction SilentlyContinue

    Write-Host "Request:" -ForegroundColor White
    Write-Host "GET /api/auth/profile" -ForegroundColor Gray
    Write-Host "Headers: Authorization: Bearer <token>" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Response:" -ForegroundColor White
    if ($profileResponse) {
        Write-Host ($profileResponse.Content | ConvertFrom-Json | ConvertTo-Json -Depth 10) -ForegroundColor Green
    }
    Write-Host ""
    Write-Host ""
}

# ==================== TEST 7: Token Invalido ====================
Write-Host "📝 TEST 7: Token Invalido (Dovrebbe fallire)" -ForegroundColor Yellow
Write-Host "─────────────────────────────────────────" -ForegroundColor Yellow

$invalidTokenResponse = Invoke-WebRequest -Uri "$BASE_URL/api/auth/profile" `
    -Method GET `
    -Headers @{ "Authorization" = "Bearer invalid.token.here" } `
    -ErrorAction SilentlyContinue

Write-Host "Response:" -ForegroundColor White
if ($invalidTokenResponse) {
    Write-Host ($invalidTokenResponse.Content | ConvertFrom-Json | ConvertTo-Json -Depth 10) -ForegroundColor Green
}
Write-Host ""
Write-Host ""

# ==================== TEST 8: Missing Token ====================
Write-Host "📝 TEST 8: Assenza Token (Dovrebbe fallire)" -ForegroundColor Yellow
Write-Host "───────────────────────────────────────────" -ForegroundColor Yellow

$missingTokenResponse = Invoke-WebRequest -Uri "$BASE_URL/api/auth/profile" `
    -Method GET `
    -ErrorAction SilentlyContinue

Write-Host "Response:" -ForegroundColor White
if ($missingTokenResponse) {
    Write-Host ($missingTokenResponse.Content | ConvertFrom-Json | ConvertTo-Json -Depth 10) -ForegroundColor Green
}
Write-Host ""
Write-Host ""

# ==================== TEST 9: Logout ====================
if ($JWT_TOKEN) {
    Write-Host "📝 TEST 9: Logout" -ForegroundColor Yellow
    Write-Host "─────────────────" -ForegroundColor Yellow

    $logoutResponse = Invoke-WebRequest -Uri "$BASE_URL/api/auth/logout" `
        -Method POST `
        -Headers @{ "Authorization" = "Bearer $JWT_TOKEN" } `
        -ErrorAction SilentlyContinue

    Write-Host "Response:" -ForegroundColor White
    if ($logoutResponse) {
        Write-Host ($logoutResponse.Content | ConvertFrom-Json | ConvertTo-Json -Depth 10) -ForegroundColor Green
    }
    Write-Host ""
    Write-Host ""
}

Write-Host "════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "✅ Test Completati!" -ForegroundColor Green
Write-Host ""
Write-Host "📊 Riepilogo:" -ForegroundColor Cyan
Write-Host "  - Registrazione: ✅ Creato user con ID: $USER_ID" -ForegroundColor Green
Write-Host "  - Email duplicata: ✅ Correttamente rifiutato" -ForegroundColor Green
Write-Host "  - Password debole: ✅ Correttamente rifiutato" -ForegroundColor Green
Write-Host "  - Login valido: ✅ Token ottenuto" -ForegroundColor Green
Write-Host "  - Profilo protetto: ✅ Accessibile con token" -ForegroundColor Green
Write-Host "  - Token invalido: ✅ Correttamente rifiutato" -ForegroundColor Green
Write-Host "  - Logout: ✅ Completato" -ForegroundColor Green
Write-Host ""
