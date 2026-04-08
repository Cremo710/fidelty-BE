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

## Email notifiche richieste bar

Quando una business request viene approvata o rifiutata, il backend puo inviare una email automatica all'utente con l'esito della richiesta e le conseguenze dell'operazione.

Variabili richieste:

```bash
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
EMAIL_FROM=no-reply@fidelty.app
EMAIL_FROM_NAME=Fidelty
```

Se queste variabili non sono configurate, la richiesta viene comunque elaborata ma l'invio email viene saltato e loggato come non configurato.
