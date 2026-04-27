// Edge function: clients  (V2 - solo anagrafica + login)
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
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

async function getKey() {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET_RAW), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
}

async function hashPassword(pwd: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pwd + 'loop_salt_2026'));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function nextClientId(sb: any): Promise<string> {
  const { data: all } = await sb.from('clients').select('id');
  const maxNum = (all ?? []).reduce((mx: number, c: any) => {
    const n = parseInt(String(c.id || '').replace(/^C/, ''), 10) || 0;
    return n > mx ? n : mx;
  }, 0);
  return 'C' + String(maxNum + 1).padStart(3, '0');
}

function prezzoBase(piano: string): number {
  switch (piano) {
    case 'Trimestrale': return 1250;
    case 'Semestrale':  return 2250;
    case 'Annuale':     return 4250;
    default: throw new Error('Piano non valido: ' + piano);
  }
}

function scadenzaDa(data: string, piano: string): string {
  const d = new Date(data);
  if (piano === 'Trimestrale') d.setMonth(d.getMonth() + 3);
  else if (piano === 'Semestrale') d.setMonth(d.getMonth() + 6);
  else d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().split('T')[0];
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  const token = req.headers.get('authorization')?.slice(7);
  if (!token) return json({ error: 'Token mancante' }, 401);
  let payload: any;
  try { payload = await verify(token, await getKey()); } catch { return json({ error: 'Token non valido' }, 401); }
  if (!['admin', 'operator'].includes(payload.role)) return json({ error: 'Accesso non autorizzato' }, 403);

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const clientId = parts.length > 1 ? parts[parts.length - 1] : null;

  if (req.method === 'GET') {
    if (clientId && clientId !== 'clients') {
      const { data, error } = await sb.from('clients')
        .select(`id, name, email, phone, stato, note, created_at, abbonamenti(id, ordine, alias, piano, prezzo_base, sconto_eur, prezzo_finale, data_inizio, data_scad, capitale_broker, capitale_prop, cicli_mese, stato, giorno_ciclo, ultimo_ciclo, mt5_server, mt5_account, metaapi_id, note, created_at)`)
        .eq('id', clientId).single();
      if (error) return json({ error: 'Non trovato' }, 404);
      if (data && Array.isArray((data as any).abbonamenti)) {
        (data as any).abbonamenti.sort((a: any, b: any) => a.ordine - b.ordine);
      }
      return json(data);
    }

    const stato = url.searchParams.get('stato');
    const q = url.searchParams.get('q');
    let query: any = sb.from('clients')
      .select(`id, name, email, phone, stato, note, created_at, abbonamenti(id, ordine, piano, stato, prezzo_finale, data_scad, giorno_ciclo)`)
      .order('created_at', { ascending: false });
    if (stato) query = query.eq('stato', stato);
    if (q) query = query.or(`name.ilike.%${q}%,email.ilike.%${q}%`);
    const { data } = await query;

    const list = (data ?? []).map((c: any) => {
      const abb = Array.isArray(c.abbonamenti) ? c.abbonamenti : [];
      return {
        ...c,
        abb_totali: abb.length,
        abb_attivi: abb.filter((a: any) => a.stato === 'attivo').length,
      };
    });
    return json({ clients: list, total: list.length });
  }

  if (req.method === 'POST') {
    const body = await req.json();
    const { name, email, phone, stato = 'attivo', note, password, primoAbbonamento } = body;
    if (!name || !email) return json({ error: 'Nome ed email obbligatori' }, 400);

    let client: any = null; let cErr: any = null; let newId = '';
    for (let i = 0; i < 5; i++) {
      newId = await nextClientId(sb);
      const r = await sb.from('clients').insert({
        id: newId, name, email: email.toLowerCase().trim(),
        phone: phone ?? null, stato, note: note ?? null,
      }).select().single();
      if (!r.error) { client = r.data; cErr = null; break; }
      cErr = r.error;
      if (!String(r.error.message || '').includes('duplicate key')) break;
    }
    if (!client) return json({ error: cErr?.message || 'Errore inserimento cliente' }, 400);

    const pwdRaw = password || `Loop${Math.floor(Math.random() * 9000 + 1000)}`;
    const pwdHash = await hashPassword(pwdRaw);
    const uRes = await sb.from('users').insert({
      email: email.toLowerCase().trim(), pwd_hash: pwdHash, role: 'client',
      name, client_id: newId, stato: 'attivo'
    });
    if (uRes.error) {
      await sb.from('clients').delete().eq('id', newId);
      return json({ error: 'Errore creazione login: ' + uRes.error.message }, 400);
    }

    let abbonamento: any = null;
    if (primoAbbonamento && primoAbbonamento.piano) {
      const piano = primoAbbonamento.piano;
      let base = 0;
      try { base = prezzoBase(piano); }
      catch (e: any) {
        await sb.from('users').delete().eq('client_id', newId);
        await sb.from('clients').delete().eq('id', newId);
        return json({ error: e.message }, 400);
      }
      const dataInizio = primoAbbonamento.data_inizio || new Date().toISOString().split('T')[0];
      const dataScad = scadenzaDa(dataInizio, piano);

      const abbR = await sb.from('abbonamenti').insert({
        id: newId + '-A1', client_id: newId, ordine: 1,
        alias: primoAbbonamento.alias || 'Abbonamento principale',
        piano, prezzo_base: base, sconto_eur: 0,
        data_inizio: dataInizio, data_scad: dataScad,
        capitale_broker: 5500, capitale_prop: 100000,
        cicli_mese: primoAbbonamento.cicli_mese ?? 15,
        stato: 'attivo', giorno_ciclo: 1,
        mt5_server: primoAbbonamento.mt5_server ?? null,
        mt5_account: primoAbbonamento.mt5_account ?? null,
        mt5_pwd: primoAbbonamento.mt5_pwd ?? null,
        metaapi_id: primoAbbonamento.metaapi_id ?? null,
      }).select().single();

      if (abbR.error) {
        await sb.from('users').delete().eq('client_id', newId);
        await sb.from('clients').delete().eq('id', newId);
        return json({ error: 'Errore creazione abbonamento: ' + abbR.error.message }, 400);
      }
      abbonamento = abbR.data;
    }

    return json({ client, abbonamento, password: pwdRaw }, 201);
  }

  if (req.method === 'PUT' && clientId) {
    const body = await req.json();
    const { password, name, email, phone, note, stato } = body;
    const fields: any = {};
    if (name !== undefined) fields.name = name;
    if (email !== undefined) fields.email = email.toLowerCase().trim();
    if (phone !== undefined) fields.phone = phone;
    if (note !== undefined) fields.note = note;
    if (stato !== undefined) fields.stato = stato;

    let clientData: any = null;
    if (Object.keys(fields).length > 0) {
      const { data, error } = await sb.from('clients').update(fields).eq('id', clientId).select().single();
      if (error) return json({ error: error.message }, 400);
      clientData = data;
      if (fields.email || fields.name) {
        const uFields: any = {};
        if (fields.email) uFields.email = fields.email;
        if (fields.name) uFields.name = fields.name;
        await sb.from('users').update(uFields).eq('client_id', clientId);
      }
    }
    if (password) {
      const h = await hashPassword(password);
      await sb.from('users').update({ pwd_hash: h }).eq('client_id', clientId);
    }
    return json({ client: clientData ?? { id: clientId } });
  }

  if (req.method === 'PATCH' && clientId) {
    const { stato } = await req.json();
    if (!['attivo', 'sospeso'].includes(stato)) return json({ error: 'Stato non valido' }, 400);
    await sb.from('clients').update({ stato }).eq('id', clientId);
    await sb.from('users').update({ stato }).eq('client_id', clientId);
    return json({ message: `Cliente ${stato}` });
  }

  if (req.method === 'DELETE' && clientId) {
    await sb.from('trades').delete().eq('client_id', clientId);
    await sb.from('abbonamenti').delete().eq('client_id', clientId);
    await sb.from('users').delete().eq('client_id', clientId);
    const { error } = await sb.from('clients').delete().eq('id', clientId);
    if (error) return json({ error: error.message }, 500);
    return json({ message: 'Eliminato' });
  }

  return json({ error: 'Metodo non supportato' }, 405);
});
