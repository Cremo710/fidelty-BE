# Checklist di lancio e configurazione

## Variabili d'ambiente backend (produzione)

Il server si rifiuta di partire se i segreti mancano o sono più corti di 32 caratteri.
Genera ogni segreto con: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.

- [ ] `NODE_ENV=production`
- [ ] `DATABASE_URL` (password **rigenerata**; il pool usa TLS con verifica del certificato)
- [ ] `JWT_SECRET`, `REFRESH_TOKEN_SECRET`, `OFFER_REDEMPTION_SECRET`: tre valori diversi, ≥ 32 caratteri
- [ ] `ADMIN_USER_IDS`
- [ ] `CORS_ALLOWED_ORIGINS` (dominio del sito)
- [ ] `GOOGLE_CREDENTIALS` (Vision), `GOOGLE_GEOCODE_API_KEY` e `GOOGLE_PLACES_API_KEY` (**nuove**, con restrizione per API, tetto giornaliero e avviso di budget)
- [ ] `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- [ ] Email: `EMAIL_PROVIDER`, `RESEND_API_KEY` e/o `SMTP_*`, mittente su dominio verificato (non `onboarding@resend.dev`)
- [ ] `FEATURE_RETROACTIVE_DUPLICATES` assente o `false`
- [ ] Opzionali: `RECEIPT_IMAGE_RETENTION_DAYS`, `METRICS_EMAIL_RECIPIENT`, `CONSUMPTION_REQUEST_MAX_DISTANCE_METERS`

## Frontend / build

- [ ] `EXPO_PUBLIC_API_BASE_URL` impostato per ogni profilo EAS (in `eas.json`)
- [ ] Package Android definitivo in `app.json` (non modificabile dopo la prima pubblicazione)
- [ ] Icona adattiva (PNG 1024×1024 trasparente) e `monochromeImage` per Android 13+
- [ ] Splash e icone verificati su schermi con proporzioni diverse

## Infrastruttura

- [ ] Piano Render: sul piano gratuito il server si sospende dopo 15 minuti e la prima richiesta impiega fino a un minuto
- [ ] Migration applicate in ordine e registrate (avviene all'avvio: controllare i log)
- [ ] `npm run ocr:benchmark` superato su scontrini reali (soglia 90%)
- [ ] Nessun `.env` o chiave nel repository e nella cronologia Git

## Test

- `npm test` esegue i test unitari (`vitest run`).
- I test di integrazione (`src/__tests__/*.integration.test.ts`) partono solo se è impostata `TEST_DATABASE_URL`
  verso un database dedicato (es. branch Neon `test`; l'URL deve contenere "test"). Le migration vengono applicate automaticamente.
- Ancora da coprire con test di integrazione: approvazione richieste bar, richiesta di consumo end-to-end,
  trasferimento punti, riscatto offerte.

## Documentazione archiviata

I documenti non più allineati al codice sono in `docs/archive/` (BE e FE) e vanno riscritti o eliminati.
