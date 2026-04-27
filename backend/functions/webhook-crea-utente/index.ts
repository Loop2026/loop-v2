// ============================================================================
// Edge function: webhook-crea-utente
// ----------------------------------------------------------------------------
// POST endpoint per creazione automatica utenti CLIENT da sistemi esterni
// (Gestionale Phoenix, CRM, payment processor, ecc.).
//
// Auth: header `x-webhook-secret` confrontato (timing-safe) con env WEBHOOK_SECRET.
//       Mismatch o mancante → 401 Unauthorized.
//
// Body JSON:
//   {
//     "email":     "mario.rossi@email.com",
//     "firstName": "Mario",
//     "lastName":  "Rossi",
//     "password":  "Kp4mRvNqT2"
//   }
//
// Behavior:
//   - Idempotente: se l'email esiste già su `users` → 200 { ok:true, created:false }
//   - Altrimenti crea atomicamente:
//       (1) record in `clients` con id auto-generato (C001, C002, ...)
//       (2) record in `users` con role='client' e link al client_id appena creato
//     Se step (2) fallisce, rollback step (1).
//   - Risponde 201 con { ok:true, created:true, client_id, user_id, email }
//
// Hash password: SHA-256 + salt 'loop_salt_2026' (compatibile con auth/index.ts).
// NOTA SICUREZZA: hash più debole di bcrypt (no per-user salt, fast hash).
// Se in futuro l'auth viene migrata a bcrypt, aggiornare anche questa funzione.
// ============================================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WEBHOOK_SECRET = Deno.env.get('WEBHOOK_SECRET') ?? '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-webhook-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Hash compatibile con auth/index.ts (vedi linea 33 della auth function).
async function hashPassword(pwd: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pwd + 'loop_salt_2026'));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Confronto timing-safe per evitare attacchi di timing sul secret.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Genera prossimo client_id sequenziale (C001, C002, ...).
async function nextClientId(sb: any): Promise<string> {
  const { data: all } = await sb.from('clients').select('id');
  const maxNum = (all ?? []).reduce((mx: number, c: any) => {
    const n = parseInt(String(c.id || '').replace(/^C/, ''), 10) || 0;
    return n > mx ? n : mx;
  }, 0);
  return 'C' + String(maxNum + 1).padStart(3, '0');
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Metodo non supportato (solo POST)' }, 405);

  // ── 1. Verifica WEBHOOK_SECRET (env) ────────────────────────────────────
  if (!WEBHOOK_SECRET) {
    return json({ error: 'Server config error: WEBHOOK_SECRET non impostato' }, 500);
  }
  const provided = req.headers.get('x-webhook-secret') || '';
  if (!timingSafeEqual(provided, WEBHOOK_SECRET)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // ── 2. Parse body ────────────────────────────────────────────────────────
  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: 'Body JSON non valido' }, 400); }

  const email = (body.email || '').toString().toLowerCase().trim();
  const firstName = (body.firstName || '').toString().trim();
  const lastName = (body.lastName || '').toString().trim();
  const password = (body.password || '').toString();
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || email;

  if (!email || !password) {
    return json({ error: 'Campi obbligatori: email, password' }, 400);
  }
  if (password.length < 8) {
    return json({ error: 'Password troppo corta (minimo 8 caratteri)' }, 400);
  }
  // Validazione minimale email (no full RFC 5322, basta evitare garbage)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Email non valida' }, 400);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── 3. Idempotency check su users.email ─────────────────────────────────
  const { data: existingUser } = await sb
    .from('users')
    .select('id, email, client_id')
    .eq('email', email)
    .maybeSingle();

  if (existingUser) {
    return json({
      ok: true,
      created: false,
      reason: 'email already exists',
      user_id: existingUser.id,
      client_id: existingUser.client_id,
    }, 200);
  }

  // ── 4. Crea record in clients (con id auto-generato, retry su collisione) ─
  let clientId = '';
  let createdClient: any = null;
  for (let i = 0; i < 5; i++) {
    clientId = await nextClientId(sb);
    const r = await sb.from('clients').insert({
      id: clientId,
      name: fullName,
      email,
      stato: 'attivo',
    }).select().single();
    if (!r.error) { createdClient = r.data; break; }
    // Se l'errore non è un duplicate key (race condition su id), abortisci.
    if (!String(r.error.message || '').includes('duplicate')) {
      return json({ ok: false, error: 'Errore creazione cliente: ' + r.error.message }, 500);
    }
    // Altrimenti retry con prossimo id
  }
  if (!createdClient) {
    return json({ ok: false, error: 'Impossibile generare client_id univoco dopo 5 tentativi' }, 500);
  }

  // ── 5. Crea record in users (con rollback su clients in caso di errore) ──
  const pwdHash = await hashPassword(password);
  const userR = await sb.from('users').insert({
    email,
    pwd_hash: pwdHash,
    role: 'client',
    name: fullName,
    client_id: clientId,
    stato: 'attivo',
  }).select('id, email, client_id, name, role').single();

  if (userR.error) {
    // Rollback clients per non lasciare orfani
    await sb.from('clients').delete().eq('id', clientId);
    return json({ ok: false, error: 'Errore creazione utente: ' + userR.error.message }, 500);
  }

  return json({
    ok: true,
    created: true,
    client_id: clientId,
    user_id: userR.data.id,
    email,
    name: fullName,
  }, 201);
});
