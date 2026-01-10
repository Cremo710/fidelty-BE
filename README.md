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
