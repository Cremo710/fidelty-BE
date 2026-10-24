# 🔐 Sistema di Autenticazione Sicuro - Loyalty Bar Backend

## Panoramica Architettura

Questo backend implementa un sistema di autenticazione enterprise-grade con separazione netta delle responsabilità:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        FASTIFY ROUTES                                    │
├─────────────────────────────────────────────────────────────────────────┤
│ AUTH: POST /api/auth/register              POST /api/auth/login         │
│ BAR:  POST /api/bar/registration  GET /api/bar/profile  (Protected)    │
└──────────────────────────┬─────────────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────────┐
        │                  │                      │
┌───────▼──────┐  ┌────────▼──────────┐  ┌───────▼───────┐
│ AUTH         │  │ BAR CONTROLLER    │  │ VALIDATORS    │
│ CONTROLLER   │  │ (Bar registration)│  │ - Email       │
│ - Register   │  │ - Register        │  │ - Password    │
│ - Login      │  │ - GetBarByUser    │  │ - IVA format  │
│ - Profile    │  └────────┬──────────┘  │ - Address     │
└───────┬──────┘           │              └─────┬─────────┘
        │                  │                    │
        ├──────────────────┼────────────────────┤
        │                  │                    │
    ┌───▼──────┐    ┌──────▼──────┐  ┌─────────▼──────┐
    │ AUTH     │    │ BAR         │  │ MIDDLEWARE     │
    │ SERVICE  │    │ REPOSITORY  │  │ - JWT verify   │
    │ - Hash Pw│    │ - createBar │  │ - Extract ID   │
    │ - JWT    │    │ - findByUser│  └────────────────┘
    │ - Verify │    │ - updateBar │
    └───┬──────┘    └──────┬──────┘
        │                  │
        └──────────────────┼──────────────────┐
                           │                  │
                ┌──────────▼────────┐  ┌──────▼────────────┐
                │ USER REPOSITORY   │  │ SANITIZATION      │
                │ - findByEmail()   │  │ - SQL Injection   │
                │ - createUser()    │  │ - XSS patterns    │
                │ - updateUser()    │  │ - String limit    │
                └──────────────────┘  └───────────────────┘
                           │
                ┌──────────▼────────────┐
                │   DATABASE (PG)       │
                │  - utenti table       │
                │  - refresh_tokens     │
                │  - bars table         │
                └───────────────────────┘
