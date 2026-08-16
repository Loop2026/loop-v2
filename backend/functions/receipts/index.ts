// Edge function: receipts — archivio ricevute challenge (checkout_orders + bucket 'receipts')
// Due modalità:
//  1) Cliente loggato (Bearer JWT dashboard, role=client) →
//     { action:'list' }                  → le PROPRIE ricevute pagate
//     { action:'download', order_id }    → URL firmato (5 min) del proprio PDF
//  2) Gestionale (header x-internal-secret = CHECKOUT_LINK_SECRET) →
//     { action:'list', from?, to?, method?, q? } → tutte le ricevute con filtri
//     { action:'download', order_id }            → URL firmato del PDF
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v2.8/mod.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET_RAW = Deno.env.get('JWT_SECRET') ?? 'loop-secret-change-in-production';
const LINK_SECRET = Deno.env.get('CHECKOUT_LINK_SECRET') ?? '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

async function jwtKey() {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET_RAW), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
}
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const COLS = 'order_id, client_id, name, email, amount, payment_method, receipt_no, receipt_path, paid_at, created_at, items, status';

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let b: any = {};
  try { b = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const action = b.action || 'list';
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── Modalità gestionale (tutte le ricevute) ──
  const internal = req.headers.get('x-internal-secret');
  if (internal) {
    if (!LINK_SECRET || !safeEq(internal, LINK_SECRET)) return json({ error: 'unauthorized' }, 401);

    if (action === 'download') {
      if (!b.order_id) return json({ error: 'order_id_required' }, 400);
      const { data: o } = await sb.from('checkout_orders').select('receipt_path, receipt_no').eq('order_id', b.order_id).single();
      if (!o || !o.receipt_path) return json({ error: 'receipt_not_found' }, 404);
      const { data: su, error } = await sb.storage.from('receipts').createSignedUrl(o.receipt_path, 300);
      if (error || !su) return json({ error: 'sign_failed' }, 500);
      return json({ ok: true, url: su.signedUrl, receipt_no: o.receipt_no });
    }

    // Cancella un PDF orfano dal bucket 'receipts' (nessuna riga checkout_orders lo referenzia).
    // Serve a pulire i residui di test senza rischiare di toccare una ricevuta reale.
    if (action === 'delete_orphan') {
      const paths: string[] = Array.isArray(b.paths) ? b.paths : (b.path ? [b.path] : []);
      if (!paths.length) return json({ error: 'path_required' }, 400);
      const { data: linked } = await sb.from('checkout_orders').select('receipt_path').in('receipt_path', paths);
      const inUse = new Set((linked || []).map((r: any) => r.receipt_path));
      const removable = paths.filter((p) => !inUse.has(p));
      const skipped = paths.filter((p) => inUse.has(p));
      if (!removable.length) return json({ ok: true, removed: [], skipped });
      const { error: rmErr } = await sb.storage.from('receipts').remove(removable);
      if (rmErr) return json({ error: 'remove_failed', detail: rmErr.message }, 500);
      return json({ ok: true, removed: removable, skipped });
    }

    // list con filtri
    let q = sb.from('checkout_orders').select(COLS).eq('status', 'paid').order('paid_at', { ascending: false }).limit(2000);
    if (b.from) q = q.gte('paid_at', b.from);
    if (b.to) q = q.lte('paid_at', b.to);
    if (b.method === 'card' || b.method === 'crypto') q = q.eq('payment_method', b.method);
    if (b.client_id) q = q.eq('client_id', String(b.client_id));
    const { data, error } = await q;
    if (error) return json({ error: 'query_failed', detail: error.message }, 500);
    let rows = data || [];
    if (b.q) {
      const needle = String(b.q).toLowerCase();
      rows = rows.filter((r: any) =>
        String(r.receipt_no || '').toLowerCase().includes(needle) ||
        String(r.name || '').toLowerCase().includes(needle) ||
        String(r.email || '').toLowerCase().includes(needle) ||
        String(r.client_id || '').toLowerCase().includes(needle) ||
        String(r.order_id || '').toLowerCase().includes(needle));
    }
    return json({ ok: true, receipts: rows });
  }

  // ── Modalità cliente (solo le proprie) ──
  const token = req.headers.get('authorization')?.slice(7);
  if (!token) return json({ error: 'token_mancante' }, 401);
  let payload: any;
  try { payload = await verify(token, await jwtKey()); } catch { return json({ error: 'token_non_valido' }, 401); }
  if (payload.role !== 'client' || !payload.clientId) return json({ error: 'client_only' }, 403);
  const cid = String(payload.clientId);

  if (action === 'download') {
    if (!b.order_id) return json({ error: 'order_id_required' }, 400);
    const { data: o } = await sb.from('checkout_orders').select('receipt_path, receipt_no, client_id').eq('order_id', b.order_id).single();
    if (!o || o.client_id !== cid) return json({ error: 'receipt_not_found' }, 404);
    if (!o.receipt_path) return json({ error: 'pdf_not_archived' }, 404);
    const { data: su, error } = await sb.storage.from('receipts').createSignedUrl(o.receipt_path, 300);
    if (error || !su) return json({ error: 'sign_failed' }, 500);
    return json({ ok: true, url: su.signedUrl, receipt_no: o.receipt_no });
  }

  const { data, error } = await sb.from('checkout_orders')
    .select('order_id, amount, payment_method, receipt_no, receipt_path, paid_at, items')
    .eq('client_id', cid).eq('status', 'paid')
    .order('paid_at', { ascending: false }).limit(200);
  if (error) return json({ error: 'query_failed' }, 500);
  return json({ ok: true, receipts: data || [] });
});
