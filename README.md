# Data Sync Pipeline

Ingests records from **HubSpot**, **Stripe**, and **Google Calendar** into a single
normalized PostgreSQL schema, with incremental sync, stale-cursor fallback to backfill,
idempotent writes, and per-source fault isolation.

See [`PLAN.md`](./PLAN.md) for the full design and [`EXECUTION.md`](./EXECUTION.md) for the
milestone/parallelization plan.

## Stack

TypeScript · NestJS 11 · PostgreSQL 16 · Drizzle ORM · pg-boss (Postgres-backed queue) ·
`@nestjs/schedule` · Zod · pino. Deploys to Render free tier (single web service + free Postgres).

## Quickstart (local)

```bash
# 1. Install deps
npm install

# 2. Start Postgres — either Docker...
docker compose up -d postgres
#    ...or use a local Postgres and create the role/db:
#    psql postgres -c "CREATE ROLE sync LOGIN PASSWORD 'sync' SUPERUSER;"
#    psql postgres -c "CREATE DATABASE syncdb OWNER sync;"

# 3. Configure env
cp .env.example .env   # defaults already point at the local Postgres above

# 4. Apply migrations
npm run db:migrate

# 5. Run
npm run start:dev      # watch mode
# or: npm run build && npm start

# 6. Verify
curl -s localhost:3000/health   # -> {"status":"ok","db":"up",...}
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run start:dev` | Run with watch + pretty logs |
| `npm run build` | Compile to `dist/` |
| `npm test` | Run unit + integration specs (integration needs Postgres) |
| `npm run lint` | ESLint + Prettier (`--fix`) |
| `npm run db:generate` | Generate a Drizzle migration from `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations (local, via ts-node) |
| `npm run db:migrate:prod` | Apply migrations from compiled output (Render) |

## HTTP endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | — | Liveness + DB check |
| POST | `/webhooks/stripe` | Stripe signature | Stripe events (signature-verified) |
| POST | `/webhooks/google` | channel headers | Google Calendar push → incremental sync |
| POST | `/webhooks/hubspot` | HubSpot signature | HubSpot contact events |
| GET | `/admin/metrics` | `Bearer ADMIN_TOKEN` | Ledger aggregates + reconciliation status |
| POST | `/internal/sync` | `Bearer ADMIN_TOKEN` | Manual sync (all sources, isolated). `?full=true` forces backfill |

Example: `curl -H "Authorization: Bearer $ADMIN_TOKEN" localhost:3000/admin/metrics`

## Layout

```
src/
  config/        env validation (Zod)
  db/            Drizzle schema, connection module, migrate runner
  common/        NormalizedRecord + content-hash
  records/       version-guarded upsert repository (idempotency)
  connectors/    SourceConnector contract + stripe / google / hubspot
  sync/          SyncRunner (fetch→normalize→upsert→ledger), state + run repos
  queue/         pg-boss (Postgres-backed job queue)
  orchestrator/  per-source dispatch + in-process scheduler (fault isolation)
  webhooks/      signature-verified controllers + replay-dedup ledger
  admin/         /admin/metrics + /internal/sync (token-guarded)
  health/        /health endpoint
drizzle/         generated SQL migrations
```

## Deploy (Render)

`render.yaml` provisions a free Web Service + free Postgres. Build runs `npm run build`;
start runs migrations then boots (`npm run start:render`). Source credentials are set as
dashboard secrets (`sync: false`). Note: Render free Postgres is deleted ~30 days after
creation — upgrade the plan for persistence.
