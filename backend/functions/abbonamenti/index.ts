// Edge function: abbonamenti  (V4 - con provision-mt5 per cliente)
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v2.8/mod.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET_RAW = Deno.env.get('JWT_SECRET') ?? 'loop-secret-change-in-production';
const METAAPI_TOKEN = Deno.env.get('METAAPI_TOKEN') ?? '';

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

const PIANI = ['Trimestrale', 'Semestrale', 'Annuale'];

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

async function nextOrdine(sb: any, clientId: string): Promise<number> {
  const { data } = await sb.from('abbonamenti').select('ordine').eq('client_id', clientId);
  const max = (data ?? []).reduce((mx: number, a: any) => Math.max(mx, a.ordine || 0), 0);
  return max + 1;
}

async function createMetaApiAccount(params: { name: string; server: string; login: string; password: string; platform?: 'mt4'|'mt5'; region?: string }) : Promise<{ ok: boolean; metaapi_id?: string; error?: string; statusCode?: number; }> {
  if (!METAAPI_TOKEN) return { ok: false, error: 'METAAPI_TOKEN non configurato nel backend' };
  const body = {
    name: params.name,
    type: 'cloud-g2',
    platform: params.platform || 'mt5',
    login: String(params.login),
    password: String(params.password),
    server: String(params.server),
    magic: 0,
    region: params.region || 'new-york',
    application: 'MetaApi',
    keywords: ['loop'],
  };
  try {
    const r = await fetch('https://mt-provisioning-profile-api-v1.agiliumtrade.ai/users/current/accounts', {
      method: 'POST',
      headers: {
        'auth-token': METAAPI_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const txt = await r.text();
    let data: any = {};
    try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }
    if (!r.ok) {
      const msg = (data && (data.message || data.error)) || (data.raw ? String(data.raw).slice(0, 300) : `HTTP ${r.status}`);
      return { ok: false, error: msg, statusCode: r.status };
    }
    const metaapi_id = data.id || data._id || data.accountId;
    if (!metaapi_id) return { ok: false, error: 'Risposta MetaApi senza id', statusCode: r.status };
    return { ok: true, metaapi_id, statusCode: r.status };
  } catch (e: any) {
    return { ok: false, error: 'Errore rete MetaApi: ' + (e?.message || String(e)) };
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  const token = req.headers.get('authorization')?.slice(7);
  if (!token) return json({ error: 'Token mancante' }, 401);
  let payload: any;
  try { payload = await verify(token, await getKey()); } catch { return json({ error: 'Token non valido' }, 401); }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const id = parts.length >= 2 && parts[0] === 'abbonamenti' ? parts[1] : null;
  const action = parts.length >= 3 ? parts[2] : null;

  if (req.method === 'GET' && !id) {
    const clientIdParam = url.searchParams.get('clientId');
    if (!clientIdParam) return json({ error: 'clientId obbligatorio' }, 400);
    if (payload.role === 'client' && payload.clientId !== clientIdParam) {
      return json({ error: 'Non autorizzato' }, 403);
    }
    const onlyAttivi = url.searchParams.get('stato');
    let q: any = sb.from('abbonamenti').select('*').eq('client_id', clientIdParam).order('ordine', { ascending: true });
    if (onlyAttivi) q = q.eq('stato', onlyAttivi);
    const { data } = await q;
    return json({ abbonamenti: data ?? [] });
  }

  if (req.method === 'GET' && id) {
    const { data, error } = await sb.from('abbonamenti').select('*').eq('id', id).single();
    if (error || !data) return json({ error: 'Non trovato' }, 404);
    if (payload.role === 'client' && payload.clientId !== data.client_id) {
      return json({ error: 'Non autorizzato' }, 403);
    }
    return json(data);
  }

  if (req.method === 'POST' && !id) {
    if (!['admin', 'operator'].includes(payload.role)) return json({ error: 'Non autorizzato' }, 403);
    const body = await req.json();
    const { client_id, piano, alias, data_inizio, sconto_eur, cicli_mese, mt5_server, mt5_account, mt5_pwd, metaapi_id, note } = body;
    if (!client_id) return json({ error: 'client_id obbligatorio' }, 400);
    if (!piano || !PIANI.includes(piano)) return json({ error: 'piano deve essere Trimestrale, Semestrale o Annuale' }, 400);

    const { data: cliente } = await sb.from('clients').select('id, name').eq('id', client_id).single();
    if (!cliente) return json({ error: 'Cliente non trovato' }, 404);

    const ordine = await nextOrdine(sb, client_id);

    if (ordine > 1 && piano !== 'Annuale') {
      return json({ error: `Dal 2° abbonamento in poi e' ammesso solo il piano Annuale (4250 €). Stai cercando di creare il #${ordine} con piano ${piano}.` }, 400);
    }

    let scontoFinale = 0;
    if (ordine === 1) {
      if (sconto_eur && Number(sconto_eur) !== 0) {
        return json({ error: 'Il 1° abbonamento e\' a prezzo di listino: sconto non ammesso.' }, 400);
      }
    } else {
      scontoFinale = Math.max(0, Number(sconto_eur || 0));
    }

    let base = 0;
    try { base = prezzoBase(piano); } catch (e: any) { return json({ error: e.message }, 400); }

    if (scontoFinale > base) {
      return json({ error: `Sconto (${scontoFinale} €) non puo' superare il prezzo di listino (${base} €).` }, 400);
    }

    const dataInizio = data_inizio || new Date().toISOString().split('T')[0];
    const dataScad = scadenzaDa(dataInizio, piano);
    const newId = `${client_id}-A${ordine}`;

    const insertData: any = {
      id: newId, client_id, ordine,
      alias: alias || (ordine === 1 ? 'Abbonamento principale' : `Abbonamento ${ordine}`),
      piano, prezzo_base: base, sconto_eur: scontoFinale,
      data_inizio: dataInizio, data_scad: dataScad,
      capitale_broker: 5500, capitale_prop: 100000,
      cicli_mese: cicli_mese ?? 15, stato: 'attivo', giorno_ciclo: 1,
      mt5_server: mt5_server ?? null, mt5_account: mt5_account ?? null,
      mt5_pwd: mt5_pwd ?? null, metaapi_id: metaapi_id ?? null, note: note ?? null,
    };

    const { data: created, error } = await sb.from('abbonamenti').insert(insertData).select().single();
    if (error) {
      const msg = error.message || '';
      if (msg.includes('abbonamenti_secondo_solo_annuale')) {
        return json({ error: 'Vincolo DB: dal 2° abbonamento in poi solo Annuale.' }, 400);
      }
      if (msg.includes('abbonamenti_sconto_solo_secondo')) {
        return json({ error: 'Vincolo DB: sconto ammesso solo dal 2° abbonamento in poi.' }, 400);
      }
      if (msg.includes('abbonamenti_prezzo_coerente_piano')) {
        return json({ error: 'Vincolo DB: prezzo non coerente con il piano scelto.' }, 400);
      }
      return json({ error: msg }, 400);
    }
    return json({ abbonamento: created }, 201);
  }

  if (req.method === 'PUT' && id) {
    if (!['admin', 'operator'].includes(payload.role)) return json({ error: 'Non autorizzato' }, 403);
    const body = await req.json();
    const allowedFields = ['alias', 'sconto_eur', 'cicli_mese', 'data_inizio', 'data_scad', 'giorno_ciclo', 'mt5_server', 'mt5_account', 'mt5_pwd', 'metaapi_id', 'note'];
    const fields: any = {};
    for (const k of allowedFields) {
      if (body[k] !== undefined) fields[k] = body[k];
    }
    if (Object.keys(fields).length === 0) return json({ error: 'Nessun campo aggiornabile' }, 400);

    if (fields.sconto_eur !== undefined) {
      const { data: cur } = await sb.from('abbonamenti').select('ordine, prezzo_base').eq('id', id).single();
      if (!cur) return json({ error: 'Abbonamento non trovato' }, 404);
      if (cur.ordine === 1 && Number(fields.sconto_eur) !== 0) {
        return json({ error: 'Sconto non ammesso sul 1° abbonamento.' }, 400);
      }
      if (Number(fields.sconto_eur) > Number(cur.prezzo_base)) {
        return json({ error: 'Sconto maggiore del prezzo di listino.' }, 400);
      }
    }

    const { data, error } = await sb.from('abbonamenti').update(fields).eq('id', id).select().single();
    if (error) return json({ error: error.message }, 400);
    return json({ abbonamento: data });
  }

  if (req.method === 'PATCH' && id && !action) {
    if (!['admin', 'operator'].includes(payload.role)) return json({ error: 'Non autorizzato' }, 403);
    const { stato } = await req.json();
    if (!['attivo', 'sospeso', 'archiviato'].includes(stato)) {
      return json({ error: 'Stato non valido (attivo|sospeso|archiviato)' }, 400);
    }
    const { data, error } = await sb.from('abbonamenti').update({ stato }).eq('id', id).select().single();
    if (error) return json({ error: error.message }, 400);
    return json({ abbonamento: data, message: `Abbonamento ${stato}` });
  }

  if (req.method === 'POST' && id && action === 'rinnova') {
    if (!['admin', 'operator'].includes(payload.role)) return json({ error: 'Non autorizzato' }, 403);
    const body = await req.json().catch(() => ({}));
    const { data: cur, error: cE } = await sb.from('abbonamenti').select('*').eq('id', id).single();
    if (cE || !cur) return json({ error: 'Abbonamento non trovato' }, 404);

    const dataInizio = body.data_inizio || new Date().toISOString().split('T')[0];
    const nuovaScad = scadenzaDa(dataInizio, cur.piano);

    const fields: any = { data_inizio: dataInizio, data_scad: nuovaScad, stato: 'attivo', giorno_ciclo: 1 };
    if (body.sconto_eur !== undefined) {
      if (cur.ordine === 1 && Number(body.sconto_eur) !== 0) {
        return json({ error: 'Sconto non ammesso sul 1° abbonamento.' }, 400);
      }
      fields.sconto_eur = Math.max(0, Number(body.sconto_eur));
    }

    const { data, error } = await sb.from('abbonamenti').update(fields).eq('id', id).select().single();
    if (error) return json({ error: error.message }, 400);
    return json({ abbonamento: data, message: 'Abbonamento rinnovato' });
  }

  if (req.method === 'POST' && id && action === 'provision-mt5') {
    const body = await req.json().catch(() => ({}));
    const server = (body.server || '').toString().trim();
    const account = (body.account || '').toString().trim();
    const password = (body.password || '').toString();
    const manualId = body.manual_metaapi_id ? String(body.manual_metaapi_id).trim() : '';
    const platform = (body.platform === 'mt4' ? 'mt4' : 'mt5') as 'mt4'|'mt5';
    const region = body.region || 'new-york';

    if (!server || !account || !password) {
      return json({ error: 'Campi obbligatori mancanti: server, account, password' }, 400);
    }

    const { data: abb, error: eAbb } = await sb.from('abbonamenti')
      .select('id, client_id, alias, ordine, mt5_server, mt5_account, mt5_pwd, metaapi_id')
      .eq('id', id).single();
    if (eAbb || !abb) return json({ error: 'Abbonamento non trovato' }, 404);

    if (payload.role === 'client') {
      if (payload.clientId !== abb.client_id) return json({ error: 'Non autorizzato' }, 403);
      if (abb.metaapi_id) {
        return json({ error: 'Credenziali MT5 già registrate. Contatta l\'admin per modifiche.' }, 403);
      }
    } else if (!['admin', 'operator'].includes(payload.role)) {
      return json({ error: 'Non autorizzato' }, 403);
    }

    const { data: cli } = await sb.from('clients').select('name').eq('id', abb.client_id).single();
    const mapiName = `${(cli?.name || abb.client_id)} — ${abb.alias || ('A' + (abb.ordine || 1))}`.slice(0, 100);

    let finalMetaapiId: string | null = null;
    let metaapiError: string | null = null;
    let metaapiStatus: number | undefined = undefined;

    if (manualId) {
      finalMetaapiId = manualId;
    } else {
      const res = await createMetaApiAccount({
        name: mapiName, server, login: account, password, platform, region,
      });
      if (res.ok && res.metaapi_id) {
        finalMetaapiId = res.metaapi_id;
      } else {
        metaapiError = res.error || 'Creazione account MetaApi fallita';
        metaapiStatus = res.statusCode;
      }
    }

    const updateFields: any = {
      mt5_server: server,
      mt5_account: account,
      mt5_pwd: password,
    };
    if (finalMetaapiId) updateFields.metaapi_id = finalMetaapiId;

    const { data: updated, error: upE } = await sb.from('abbonamenti').update(updateFields).eq('id', id).select().single();
    if (upE) {
      const m = upE.message || '';
      if (/uq_abb_mt5/.test(m) || (/duplicate key/i.test(m) && /mt5/i.test(m))) {
        return json({ error: 'Account MT5 già in uso da un altro abbonamento' }, 409);
      }
      return json({ error: 'Errore salvataggio: ' + m }, 400);
    }

    if (metaapiError) {
      return json({
        abbonamento: updated,
        metaapi_ok: false,
        metaapi_error: metaapiError,
        metaapi_status: metaapiStatus,
        message: 'Credenziali MT5 salvate, ma registrazione automatica MetaApi fallita. Puoi ritentare o inserire manualmente il MetaAPI ID.',
      }, 207);
    }

    return json({
      abbonamento: updated,
      metaapi_ok: !!finalMetaapiId,
      metaapi_id: finalMetaapiId,
      message: manualId ? 'Credenziali + MetaAPI ID (manuale) salvati' : 'Account MetaApi creato e credenziali salvate',
    }, 200);
  }

  if (req.method === 'DELETE' && id) {
    if (payload.role !== 'admin') return json({ error: 'Solo admin puo\' eliminare un abbonamento' }, 403);
    await sb.from('trades').delete().eq('abbonamento_id', id);
    const { error } = await sb.from('abbonamenti').delete().eq('id', id);
    if (error) return json({ error: error.message }, 500);
    return json({ message: 'Abbonamento eliminato' });
  }

  return json({ error: 'Metodo non supportato' }, 405);
});
