-- ============================================================================
-- Migration: add_subscription_link_fields
-- Applicata: 2026-04-29
-- Progetto: loop-mt5-vault (danjmobsceriqltlnpyn)
-- ----------------------------------------------------------------------------
-- Stesso pattern di owner_name/owner_email: NON è source of truth qui (lo è
-- Phoenix), è una copia mantenuta da Loop v2 per facilitare ARBITRAGE CONSOLE.
-- Un cliente può avere N conti MT5, uno per abbonamento. Questi due campi
-- permettono di sapere a quale abbonamento appartiene ogni conto e di che tipo.
-- ============================================================================

alter table public.mt5_accounts
  add column if not exists loop_abbonamento_id text,
  add column if not exists subscription_type   text;

create index if not exists idx_mt5_loop_abbonamento_id
  on public.mt5_accounts (loop_abbonamento_id)
  where loop_abbonamento_id is not null;

create index if not exists idx_mt5_subscription_type
  on public.mt5_accounts (subscription_type)
  where subscription_type is not null;

comment on column public.mt5_accounts.loop_abbonamento_id is
  'ID abbonamento Loop v2 a cui questo conto MT5 è associato (es. "C005-A1"). 1 conto MT5 = 1 abbonamento. DENORMALIZZATO da Loop v2.';

comment on column public.mt5_accounts.subscription_type is
  'Tipologia abbonamento (Trimestrale|Semestrale|Annuale). DENORMALIZZATO: source of truth in Phoenix, propagato via Loop v2.';
