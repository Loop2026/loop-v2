// Edge function: auth  (V2 - multi-abbonamento)
// Login con email+password. Ritorna JWT + profilo cliente con array abbonamenti[].
// Differenze vs v1:
//   - Profilo cliente include `abbonamenti[]` (non piu' un singolo slot)
//   - Abbonamenti ordinati per `ordine` crescente (A1 per primo)
//   - Solo abbonamenti con stato != 'archiviato' vengono restituiti al cliente

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { create, getNumericDate } from 'https://deno.land/x/djwt@v2.8/mod.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET_RAW = Deno.env.get('JWT_SECRET') ?? 'loop-secret-change-in-production';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function getCryptoKey(secret: string) {
  const enc = new TextEncoder();
  return await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify']
  );
}

async function hashPassword(pwd: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(pwd + 'loop_salt_2026'));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { email, password } = await req.json();
    if (!email || !password) {
      return new Response(JSON.stringify({ error: 'Email e password obbligatorie' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: user, error } = await supabase
      .from('users').select('*')
      .eq('email', email.toLowerCase().trim()).single();

    if (error || !user) {
      return new Response(JSON.stringify({ error: 'Credenziali non valide' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const pwdHash = await hashPassword(password);
    if (user.pwd_hash !== pwdHash) {
      return new Response(JSON.stringify({ error: 'Credenziali non valide' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (user.stato === 'sospeso') {
      return new Response(JSON.stringify({ error: 'Account sospeso. Contatta il supporto LOOP.' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const key = await getCryptoKey(JWT_SECRET_RAW);
    const token = await create(
      { alg: 'HS256', typ: 'JWT' },
      { sub: email, role: user.role, name: user.name, clientId: user.client_id, exp: getNumericDate(60 * 60 * 24 * 7) },
      key
    );

    await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
            || req.headers.get('x-real-ip')
            || req.headers.get('cf-connecting-ip')
            || null;
    const ua = req.headers.get('user-agent') || null;
    await supabase.from('login_log').insert({
      user_id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      ip_address: ip,
      user_agent: ua,
    });

    let profile = null;
    if (user.role === 'client' && user.client_id) {
      const { data: client } = await supabase
        .from('clients')
        .select('id, name, email, phone, stato, note, created_at')
        .eq('id', user.client_id).single();

      if (client) {
        const { data: abbonamenti } = await supabase
          .from('abbonamenti')
          .select(`
            id, ordine, alias, piano,
            prezzo_base, sconto_eur, prezzo_finale,
            data_inizio, data_scad,
            capitale_broker, capitale_prop, cicli_mese,
            stato, giorno_ciclo, ultimo_ciclo,
            mt5_server, mt5_account, metaapi_id,
            note, created_at
          `)
          .eq('client_id', user.client_id)
          .neq('stato', 'archiviato')
          .order('ordine', { ascending: true });

        profile = { ...client, abbonamenti: abbonamenti ?? [] };
      }
    }

    return new Response(JSON.stringify({
      token,
      role: user.role,
      name: user.name,
      clientId: user.client_id,
      profile
    }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
