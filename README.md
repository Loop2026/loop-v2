# Loop General Dashboard — Repository

Repository unica del sistema **Loop v2**: dashboard clienti per arbitraggio matematico
XAUUSD, multi-abbonamento, integrata con MetaApi per sync live operazioni broker.

## Cos'è dentro

```
loop-v2-deploy/
├── frontend/                    # SPA in singolo file HTML
│   └── index.html               # → drag-drop su Netlify per il deploy
│
├── backend/                     # Tutto quello che gira lato server
│   ├── functions/               # Edge functions Supabase (Deno + TypeScript)
│   │   ├── auth/index.ts        # POST /auth → login JWT + profilo cliente
│   │   ├── users/index.ts       # CRUD utenti interni admin/operator + log accessi
│   │   ├── clients/index.ts     # CRUD clienti + creazione login + 1° abbonamento
│   │   ├── abbonamenti/index.ts # CRUD abbonamenti + provision-mt5 + rinnova
│   │   └── trades/index.ts      # CRUD trades + sync MetaApi + bulk-import + wipe
│   │
│   ├── migrations/              # Migrations SQL del progetto loop-dashboard-v2
│   │   ├── 20260418163507_schema_v2_patch.sql
│   │   ├── 20260418195059_fix_trade_ops_upsert_constraint.sql
│   │   └── 20260425122257_add_mt5_account_id_fk_to_abbonamenti.sql
│   │
│   └── migrations-vault/        # Migrations SQL del progetto loop-mt5-vault
│       └── 20260425091700_init_mt5_accounts_vault.sql
│
├── docs/                        # Documentazione e brief
│   └── PHOENIX_INTEGRATION_BRIEF.md
│
├── .gitignore
└── README.md                    # ← stai leggendo questo
```

## Architettura in 30 secondi

Tre componenti indipendenti, deployati separatamente:

**Frontend** (`frontend/index.html`) — vanilla JS SPA, single-file da ~620KB. Hostato su
**Netlify** via drag-drop della cartella `frontend/`. Nessun build step.

**Backend Loop v2** — progetto Supabase `sytnajozvreoetsluzdd` (eu-central-1). Postgres
con 12 tabelle + 5 edge functions Deno. JWT auth custom con HMAC-SHA256, ruoli
`admin/operator/client`. RLS deny-all, gli edge function bypassano via service-role key.

**Backend MT5 Vault** — progetto Supabase `danjmobsceriqltlnpyn` (eu-central-1). Tabella
unica `mt5_accounts`, condivisa tra Loop e future app (trading-bot, signal-runner). FK
logico cross-project: `abbonamenti.mt5_account_id → mt5_accounts.id`.

Diagramma completo: vedi `docs/` (TODO: salvare l'SVG dell'architettura) o chiedi a Claude
di rigenerarlo dalla memoria.

## Deploy procedure

### Frontend (Netlify, ~30 secondi)

1. Apri https://app.netlify.com/drop
2. Trascina la cartella `frontend/` (NON la repo intera).
3. Fatto. Sito disponibile su `https://<random-name>.netlify.app`.

Per il dominio custom: collega il dominio in Netlify dashboard (sezione "Domain settings").

### Backend Loop v2 — Edge functions

Le edge functions vengono deployate via **Supabase CLI** o **MCP tool** (quello usato
finora). Per ogni file in `backend/functions/<name>/index.ts`:

```bash
# CLI (richiede login + project ref)
supabase functions deploy <name> --project-ref sytnajozvreoetsluzdd
```

Oppure tramite Claude/MCP: `deploy_edge_function` con il payload JSON che include
`name`, `entrypoint_path: "index.ts"`, `verify_jwt: false` (le function fanno auth
custom in body, non JWT Supabase), e i `files`.

### Backend Loop v2 — Migrations

Le migrations sono **già applicate** sul progetto in produzione (vedi
`supabase_migrations.schema_migrations` su Supabase). Per ricostruire l'ambiente
da zero (es. nuovo dev database):

