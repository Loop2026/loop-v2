-- ============================================================================
-- Migration: schema_v2_patch
-- Applicata: 2026-04-18
-- Progetto: loop-dashboard-v2 (sytnajozvreoetsluzdd)
-- ----------------------------------------------------------------------------
-- Patch architetturale v2: introduce tabella users (separata da clients),
-- login_log per audit accessi, trade_operations (split per ogni trade in
-- più operazioni MetaApi), rimborsi (scenarioB), strategy_config (parametri
-- giorno-ciclo) e metaapi_sync_log. Inoltre aggiunge colonne mancanti su
-- trades e abbonamenti, e abilita RLS deny-all su tutte le nuove tabelle
-- (gli edge function bypassano RLS via service_role).
-- ============================================================================

-- 1. USERS
CREATE TABLE IF NOT EXISTS public.users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT UNIQUE NOT NULL,
  pwd_hash    TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin','operator','client')),
  name        TEXT NOT NULL,
  client_id   TEXT REFERENCES public.clients(id) ON DELETE CASCADE,
  stato       TEXT NOT NULL DEFAULT 'attivo' CHECK (stato IN ('attivo','sospeso')),
  last_login  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email  ON public.users(email);
CREATE INDEX IF NOT EXISTS idx_users_client ON public.users(client_id);

DO $$ BEGIN
  ALTER TABLE public.clients ALTER COLUMN password_hash DROP NOT NULL;
EXCEPTION WHEN undefined_column THEN NULL; END $$;

-- 2. LOGIN_LOG
CREATE TABLE IF NOT EXISTS public.login_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID,
  email      TEXT,
  name       TEXT,
  role       TEXT,
  ip_address TEXT,
  user_agent TEXT,
  login_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_login_log_email ON public.login_log(email);
CREATE INDEX IF NOT EXISTS idx_login_log_date  ON public.login_log(login_at DESC);

-- 3. TRADES additions
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS trade_date        DATE,
  ADD COLUMN IF NOT EXISTS metaapi_order_id  TEXT,
  ADD COLUMN IF NOT EXISTS slot_id           TEXT;

UPDATE public.trades SET trade_date = data WHERE trade_date IS NULL AND data IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE public.trades ALTER COLUMN data DROP NOT NULL;
EXCEPTION WHEN undefined_column THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_trades_trade_date ON public.trades(trade_date);

-- 4. ABBONAMENTI addition
ALTER TABLE public.abbonamenti ADD COLUMN IF NOT EXISTS ultimo_ciclo TIMESTAMPTZ;

-- 5. TRADE_OPERATIONS
CREATE TABLE IF NOT EXISTS public.trade_operations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id             UUID REFERENCES public.trades(id) ON DELETE CASCADE,
  abbonamento_id       TEXT REFERENCES public.abbonamenti(id) ON DELETE CASCADE,
  client_id            TEXT REFERENCES public.clients(id) ON DELETE CASCADE,
  symbol               TEXT NOT NULL,
  direction            TEXT NOT NULL CHECK (direction IN ('buy','sell')),
  volume               NUMERIC(10,4),
  open_time            TIMESTAMPTZ,
  close_time           TIMESTAMPTZ,
  open_price           NUMERIC(14,5),
  close_price          NUMERIC(14,5),
  profit               NUMERIC(14,2),
  commission           NUMERIC(14,4),
  swap                 NUMERIC(14,4),
  metaapi_position_id  TEXT,
  metaapi_order_id     TEXT,
  account_type         TEXT DEFAULT 'broker',
  synced_from_metaapi  BOOLEAN DEFAULT false,
  note                 TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trade_ops_trade  ON public.trade_operations(trade_id);
CREATE INDEX IF NOT EXISTS idx_trade_ops_abb    ON public.trade_operations(abbonamento_id);
CREATE INDEX IF NOT EXISTS idx_trade_ops_client ON public.trade_operations(client_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_ops_meta
  ON public.trade_operations(trade_id, metaapi_position_id)
  WHERE metaapi_position_id IS NOT NULL;

-- 6. RIMBORSI
CREATE TABLE IF NOT EXISTS public.rimborsi (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       TEXT REFERENCES public.clients(id) ON DELETE CASCADE,
  abbonamento_id  TEXT REFERENCES public.abbonamenti(id) ON DELETE CASCADE,
  importo         NUMERIC(14,2) NOT NULL,
  data_rimborso   DATE NOT NULL DEFAULT CURRENT_DATE,
  stato           TEXT NOT NULL DEFAULT 'da_pagare'
                  CHECK (stato IN ('da_pagare','pagato','annullato')),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rimborsi_client ON public.rimborsi(client_id);
CREATE INDEX IF NOT EXISTS idx_rimborsi_abb    ON public.rimborsi(abbonamento_id);
CREATE INDEX IF NOT EXISTS idx_rimborsi_data   ON public.rimborsi(data_rimborso DESC);

-- 7. STRATEGY_CONFIG
CREATE TABLE IF NOT EXISTS public.strategy_config (
  giorno      INTEGER PRIMARY KEY CHECK (giorno BETWEEN 1 AND 4),
  loss_cumul  NUMERIC(14,2) NOT NULL,
  note        TEXT
);
INSERT INTO public.strategy_config (giorno, loss_cumul, note) VALUES
  (1, 500,  'Giorno 1 - perdita cumulata limite'),
  (2, 1500, 'Giorno 2'),
  (3, 3500, 'Giorno 3'),
  (4, 5859, 'Giorno 4 - rimborso totale attivato')
ON CONFLICT (giorno) DO NOTHING;

-- 8. METAAPI_SYNC_LOG
CREATE TABLE IF NOT EXISTS public.metaapi_sync_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  abbonamento_id  TEXT REFERENCES public.abbonamenti(id) ON DELETE SET NULL,
  trades_count    INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','partial','error')),
  error_msg       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sync_log_abb  ON public.metaapi_sync_log(abbonamento_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_date ON public.metaapi_sync_log(created_at DESC);

-- 9. RLS default deny
ALTER TABLE public.users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_operations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rimborsi          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.strategy_config   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.metaapi_sync_log  ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN CREATE POLICY deny_all_users     ON public.users     FOR ALL USING (false); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY deny_all_login_log ON public.login_log FOR ALL USING (false); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY deny_all_trade_ops ON public.trade_operations FOR ALL USING (false); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY deny_all_rimborsi  ON public.rimborsi  FOR ALL USING (false); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY deny_all_strat_cfg ON public.strategy_config FOR ALL USING (false); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY deny_all_sync_log  ON public.metaapi_sync_log FOR ALL USING (false); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
