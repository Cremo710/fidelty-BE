# Loyalty Bar Backend

Fastify + TypeScript backend exposing simple endpoints and CORS enabled for the Expo frontend in `../loyalty-bar-app/`.

## Scripts

- `npm run dev` — start dev server with ts-node-dev on port 4000
- `npm run build` — build to `dist/`
- `npm start` — run compiled build

## Endpoints

- `GET /api/health` — basic health check
- `GET /api/hello` — returns a simple JSON object

## Run locally

```bash
npm install
npm run dev
```

The server listens on `http://localhost:4000`.

CORS is configured to allow requests from localhost origins (Expo web uses `http://localhost:19006`) and native (no-origin) during development.

## Database e migration

Lo schema è definito solo nei file SQL di `src/migrations/` (`001_baseline_schema.sql`, `003_…` … `011_timestamptz.sql`).
All'avvio il server esegue il runner (`src/migrations/runner.ts`), che:

1. crea la tabella di registro `schema_migrations`;
2. applica in ordine di nome i file non ancora registrati, ciascuno in una transazione, e li registra;
3. usa un advisory lock, quindi più istanze avviate insieme non applicano due volte la stessa migration.

Per un **database nuovo** basta impostare `DATABASE_URL` e avviare il server: viene creato lo schema completo.
Su un **database esistente** la prima esecuzione riapplica le migration (tutte idempotenti) e le registra; la 008 salta gli
`UPDATE` su `bar_config`/`platform_config` se era già stata applicata, quindi non sovrascrive le impostazioni dei titolari.
Per modificare lo schema aggiungere un nuovo file `NNN_descrizione.sql` (non modificare quelli già applicati).

Tutte le colonne temporali sono `TIMESTAMPTZ` (migration 011). L'inizio della giornata "italiana" per i limiti giornalieri è sempre
`date_trunc('day', NOW() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome'`.

## OCR scontrini

Prima del lancio eseguire `npm run ocr:benchmark` su un campione di scontrini reali (soglia 90% su importo, P.IVA e numero documento).

## Email notifiche richieste bar

Quando una business request viene approvata o rifiutata, il backend puo inviare una email automatica all'utente con l'esito della richiesta e le conseguenze dell'operazione.

In fase di test il backend puo usare Resend come provider primario. Se Resend non e configurato o fallisce, rimane disponibile il fallback SMTP.

Variabili richieste:

```bash
EMAIL_PROVIDER=auto
RESEND_API_KEY=your-resend-api-key
RESEND_FROM_EMAIL=onboarding@resend.dev
RESEND_FROM_NAME=Fidelty

SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
EMAIL_FROM=no-reply@fidelty.app
EMAIL_FROM_NAME=Fidelty
SMTP_REQUIRE_TLS=false
SMTP_TLS_SERVERNAME=smtp.your-provider.com
SMTP_CONNECTION_TIMEOUT_MS=10000
SMTP_GREETING_TIMEOUT_MS=10000
SMTP_SOCKET_TIMEOUT_MS=20000
```

Se queste variabili non sono configurate, la richiesta viene comunque elaborata ma l'invio email viene saltato e loggato come non configurato.

Note pratiche:

- `EMAIL_PROVIDER=resend` forza l'uso di Resend e impedisce il fallback a SMTP
- `EMAIL_PROVIDER=auto` prova Resend se configurato e, solo in quel caso, puo ricadere su SMTP
- `EMAIL_PROVIDER=smtp` disabilita Resend
- per i test iniziali con Resend puoi usare `onboarding@resend.dev` come mittente
- porta 465: usa `SMTP_SECURE=true`
- porta 587: usa `SMTP_SECURE=false` e, se richiesto dal provider, `SMTP_REQUIRE_TLS=true`
- se in hosting vedi `ETIMEDOUT` durante la connessione SMTP, il backend sta raggiungendo male `SMTP_HOST:SMTP_PORT` oppure il provider richiede TLS/servername diversi

## Test e lancio

- `npm test` esegue i test unitari; quelli di integrazione richiedono `TEST_DATABASE_URL`.
- Checklist di configurazione e lancio: [docs/DEPLOY_CHECKLIST.md](docs/DEPLOY_CHECKLIST.md).
