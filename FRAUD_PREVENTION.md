# Fraud Prevention System — Documentazione Tecnica

## Indice

1. [Panoramica](#panoramica)
2. [Architettura](#architettura)
3. [Pipeline di Validazione (4 Layer)](#pipeline-di-validazione)
4. [Trust Score System](#trust-score-system)
5. [Anti-Abuse System](#anti-abuse-system)
6. [Modifiche al Database](#modifiche-al-database)
7. [Variabili d'Ambiente](#variabili-dambiente)
8. [Gestione Errori Frontend](#gestione-errori-frontend)
9. [Test](#test)
10. [File Modificati / Creati](#file-modificati--creati)

---

## Panoramica

Sistema multi-livello di prevenzione frodi per la validazione delle ricevute caricate dagli utenti per guadagnare punti fedeltà. Il sistema previene ricevute false, duplicate o manipolate mantenendo una UX fluida.

**Principio**: le frodi evidenti (duplicati esatti) vengono respinte immediatamente; i pattern sospetti vengono segnalati e penalizzati tramite trust score, senza bloccare l'utente.

---

## Architettura

Il flusso di una ricevuta attraversa due endpoint:

```
1. POST /api/vision/extract-text   →  OCR + Validazione + Trust Score (preview)
2. POST /api/receipts/confirm      →  Salvataggio + Aggiustamento punti + Persistenza fraud data
```

### Flusso completo

```
Utente scatta foto
       │
       ▼
┌──────────────────────────┐
│  Anti-Abuse Check        │  Ban check + Rate limit
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│  Layer 3: Image Auth     │  EXIF metadata, screenshot/edit detection
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│  Layer 1: Basic Valid.   │  SHA-256 hash ─► Data/importo/docId parsing ─► Date/amount checks
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│  Layer 2: Duplicates     │  Image hash dupe ─► DocId dupe ─► Similar receipts pattern
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│  Layer 4: Trust Score    │  OCR completeness + Consistency + Duplication risk + User behavior
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│  Conferma ricevuta       │  Trust score ─► Punti effettivi ─► Salvataggio DB + Fraud flags
└──────────────────────────┘
```

---

## Pipeline di Validazione

### Layer 1 — Basic Validation (`receiptValidationService.ts`)

| Check | Azione |
|-------|--------|
| Importo totale mancante o ≤ 0 | **Rifiuto** |
| Data nel futuro | **Rifiuto** |
| Data più vecchia di N giorni (default: 30) | **Rifiuto** |
| Numero documento (docId) mancante | **Rifiuto** |
| Data non rilevata dall'OCR | **Warning** (non bloccante) |
| SHA-256 hash dell'immagine | Calcolato e salvato per duplicate detection |

### Layer 2 — Duplicate & Pattern Detection (`fraudDetectionService.ts`)

| Check | Azione |
|-------|--------|
| Hash immagine già presente in DB | **Rifiuto** (HTTP 409, `DUPLICATE_IMAGE`) |
| DocId già presente in DB | **Rifiuto** (HTTP 409, `DUPLICATE_RECEIPT`) |
| Stesso importo + stessa data + stesso merchant (entro finestra configurabile) | **Flag** (non bloccante, penalizza trust score) |
| Importo identico ripetuto N+ volte in 7 giorni | **Flag** |
| Troppe ricevute/giorno per utente | **Flag** |
| Troppi punti/giorno per utente | **Flag** |

### Layer 3 — Image Authenticity (`receiptValidationService.ts`)

| Check | Azione |
|-------|--------|
| Assenza EXIF metadata | Penalità trust score (lieve) |
| Screenshot rilevato (keyword in EXIF) | Penalità trust score (media) |
| Immagine modificata (Photoshop, GIMP, etc.) | Penalità trust score (media) |
| Camera model estratto | Informativo (logging) |

L'analisi EXIF è best-effort: legge i primi 64KB del buffer cercando pattern ASCII comuni. Non richiede librerie esterne.

### Layer 4 — Trust Score (`trustScoreService.ts`)

Vedi sezione dedicata sotto.

---

## Trust Score System

Ogni ricevuta riceve un punteggio di fiducia da **0 a 100**, composto da 4 dimensioni (25 punti ciascuna):

### Dimensione 1: OCR Completeness (0-25)

| Campo presente | Punti |
|----------------|-------|
| docId | +5 |
| merchantTaxId (P.IVA) | +5 |
| totalAmount > 0 | +5 |
| merchantName | +4 |
| date | +4 |
| time | +2 |

### Dimensione 2: Data Consistency (0-25)

Base: 15 punti, con bonus e penalità:

| Condizione | Effetto |
|------------|---------|
| P.IVA corrisponde a un bar registrato | +5 |
| Data entro 7 giorni | +5 |
| Data oltre max age | -10 |
| Data nel futuro | -15 |
| Data mancante | -5 |
| Screenshot rilevato | -10 |
| Immagine modificata | -10 |
| EXIF mancante | -3 |

### Dimensione 3: Duplication Risk (0-25)

| Condizione | Punti |
|------------|-------|
| Nessun duplicato | 25 |
| Immagine duplicata | 0 |
| DocId duplicato | 0 |
| Per ogni ricevuta simile trovata | -5 |

### Dimensione 4: User Behavior (0-25)

Base: 25 punti, con penalità:

| Condizione | Effetto |
|------------|---------|
| Utente flaggato | -15 |
| Upload giornalieri ≥ 100% del limite | -15 |
| Upload giornalieri ≥ 70% del limite | -5 |
| Trust score medio storico < 50 | -5 |

### Effetto sui Punti

| Trust Score | Status | Punti assegnati |
|-------------|--------|-----------------|
| ≥ 80 | `approved` | 100% dei punti |
| 50–79 | `partial` | 50% dei punti (min 1) |
| < 50 | `rejected` | 0 punti + flag |

Le soglie e la frazione sono tutte configurabili via env vars.

---

## Anti-Abuse System

### Rate Limiting
- **In-memory**, per utente, per minuto
- Default: 5 richieste/minuto per utente
- Risposta: HTTP 429 (`RATE_LIMITED`)

### Daily Limits
- Max ricevute per giorno (default: 10)
- Max punti per giorno (default: 500)
- Superamento → fraud flag (non bloccante, penalizza trust score)

### Ban System
- `isUserBanned(userId)` — controlla se l'utente è bannato
- Utente bannato → HTTP 403 (`USER_BANNED`) su entrambi gli endpoint
- Funzioni admin: `flagUser()`, `banUser()`, `revokeReceiptPoints()`

### Revoke Points
`revokeReceiptPoints(receiptId)` — transazione atomica che:
1. Imposta `points_earned = 0` e `status = 'rejected'` sulla ricevuta
2. Sottrae i punti dalla loyalty card corrispondente

---

## Modifiche al Database

### Nuove colonne su `receipts`

```sql
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS image_hash VARCHAR(64);
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS trust_score INTEGER;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'approved';
```

### Nuova tabella `fraud_flags`

```sql
CREATE TABLE IF NOT EXISTS fraud_flags (
  id SERIAL PRIMARY KEY,
  receipt_id VARCHAR(26) NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  severity VARCHAR(10) NOT NULL DEFAULT 'low',  -- 'low' | 'medium' | 'high'
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Nuova tabella `user_fraud_stats`

```sql
CREATE TABLE IF NOT EXISTS user_fraud_stats (
  user_id VARCHAR(26) PRIMARY KEY REFERENCES utenti(id) ON DELETE CASCADE,
  avg_trust_score FLOAT DEFAULT 0,
  total_receipts INTEGER DEFAULT 0,
  is_flagged BOOLEAN DEFAULT FALSE,
  is_banned BOOLEAN DEFAULT FALSE,
  last_receipt_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Le migrazioni vengono eseguite automaticamente all'avvio del server tramite `initializeTables()` (pattern `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`).

---

## Variabili d'Ambiente

### Variabili esistenti (OBBLIGATORIE)

| Variabile | Descrizione | Esempio |
|-----------|-------------|---------|
| `DATABASE_URL` | Connection string PostgreSQL | `postgresql://user:pass@host:5432/db` |
| `JWT_SECRET` | Secret per firma JWT access token | `your-secret-key` |
| `REFRESH_TOKEN_SECRET` | Secret per firma refresh token | `your-refresh-secret` |
| `JWT_EXPIRY` | Durata access token | `15m` |
| `GOOGLE_CREDENTIALS` | JSON credentials Google Cloud Vision | `{"type":"service_account",...}` |
| `GOOGLE_GEOCODE_API_KEY` | API key Google Geocoding | `AIza...` |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name | `your-cloud` |
| `CLOUDINARY_API_KEY` | Cloudinary API key | `123456789` |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret | `abc123...` |
| `TAGGUN_API_KEY` | API key Taggun OCR | `your-taggun-key` |

### Variabili esistenti (OPZIONALI)

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `PORT` | `4000` | Porta del server |
| `HOST` | `0.0.0.0` | Host del server |
| `NODE_ENV` | `development` | Ambiente |
| `TAGGUN_API_URL` | (Taggun default) | URL API Taggun |

### Nuove variabili Fraud Prevention (OPZIONALI — hanno tutte un default)

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `FRAUD_MAX_RECEIPT_AGE_DAYS` | `30` | Età massima ricevuta (giorni) |
| `FRAUD_MAX_RECEIPTS_PER_DAY` | `10` | Max ricevute/giorno per utente |
| `FRAUD_MAX_POINTS_PER_DAY` | `500` | Max punti/giorno per utente |
| `FRAUD_IDENTICAL_TOTAL_THRESHOLD` | `3` | N. importi identici prima del flag |
| `FRAUD_SIMILAR_RECEIPT_WINDOW_HOURS` | `24` | Finestra temporale per ricevute simili (ore) |
| `FRAUD_TRUST_FULL_POINTS` | `80` | Soglia trust per punti pieni |
| `FRAUD_TRUST_PARTIAL_POINTS` | `50` | Soglia trust per punti parziali |
| `FRAUD_PARTIAL_POINTS_FRACTION` | `0.5` | Frazione punti nel range parziale (0-1) |
| `FRAUD_RATE_LIMIT_PER_MINUTE` | `5` | Max upload per utente per minuto |

---

## Gestione Errori Frontend

### Nuovi codici errore gestiti in `CameraScreen.js`

| Codice | Titolo Alert | Messaggio |
|--------|--------------|-----------|
| `DUPLICATE_RECEIPT` | Ricevuta duplicata | Questa ricevuta è già stata caricata nel sistema. |
| `DUPLICATE_IMAGE` | Immagine duplicata | Questa immagine è già stata caricata nel sistema. |
| `USER_BANNED` | Account sospeso | Il tuo account è stato sospeso. Contatta l'assistenza. |
| `RATE_LIMITED` | Troppe richieste | Hai inviato troppe richieste. Riprova tra un minuto. |
| `VALIDATION_FAILED` | Scontrino non valido | (messaggio dinamico dal backend) |

### Dati fraud passati nella conferma ricevuta

`ReceiptRecapScreen.js` ora include nel payload di conferma:
- `imageHash` — hash SHA-256 dell'immagine
- `trustScore` — punteggio di fiducia calcolato al momento della scansione
- `fraudFlags` — array di motivi di sospetto

### Dati fraud passati alla ThankYou screen

- `receiptStatus` — `approved` / `partial` / `rejected`

---

## Test

34 test unitari distribuiti in 3 suite:

### `receiptValidation.test.ts` (14 test)
- Hash SHA-256: lunghezza, unicità, idempotenza
- Validazione campi: importo mancante/zero, data futura, data troppo vecchia, docId mancante, data assente (warning)
- EXIF: rilevamento header, immagini editate, screenshot, buffer vuoto

### `trustScore.test.ts` (11 test)
- Score alto per ricevuta perfetta
- Penalità: duplicato immagine, screenshot, immagine modificata, utente flaggato, troppi upload, campi OCR mancanti
- `applyTrustScore`: full/partial/rejected thresholds, minimo 1 punto nella fascia parziale

### `fraudDetection.test.ts` (9 test)
- Pattern detection: immagine duplicata, docId duplicato, ricevute simili, limiti giornalieri, importi identici
- Rate limiter: prima richiesta consentita, blocco dopo superamento

Comando per eseguire i test:
```bash
npx vitest run src/__tests__/
```

---

## File Modificati / Creati

### Nuovi file (BE)

| File | Descrizione |
|------|-------------|
| `src/services/fraudConfig.ts` | Configurazione soglie (env vars) |
| `src/services/receiptValidationService.ts` | Validazione campi, hash immagine, analisi EXIF |
| `src/services/trustScoreService.ts` | Calcolo trust score, applicazione ai punti |
| `src/services/fraudDetectionService.ts` | Duplicate detection, pattern analysis, rate limiter, admin tools |
| `src/__tests__/receiptValidation.test.ts` | Test validazione |
| `src/__tests__/trustScore.test.ts` | Test trust score |
| `src/__tests__/fraudDetection.test.ts` | Test fraud detection |

### File modificati (BE)

| File | Modifiche |
|------|-----------|
| `src/services/databaseService.ts` | Nuove tabelle (`fraud_flags`, `user_fraud_stats`), nuove colonne su `receipts`, `saveReceipt()` aggiornato |
| `src/controllers/visionController.ts` | Pipeline completa 4 layer integrata in `extractText()` |
| `src/controllers/receiptsController.ts` | Trust score e fraud flags integrati in `confirmReceipt()` |

### File modificati (FE)

| File | Modifiche |
|------|-----------|
| `src/services/apiService.js` | Error code propagation in `processReceiptVision()` e `submitReceipt()` |
| `src/pages/CameraScreen.js` | Gestione errori fraud-specific con alert dedicati |
| `src/pages/ReceiptRecapScreen.js` | Invio `imageHash`, `trustScore`, `fraudFlags` al confirm; passaggio `receiptStatus` a ThankYou |
