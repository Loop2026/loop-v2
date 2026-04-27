// Edge function: users  (V2 - invariata rispetto a v1)
// Gestione utenti interni dell'azienda (admin) + lettura log accessi.
// NON gestisce gli utenti 'client' (quelli si creano tramite /clients).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v2.8/mod.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET_RAW = Deno.env.get('JWT_SECRET') ?? 'loop-secret-change-in-production';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
};
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

async function getKey() {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET_RAW), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
}

async function hashPassword(pwd: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pwd + 'loop_salt_2026'));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  const token = req.headers.get('authorization')?.slice(7);
  if (!token) return json({ error: 'Token mancante' }, 401);
  let payload: any;
  try { payload = await verify(token, await getKey()); } catch { return json({ error: 'Token non valido' }, 401); }
  if (payload.role !== 'admin') return json({ error: 'Accesso non autorizzato (solo admin)' }, 403);

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const sub = parts.length > 1 ? parts[parts.length - 1] : null;

  if (req.method === 'GET' && sub === 'login-log') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const emailFilter = url.searchParams.get('email');
    const roleFilter = url.searchParams.get('role');
    let q: any = sb.from('login_log').select('*', { count: 'exact' }).order('login_at', { ascending: false });
    if (emailFilter) q = q.ilike('email', '%' + emailFilter + '%');
    if (roleFilter) q = q.eq('role', roleFilter);
    q = q.range(offset, offset + limit - 1);
    const { data, count } = await q;
    return json({ log: data ?? [], total: count ?? 0 });
  }

  if (req.method === 'GET' && !sub) {
    const { data } = await sb.from('users')
      .select('id, email, name, role, stato, last_login, created_at')
      .in('role', ['admin', 'operator'])
      .order('created_at', { ascending: true });
    return json({ users: data ?? [] });
  }

  if (req.method === 'GET' && sub && sub !== 'users') {
    const { data, error } = await sb.from('users')
      .select('id, email, name, role, stato, last_login, created_at')
      .eq('id', sub).single();
    if (error) return json({ error: 'Non trovato' }, 404);
    return json(data);
  }

  if (req.method === 'POST') {
    const body = await req.json();
    const { email, name, role = 'admin', password, stato = 'attivo' } = body;
    if (!email || !name || !password) return json({ error: 'Email, nome e password obbligatori' }, 400);
    if (!['admin', 'operator'].includes(role)) return json({ error: 'Ruolo non valido' }, 400);

    const { data: existing } = await sb.from('users').select('id').eq('email', email.toLowerCase().trim()).maybeSingle();
    if (existing) return json({ error: 'Esiste gia un utente con questa email' }, 409);

    const pwdHash = await hashPassword(password);
    const { data, error } = await sb.from('users').insert({
      email: email.toLowerCase().trim(),
      name, role, pwd_hash: pwdHash, stato, client_id: null,
    }).select('id, email, name, role, stato, created_at').single();
    if (error) return json({ error: error.message }, 400);
    return json({ user: data }, 201);
  }

  if (req.method === 'PUT' && sub) {
    const body = await req.json();
    const { name, email, role, password, stato } = body;
    const fields: any = {};
    if (name !== undefined) fields.name = name;
    if (email !== undefined) fields.email = email.toLowerCase().trim();
    if (role !== undefined) {
      if (!['admin', 'operator'].includes(role)) return json({ error: 'Ruolo non valido' }, 400);
      fields.role = role;
    }
    if (stato !== undefined) {
      if (!['attivo', 'sospeso'].includes(stato)) return json({ error: 'Stato non valido' }, 400);
      fields.stato = stato;
    }
    if (password) fields.pwd_hash = await hashPassword(password);
    if (Object.keys(fields).length === 0) return json({ error: 'Nessun campo da aggiornare' }, 400);

    const { data, error } = await sb.from('users').update(fields).eq('id', sub)
      .select('id, email, name, role, stato, last_login').single();
    if (error) return json({ error: error.message }, 400);
    return json({ user: data });
  }

  if (req.method === 'PATCH' && sub) {
    const { stato } = await req.json();
    if (!['attivo', 'sospeso'].includes(stato)) return json({ error: 'Stato non valido' }, 400);
    const { error } = await sb.from('users').update({ stato }).eq('id', sub).in('role', ['admin', 'operator']);
    if (error) return json({ error: error.message }, 400);
    return json({ message: 'Utente ' + stato });
  }

  if (req.method === 'DELETE' && sub) {
    if (payload.sub && sub === payload.sub) {
      return json({ error: 'Non puoi eliminare il tuo stesso account' }, 400);
    }
    const { data: target } = await sb.from('users').select('role, email').eq('id', sub).single();
    if (!target) return json({ error: 'Utente non trovato' }, 404);
    if (target.role === 'client') return json({ error: 'Usa /clients per eliminare i clienti' }, 400);
    if (target.role === 'admin') {
      const { count } = await sb.from('users').select('*', { count: 'exact', head: true }).eq('role', 'admin').eq('stato', 'attivo');
      if ((count ?? 0) <= 1) return json({ error: 'Impossibile eliminare: ultimo admin attivo' }, 400);
    }
    const { error } = await sb.from('users').delete().eq('id', sub);
    if (error) return json({ error: error.message }, 500);
    return json({ message: 'Utente eliminato' });
  }

  return json({ error: 'Metodo non supportato' }, 405);
});
