-- ============================================================================
-- Migration: fix_trade_ops_upsert_constraint
-- Applicata: 2026-04-18
-- Progetto: loop-dashboard-v2 (sytnajozvreoetsluzdd)
-- ----------------------------------------------------------------------------
-- Fix (2026-04-18): l'edge function trades fa upsert con
-- onConflict: 'trade_id,metaapi_position_id'. Il client Supabase PostgREST
-- non supporta l'inferenza ON CONFLICT su PARTIAL unique index (che richiede
-- il predicato WHERE nella clausola), quindi Postgres restituiva
-- "there is no unique or exclusion constraint matching the ON CONFLICT specification".
-- Sostituiamo l'indice parziale con un indice UNIQUE full.
-- Nota: per lo standard Postgres NULL != NULL nei UNIQUE, quindi le operazioni
-- manuali (metaapi_position_id IS NULL) continuano a essere ammesse in quantita' arbitraria
-- per lo stesso trade_id — comportamento identico alla partial precedente.
-- ============================================================================

DROP INDEX IF EXISTS public.uq_trade_ops_meta;

CREATE UNIQUE INDEX uq_trade_ops_meta
  ON public.trade_operations (trade_id, metaapi_position_id);