```bash
# In ordine cronologico
psql $DB_URL -f backend/migrations/20260418163507_schema_v2_patch.sql
psql $DB_URL -f backend/migrations/20260418195059_fix_trade_ops_upsert_constraint.sql
psql $DB_URL -f backend/migrations/20260425122257_add_mt5_account_id_fk_to_abbonamenti.sql
```

Oppure con Supabase CLI: `supabase db push`.

### Backend MT5 Vault

```bash
psql $VAULT_DB_URL -f backend/migrations-vault/20260425091700_init_mt5_accounts_vault.sql
```

## Variabili d'ambiente / Secrets

Configurati come **secrets su Supabase** (non in `.env`, sono variabili runtime delle
edge functions):

| Secret | Progetto | Scopo |
|---|---|---|
| `SUPABASE_URL` | loop-dashboard-v2 | Auto-popolato da Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | loop-dashboard-v2 | Auto-popolato |
| `JWT_SECRET` | loop-dashboard-v2 | Firma JWT custom |
| `METAAPI_TOKEN` | loop-dashboard-v2 | Token API MetaApi cloud |

Da configurare nelle prossime fasi (vedi roadmap):
- `MT5_VAULT_URL` + `MT5_VAULT_SERVICE_KEY` — per far scrivere a `abbonamenti` nel vault
- `PHOENIX_API_KEY` — per leggere anagrafiche dal Gestionale (in attesa dev Phoenix)

## Endpoint API

Base URL: `https://sytnajozvreoetsluzdd.supabase.co/functions/v1`

| Endpoint | Metodo | Auth | Note |
|---|---|---|---|
| `/auth` | POST | — | Login email+password → JWT + profilo |
| `/clients` | GET/POST/PUT/PATCH/DELETE | admin/operator | CRUD clienti |
| `/abbonamenti` | GET/POST/PUT/PATCH/DELETE | admin/operator/client | CRUD abbonamenti |
| `/abbonamenti/:id/rinnova` | POST | admin/operator | Rinnovo abbonamento |
| `/abbonamenti/:id/provision-mt5` | POST | client (1ª volta) o admin | Registra MT5 + crea account MetaApi |
| `/trades` | GET/POST | admin/operator/client | CRUD trades |
| `/trades/:id/operations` | GET/POST | admin/operator/client | Operazioni di un trade |
| `/trades/:id/sync-metaapi` | POST | admin/operator | Sync ops da MetaApi |
| `/trades/bulk-import-metaapi` | POST | admin/operator | Import massivo da MetaApi |
| `/trades/broker-live` | GET | admin/operator/client | Operazioni live broker |
| `/trades/admin-wipe-test-data` | POST | admin | Reset stato zero (con confirm) |
| `/users` | GET/POST/PUT/PATCH/DELETE | admin | CRUD admin/operator interni |
| `/users/login-log` | GET | admin | Log accessi |

Tutte richiedono header `Authorization: Bearer <jwt>` tranne `/auth`.

## Workflow Git consigliato

```bash
# Inizializza repo
cd /path/to/loop-v2-deploy
git init
git add .
git commit -m "Initial repo: frontend + backend extracted from Supabase"

# Push su GitHub
git remote add origin git@github.com:<tuo-user>/loop-v2.git
git branch -M main
git push -u origin main
```

Branch strategy suggerita: `main` per produzione, `dev` per modifiche in corso, feature
branch per cose grosse (es. `feature/phoenix-integration`).

## Roadmap aperta

Task pending principali (vedi tracker Claude per dettagli):

- **#57** — Aggiornare edge fn `abbonamenti` v5 per scrivere nel MT5 vault invece che
  duplicare le credenziali sull'abbonamento.
- **#59** — Integrazione anagrafica con Gestionale Phoenix (`pda.phoenixdataanalitics.com`).
  Bloccata in attesa che il dev Phoenix esponga API key — vedi
  `docs/PHOENIX_INTEGRATION_BRIEF.md`.
- **#24** — Cron settimanale per scadenza abbonamenti.
- **#29** — Testing E2E L1→L4 lato browser.

## Contatti

Maintainer: Luca Di Gioia — `luca@lucadigioia.ch`

Sviluppato con assistenza di Claude (Anthropic) — Cowork mode.
