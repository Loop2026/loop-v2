-- ============================================================================
-- Migration: add_mt5_account_id_fk_to_abbonamenti
-- Applicata: 2026-04-25
-- Progetto: loop-dashboard-v2 (sytnajozvreoetsluzdd)
-- ----------------------------------------------------------------------------
-- Aggiunta FK logico verso loop-mt5-vault
-- abbonamenti.mt5_account_id punta a public.mt5_accounts.id nel progetto
-- separato `loop-mt5-vault` (danjmobsceriqltlnpyn). Cross-project = no FK SQL,
-- l'integrità è garantita applicativamente dalla edge function `abbonamenti`.
-- ============================================================================

alter table public.abbonamenti
  add column if not exists mt5_account_id uuid;

create index if not exists idx_abb_mt5_account_id
  on public.abbonamenti (mt5_account_id)
  where mt5_account_id is not null;

comment on column public.abbonamenti.mt5_account_id is
  'FK logico verso loop-mt5-vault.public.mt5_accounts.id. Cross-project: integrità applicativa via edge function abbonamenti, non SQL FK.';
