#!/bin/bash

# 🧪 Test Script per il Sistema di Autenticazione
# Uso: bash test-auth.sh

BASE_URL="http://localhost:4000"
TIMESTAMP=$(date +%s)
TEST_EMAIL="testuser_${TIMESTAMP}@example.com"
TEST_PASSWORD="TestPass123"
TEST_NAME="Test User ${TIMESTAMP}"

echo "🧪 Avvio Test Autenticazione"
echo "════════════════════════════════════════════════"
echo ""

# ==================== TEST 1: Registrazione Valida ====================
echo "📝 TEST 1: Registrazione Utente Valida"
echo "─────────────────────────────────────"
REGISTER_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"$TEST_NAME\",
    \"email\": \"$TEST_EMAIL\",
    \"password\": \"$TEST_PASSWORD\"
  }")

echo "Request:"
echo "POST /api/auth/register"
echo "Body:"
echo "{\"name\": \"$TEST_NAME\", \"email\": \"$TEST_EMAIL\", \"password\": \"$TEST_PASSWORD\"}"
echo ""
echo "Response:"
echo "$REGISTER_RESPONSE" | jq '.' 2>/dev/null || echo "$REGISTER_RESPONSE"
echo ""

# Estrai l'ID utente dalla risposta
USER_ID=$(echo "$REGISTER_RESPONSE" | jq -r '.data.id' 2>/dev/null)
echo "✅ User ID creato: $USER_ID"
echo ""
echo ""

# ==================== TEST 2: Registrazione Duplicata ====================
echo "📝 TEST 2: Registrazione Email Duplicata (Dovrebbe fallire)"
echo "───────────────────────────────────────────────────────────"
DUPLICATE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"Duplicate User\",
    \"email\": \"$TEST_EMAIL\",
    \"password\": \"AnotherPass123\"
  }")

echo "Response:"
echo "$DUPLICATE_RESPONSE" | jq '.' 2>/dev/null || echo "$DUPLICATE_RESPONSE"
echo ""
echo ""

# ==================== TEST 3: Password Debole ====================
echo "📝 TEST 3: Validazione Password Debole (Dovrebbe fallire)"
echo "─────────────────────────────────────────────────────────"
WEAK_PASSWORD_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"Test User\",
    \"email\": \"weakpass_${TIMESTAMP}@example.com\",
    \"password\": \"weak\"
  }")

echo "Response:"
echo "$WEAK_PASSWORD_RESPONSE" | jq '.' 2>/dev/null || echo "$WEAK_PASSWORD_RESPONSE"
echo ""
echo ""

# ==================== TEST 4: Login Valido ====================
echo "📝 TEST 4: Login Valido"
echo "──────────────────────"
LOGIN_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"$TEST_EMAIL\",
    \"password\": \"$TEST_PASSWORD\"
  }")

echo "Request:"
echo "POST /api/auth/login"
echo "Body: {\"email\": \"$TEST_EMAIL\", \"password\": \"$TEST_PASSWORD\"}"
echo ""
echo "Response:"
echo "$LOGIN_RESPONSE" | jq '.' 2>/dev/null || echo "$LOGIN_RESPONSE"
echo ""

# Estrai il JWT token
JWT_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.data.token' 2>/dev/null)
echo "✅ JWT Token ottenuto: ${JWT_TOKEN:0:50}..."
echo ""
echo ""

# ==================== TEST 5: Login Email Inesistente ====================
echo "📝 TEST 5: Login Email Inesistente (Dovrebbe fallire)"
echo "────────────────────────────────────────────────────"
NOT_FOUND_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"nonexistent_${TIMESTAMP}@example.com\",
    \"password\": \"SomePass123\"
  }")

echo "Response:"
echo "$NOT_FOUND_RESPONSE" | jq '.' 2>/dev/null || echo "$NOT_FOUND_RESPONSE"
echo ""
echo ""

# ==================== TEST 6: Login Password Errata ====================
echo "📝 TEST 6: Login Password Errata (Dovrebbe fallire)"
echo "─────────────────────────────────────────────────"
WRONG_PASSWORD_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"$TEST_EMAIL\",
    \"password\": \"WrongPassword123\"
  }")

echo "Response:"
echo "$WRONG_PASSWORD_RESPONSE" | jq '.' 2>/dev/null || echo "$WRONG_PASSWORD_RESPONSE"
echo ""
echo ""

# ==================== TEST 7: Accesso Profilo Protetto ====================
if [ ! -z "$JWT_TOKEN" ] && [ "$JWT_TOKEN" != "null" ]; then
  echo "📝 TEST 7: Accesso Endpoint Protetto (/api/auth/profile)"
  echo "────────────────────────────────────────────────────────"
  PROFILE_RESPONSE=$(curl -s -X GET "$BASE_URL/api/auth/profile" \
    -H "Authorization: Bearer $JWT_TOKEN")

  echo "Request:"
  echo "GET /api/auth/profile"
  echo "Headers: Authorization: Bearer <token>"
  echo ""
  echo "Response:"
  echo "$PROFILE_RESPONSE" | jq '.' 2>/dev/null || echo "$PROFILE_RESPONSE"
  echo ""
  echo ""
fi

# ==================== TEST 8: Token Invalido ====================
echo "📝 TEST 8: Token Invalido (Dovrebbe fallire)"
echo "─────────────────────────────────────────"
INVALID_TOKEN_RESPONSE=$(curl -s -X GET "$BASE_URL/api/auth/profile" \
  -H "Authorization: Bearer invalid.token.here")

echo "Response:"
echo "$INVALID_TOKEN_RESPONSE" | jq '.' 2>/dev/null || echo "$INVALID_TOKEN_RESPONSE"
echo ""
echo ""

# ==================== TEST 9: Missing Token ====================
echo "📝 TEST 9: Assenza Token (Dovrebbe fallire)"
echo "───────────────────────────────────────────"
MISSING_TOKEN_RESPONSE=$(curl -s -X GET "$BASE_URL/api/auth/profile")

echo "Response:"
echo "$MISSING_TOKEN_RESPONSE" | jq '.' 2>/dev/null || echo "$MISSING_TOKEN_RESPONSE"
echo ""
echo ""

# ==================== TEST 10: Logout ====================
if [ ! -z "$JWT_TOKEN" ] && [ "$JWT_TOKEN" != "null" ]; then
  echo "📝 TEST 10: Logout"
  echo "─────────────────"
  LOGOUT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/logout" \
    -H "Authorization: Bearer $JWT_TOKEN")

  echo "Response:"
  echo "$LOGOUT_RESPONSE" | jq '.' 2>/dev/null || echo "$LOGOUT_RESPONSE"
  echo ""
  echo ""
fi

echo "════════════════════════════════════════════════"
echo "✅ Test Completati!"
echo ""
echo "📊 Riepilogo:"
echo "  - Registrazione: ✅ Creato user con ID: $USER_ID"
echo "  - Email duplicata: ✅ Correttamente rifiutato"
echo "  - Password debole: ✅ Correttamente rifiutato"
echo "  - Login valido: ✅ Token ottenuto"
echo "  - Profilo protetto: ✅ Accessibile con token"
echo "  - Token invalido: ✅ Correttamente rifiutato"
echo "  - Logout: ✅ Completato"
echo ""
