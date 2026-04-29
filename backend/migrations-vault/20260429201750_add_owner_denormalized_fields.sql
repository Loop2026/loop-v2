-- ============================================================================
-- Migration: add_owner_denormalized_fields
-- Applicata: 2026-04-29
-- Progetto: loop-mt5-vault (danjmobsceriqltlnpyn)
-- ----------------------------------------------------------------------------
-- Aggiunta dati intestatario denormalizzati al vault MT5.
-- ARBITRAGE CONSOLE e altre app consumer leggono SOLO dal vault.
-- Per evitare giri attraverso Loop v2 o Phoenix, copiamo qui nome+email
-- dell'intestatario. La fonte di verità resta Phoenix (per i dati anagrafici)
-- ma il vault è popolato/aggiornato esclusivamente da Loop v2 (intermediario).
--
-- I campi sono denormalizzati: NON è source of truth qui, è una copia.
-- Quando il dato cambia su Phoenix, Loop v2 deve riallineare il vault
-- (oggi manuale, in futuro via webhook Phoenix).
-- ============================================================================

alter table public.mt5_accounts
  add column if not exists owner_name        text,
  add column if not exists owner_email       text,
  add column if not exists loop_client_id    text,
  add column if not exists owner_synced_at   timestamptz;

create index if not exists idx_mt5_owner_email
  on public.mt5_accounts (owner_email)
  where owner_email is not null;

create index if not exists idx_mt5_loop_client_id
  on public.mt5_accounts (loop_client_id)
  where loop_client_id is not null;

comment on column public.mt5_accounts.owner_name is
  'Nome completo intestatario conto MT5. DENORMALIZZATO: copia da Loop v2 (che a sua volta legge da Phoenix). Aggiornato dal flusso provisioning o sync.';

comment on column public.mt5_accounts.owner_email is
  'Email intestatario conto MT5. DENORMALIZZATO: copia da Loop v2 (che a sua volta legge da Phoenix). Source of truth in Phoenix.';

comment on column public.mt5_accounts.loop_client_id is
  'ID cliente in Loop v2 (es. C005). Riferimento incrociato per ricostruire il legame conto MT5 -> abbonamento -> cliente.';

comment on column public.mt5_accounts.owner_synced_at is
  'Timestamp ultima sincronizzazione dei campi owner_* da Loop v2. Permette di sapere se i dati sono freschi.';