```

## 🔑 Componenti Principali

### 1. **AuthService** (`src/services/authService.ts`)
- **Hash Password**: Utilizza `argon2` con parametri security-hardened
- **JWT Generation**: Firma con `HS256`, espirazione configurabile
- **Token Verification**: Validazione con tempo di scadenza
- **Singleton Pattern**: Un'istanza unica per l'intera applicazione

### 2. **AuthController** (`src/controllers/authController.ts`)
- **Register**: Validazione input → hash password → salvataggio DB
- **Login**: Recupero utente → verifica hash → generazione JWT
- **Logout**: Invalidamento token (implementazione futura con blacklist)
- **GetProfile**: Endpoint protetto per recuperare profilo utente

### 3. **UserRepository** (`src/repositories/userRepository.ts`)
- **Repository Pattern**: Astrae la logica di accesso ai dati
- **CRUD Operations**: create, read, update, delete su tabella `utenti`
- **Email Uniqueness**: Verifica duplicate prima della creazione
- **Transazioni**: Uso di BEGIN/COMMIT/ROLLBACK per data integrity

### 4. **BarController** (`src/controllers/barController.ts`)
- **Register**: Validazione input → verifica IVA unica → salvataggio DB
- **GetBarByUser**: Recupera dati del bar associato all'utente autenticato
- **Associazione Utente**: Lega ogni bar all'utente che l'ha registrato tramite `user_id`
- **Error Handling**: Gestisce casi di IVA duplicata e bar già esistente

### 5. **BarRepository** (`src/repositories/barRepository.ts`)
- **Repository Pattern**: Astrae la logica di accesso ai dati dei bar
- **CRUD Operations**: create, read, update, delete su tabella `bars`
- **IVA Uniqueness**: Verifica partita IVA univoca prima della creazione
- **User Association**: Mantiene il collegamento tra bar e utente tramite foreign key
- **Transazioni**: Uso di BEGIN/COMMIT/ROLLBACK per data integrity

### 6. **AuthValidator** (`src/validators/authValidator.ts`)
- **Zod Schema**: Validazione dichiarativa e type-safe
- **Email Format**: RFC compliant email validation
- **Password Rules**:
  - Minimo 8 caratteri
  - Almeno 1 maiuscola
  - Almeno 1 minuscola
  - Almeno 1 numero
- **Type Inference**: `RegisterInput` e `LoginInput` types

### 7. **BarValidator** (`src/validators/barValidator.ts`)
- **Zod Schema**: Validazione dichiarativa e type-safe
- **IVA Format**: Validazione stringa 11-20 caratteri
- **Merchant Name**: 2-255 caratteri
- **Address**: 5-500 caratteri per indirizzo completo
- **Image**: URL opzionale per immagine del locale
- **Type Inference**: `BarRegistrationInput` type

### 8. **AuthenticateToken Middleware** (`src/middleware/authenticateToken.ts`)
- **Bearer Token Extraction**: Legge `Authorization: Bearer <token>`
- **JWT Verification**: Valida firma e scadenza
- **Request Injection**: Aggiunge `userId` e `userEmail` al request
- **Error Handling**: Risposte HTTP 401 per token invalidi/scaduti

### 9. **Sanitization Utils** (`src/utils/sanitization.ts`)
- **SQL Injection Prevention**: Regex pattern detection
- **XSS Prevention**: Script tag e event handler detection
- **String Limiting**: Previene buffer overflow
- **Email Sanitization**: Normalizzazione case-insensitive

### 10. **Rate Limiting**
- **@fastify/rate-limit**: Protegge endpoint auth da brute-force
- **Configurazione**: 5 richieste per 15 minuti
- **Applicazione**: Globale su tutti gli endpoint

## 📊 Schema Database

```sql
-- Tabella utenti con indice su email per query veloci
CREATE TABLE utenti (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,  -- Indexed for quick lookup
  password TEXT NOT NULL,               -- Argon2 hash (non in chiaro!)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabella refresh_tokens per future implementazioni di token rotation
CREATE TABLE refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  revoked BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_utenti_email ON utenti(email);
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_token ON refresh_tokens(token);

-- Tabella bars per i locali registrati
CREATE TABLE bars (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
  iva VARCHAR(20) UNIQUE NOT NULL,           -- Partita IVA univoca
  merchant_name VARCHAR(255) NOT NULL,       -- Nome commerciale
  name VARCHAR(255) NOT NULL,                -- Nome del locale
  address VARCHAR(500) NOT NULL,             -- Indirizzo completo
  image TEXT,                                -- URL immagine del locale
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bars_user_id ON bars(user_id);
CREATE INDEX idx_bars_iva ON bars(iva);
```

## 🔐 Flusso di Sicurezza

### Registrazione (`POST /api/auth/register`)
```
1. Input Validation (Zod)
   └─> Email format? Password strength? Name length?
2. Duplicate Check
   └─> Email già registrata?
3. Password Hashing (Argon2)
   └─> hash = argon2(password, options)
4. Database Insert
   └─> Salva {name, email, hash}
5. Risposta HTTP 201
   └─> User ID + Email + Name (NO password!)
```

### Login (`POST /api/auth/login`)
```
1. Input Validation (Zod)
   └─> Email format? Password not empty?
2. User Lookup
   └─> SELECT * FROM utenti WHERE email = $1
3. Password Verification (Argon2)
   └─> argon2.verify(storedHash, inputPassword)
4. JWT Generation
   └─> token = jwt.sign({userId, email}, JWT_SECRET, {exp: "7d"})
5. Risposta HTTP 200
   └─> User data + JWT token
```

### Protected Endpoint (`GET /api/auth/profile`)
```
1. Request riceve Authorization header
   └─> "Authorization: Bearer eyJhbGc..."
2. Middleware Extract Token
   └─> token = header.substring(7)
3. JWT Verification
   └─> payload = jwt.verify(token, JWT_SECRET)
4. Validazione Scadenza
   └─> payload.exp > Date.now()?
5. Request Injection
   └─> request.userId = payload.userId
6. Handler esecuzione
   └─> return userProfile
```

### Registrazione Bar (`POST /api/bar/registration`) - Protected
```
1. JWT Verification (Middleware)
   └─> Valida token e estrae userId
2. Input Validation (Zod)
   └─> IVA format? Address length? Name valid?
3. Duplicate IVA Check
   └─> IVA già registrata?
4. User Bar Check
   └─> Utente ha già un bar registrato?
5. Database Insert
   └─> Salva {user_id, iva, merchant_name, name, address, image}
6. Risposta HTTP 201
   └─> Bar ID + dati registrati
```

## 🚀 Variabili d'Ambiente Richieste

```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/loyalty_bar

# JWT
JWT_SECRET=your-super-secret-key-min-32-chars-recommended
JWT_EXPIRY=7d

# Server
PORT=4000
HOST=0.0.0.0
NODE_ENV=development
```

## 📝 API Endpoints

### Public Endpoints

#### 1. Registrazione Utente
```bash
POST /api/auth/register
Content-Type: application/json

{
  "name": "Mario Rossi",
  "email": "mario@example.com",
  "password": "SecurePass123"
}

Response 201:
{
  "success": true,
  "message": "Utente registrato con successo",
  "data": {
    "id": 1,
    "email": "mario@example.com",
    "name": "Mario Rossi"
  }
}
```

#### 2. Login Utente
```bash
POST /api/auth/login
Content-Type: application/json

{
  "email": "mario@example.com",
  "password": "SecurePass123"
}

Response 200:
{
  "success": true,
  "message": "Login avvenuto con successo",
  "data": {
    "id": 1,
    "email": "mario@example.com",
    "name": "Mario Rossi",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

### Protected Endpoints (Richiedono JWT)

#### 3. Recupera Profilo Utente
```bash
GET /api/auth/profile
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

Response 200:
{
  "success": true,
  "data": {
    "id": 1,
    "email": "mario@example.com",
    "name": "Mario Rossi",
    "created_at": "2026-02-07T10:30:00Z",
    "updated_at": "2026-02-07T10:30:00Z"
  }
}
```

#### 4. Logout Utente
```bash
POST /api/auth/logout
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

Response 200:
{
  "success": true,
  "message": "Logout avvenuto con successo"
}
```

#### 5. Registrazione Bar
```bash
POST /api/bar/registration
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "iva": "12345678901",
  "merchantName": "Mario Rossi S.r.l.",
  "name": "Bar Centrale",
  "address": "Via Roma 123, 00100 Roma",
  "image": "https://example.com/bar-image.jpg"
}

Response 201:
{
  "success": true,
  "message": "Bar registrato con successo",
  "data": {
    "id": 1,
    "userId": 1,
    "iva": "12345678901",
    "merchantName": "Mario Rossi S.r.l.",
    "name": "Bar Centrale",
    "address": "Via Roma 123, 00100 Roma",
    "image": "https://example.com/bar-image.jpg"
  }
}
```

#### 6. Recupera Profilo Bar Utente
```bash
GET /api/bar/profile
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

Response 200:
{
  "success": true,
  "data": {
    "id": 1,
    "user_id": 1,
    "iva": "12345678901",
    "merchant_name": "Mario Rossi S.r.l.",
    "name": "Bar Centrale",
    "address": "Via Roma 123, 00100 Roma",
    "image": "https://example.com/bar-image.jpg",
    "created_at": "2026-02-14T10:30:00Z",
    "updated_at": "2026-02-14T10:30:00Z"
  }
}
```

## ⚠️ Errori Comuni & Soluzioni

| Errore | Causa | Soluzione |
|--------|-------|-----------|
| `Email già registrata` | Email duplicata | Usa email diversa |
| `Credenziali non valide` | Email/password errata | Verifica input |
| `Password deve contenere...` | Password debole | Segui i requisiti mostrati |
| `Token non valido` | JWT scaduto/malformato | Re-login per nuovo token |
| `Token mancante` | Header Authorization assente | Aggiungi header corretto |
| `Database error` | Connessione DB fallita | Verifica `DATABASE_URL` |
| `IVA già registrata` | Partita IVA già presente | Usa IVA diversa |
| `Bar già registrato` | Utente ha già un bar | Elimina il bar precedente |
| `Bar non trovato` | Nessun bar associato all'utente | Registra un bar prima |
| `Dati non validi` | IVA/Address format errato | Controlla formati campi |

## 🔒 Best Practices Implementate

✅ **Password Hashing**
- Argon2id (algoritmo moderno e resistente agli attacchi)
- Memory-hard per prevenire GPU/ASIC attacks
- Parametri configurati: 64MB memoria, 3 iterazioni, 4 parallelism

✅ **JWT Sicurezza**
- HS256 algoritmo di firma
- Espirazione token (default 7 giorni)
- Claim payload minimale (userId, email)

✅ **Input Validation**
- Schema-based con Zod
- Sanitizzazione string
- Length limits per prevenire buffer overflow

✅ **Database Security**
- Prepared statements (param binding $1, $2, etc.)
- Transazioni ACID
- Indici per performance e sicurezza

✅ **Rate Limiting**
- 5 richieste per 15 minuti
- Protegge brute-force su login

✅ **Error Handling**
- No sensitive data in errors
- Consistent error codes
- Proper HTTP status codes

## 📚 Prossimi Step Consigliati

1. **Refresh Token Implementation**
   - Ruota token ogni login
   - Salva in tabella `refresh_tokens`
   - Implementa token blacklist

2. **MFA (Multi-Factor Authentication)**
   - 2FA con TOTP/SMS
   - Backup codes

3. **OAuth2 Integration**
   - Google/GitHub login
   - Social auth

4. **Audit Logging**
   - Log login attempts
   - Login history
   - IP tracking

5. **API Key Authentication**
   - Server-to-server auth
   - Scoped permissions
