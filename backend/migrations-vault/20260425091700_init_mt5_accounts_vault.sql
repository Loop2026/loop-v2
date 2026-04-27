-- ============================================================================
-- Migration: init_mt5_accounts_vault
-- Applicata: 2026-04-25
-- Progetto: loop-mt5-vault (danjmobsceriqltlnpyn) — eu-central-1
-- ----------------------------------------------------------------------------
-- LOOP MT5 VAULT — Schema iniziale
-- Repository centralizzato dei conti MT5 broker, condiviso tra tutte le
-- applicazioni Loop (loop-dashboard-v2, future app trading-bot, signal-runner,
-- reporter, ecc.). Le app si autenticano con SERVICE_ROLE_KEY (full access)
-- oppure tramite edge function gateway in futuro.
--
-- Una riga = UN conto broker MetaTrader 5. Identificato univocamente da
-- (mt5_server, mt5_account). metaapi_id è l'ID univoco MetaApi (uuid) e
-- viene popolato dopo la registrazione automatica dal flusso di provisioning.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ============================================================================
-- TABELLA mt5_accounts
-- ============================================================================
create table public.mt5_accounts (
  -- Identificativo
  id              uuid          primary key default gen_random_uuid(),

  -- Credenziali MT5 (necessarie per qualunque connessione broker)
  mt5_server      text          not null,
  mt5_account     text          not null,
  mt5_password    text          not null,
  metaapi_id      text          unique,

  -- Metadati broker (opzionali, utili per filtri/dashboard esterne)
  broker_name     text,
  server_region   text,
  account_type    text,

  -- Stato connessione live (snapshot aggiornato da job di sync MetaApi)
  last_seen       timestamptz,
  balance         numeric(18,2),
  equity          numeric(18,2),
  currency        text          default 'USD',

  -- Audit
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),

  -- Vincoli unicità
  constraint uq_mt5_server_account unique (mt5_server, mt5_account)
);

-- Index per query comuni
create index idx_mt5_metaapi_id    on public.mt5_accounts (metaapi_id)    where metaapi_id is not null;
create index idx_mt5_broker_name   on public.mt5_accounts (broker_name)   where broker_name is not null;
create index idx_mt5_account_type  on public.mt5_accounts (account_type)  where account_type is not null;
create index idx_mt5_last_seen     on public.mt5_accounts (last_seen desc) where last_seen is not null;

-- Trigger updated_at
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_mt5_accounts_updated_at
before update on public.mt5_accounts
for each row execute function public.tg_set_updated_at();

-- ============================================================================
-- RLS: blocca completamente l'accesso anon/authenticated.
-- Le app accedono SOLO con SERVICE_ROLE_KEY (che bypassa RLS).
-- Nessuna policy aggiunta intenzionalmente.
-- ============================================================================
alter table public.mt5_accounts enable row level security;

-- ============================================================================
-- Commenti documentazione
-- ============================================================================
comment on table public.mt5_accounts is
  'Repository condiviso dei conti broker MT5 tra applicazioni Loop. Accesso via service_role key. Una riga = un conto broker (univoco per server+account).';
comment on column public.mt5_accounts.id is
  'UUID interno del vault. Le app esterne lo referenziano (es. abbonamenti.mt5_account_id in loop-dashboard-v2).';
comment on column public.mt5_accounts.metaapi_id is
  'ID conto registrato su MetaApi cloud. Popolato dal flusso provisioning. Permette sync live trades.';
comment on column public.mt5_accounts.broker_name is
  'Nome del broker (es. ICMarkets, Pepperstone, Exness). Free-text per evitare lock-in su lista chiusa.';
comment on column public.mt5_accounts.account_type is
  'Tipo conto: real, demo, prop_funded, challenge, ecc. Free-text.';
comment on column public.mt5_accounts.last_seen is
  'Ultimo heartbeat da MetaApi. Aggiornato da job di sync esterni.';
