// Edge function: checkout-link
// Due modalità:
//  1) Cliente loggato (Bearer JWT della dashboard) → genera il link FIRMATO verso il checkout
//     challenge (cid + scadenza 15 min + firma HMAC-sha512 con CHECKOUT_LINK_SECRET).
//  2) Server-to-server (header x-internal-secret) → il checkout Netlify verifica il token e
//     riceve l'anagrafica ESATTA (name, email, phone) per il prefill bloccato del billing.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v2.8/mod.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET_RAW = Deno.env.get('JWT_SECRET') ?? 'loop-secret-change-in-production';
const LINK_SECRET = Deno.env.get('CHECKOUT_LINK_SECRET') ?? '';
const CHECKOUT_URL = Deno.env.get('CHECKOUT_URL') ?? 'https://loop-challenge-checkout.netlify.app';

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
async function hmac512(msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(LINK_SECRET), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!LINK_SECRET) return json({ error: 'checkout_link_secret_missing' }, 500);

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const internal = req.headers.get('x-internal-secret');
  if (internal) {
    if (!safeEq(internal, LINK_SECRET)) return json({ error: 'unauthorized' }, 401);
    let b: any = {};
    try { b = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

    // Azione: salva l'ordine appena creato sul checkout (per ricevuta post-pagamento)
    if (b.action === 'save_order') {
      const o = b.order || {};
      if (!o.order_id || !o.client_id) return json({ error: 'missing_order_fields' }, 400);
      const { error } = await sb.from('checkout_orders').upsert({
        order_id: String(o.order_id),
        client_id: String(o.client_id),
        name: o.name ?? null,
        email: o.email ?? null,
        phone: o.phone ?? null,
        items: o.items ?? {},
        amount: Number(o.amount) || 0,
        address: o.address ?? null,
        track_id: o.track_id != null ? String(o.track_id) : null,
        status: 'created',
      }, { onConflict: 'order_id' });
      if (error) return json({ error: 'save_failed', detail: error.message }, 500);
      return json({ ok: true });
    }

    const { cid, exp, sig } = b;
    if (!cid || !exp || !sig) return json({ error: 'missing_fields' }, 400);
    if (Date.now() / 1000 > Number(exp)) return json({ error: 'link_expired' }, 401);
    const calc = await hmac512(`${cid}.${exp}`);
    if (!safeEq(calc, String(sig))) return json({ error: 'invalid_signature' }, 401);
    const { data: c, error } = await sb.from('clients').select('id, name, email, phone').eq('id', cid).single();
    if (error || !c) return json({ error: 'client_not_found' }, 404);
    return json({ ok: true, client: c });
  }

  const token = req.headers.get('authorization')?.slice(7);
  if (!token) return json({ error: 'Token mancante' }, 401);
  let payload: any;
  try { payload = await verify(token, await jwtKey()); } catch { return json({ error: 'Token non valido' }, 401); }

  let cid: string | null = null;
  if (payload.role === 'client' && payload.clientId) cid = String(payload.clientId);
  else if (['admin', 'operator'].includes(payload.role)) {
    try { const b = await req.json(); cid = b?.cid ?? null; } catch { /* noop */ }
  }
  if (!cid) return json({ error: 'client_only' }, 403);

  const { data: c, error } = await sb.from('clients').select('id').eq('id', cid).single();
  if (error || !c) return json({ error: 'client_not_found' }, 404);

  const exp = Math.floor(Date.now() / 1000) + 15 * 60;
  const sig = await hmac512(`${cid}.${exp}`);
  const url = `${CHECKOUT_URL}/?cid=${encodeURIComponent(cid)}&exp=${exp}&sig=${sig}`;
  return json({ ok: true, url });
});
