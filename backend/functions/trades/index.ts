// Edge function: trades  (V2 - multi-abbonamento + Opzione A lordo/costo/netto + admin-wipe-test-data)
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v2.8/mod.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET_RAW = Deno.env.get('JWT_SECRET') ?? 'loop-secret-change-in-production';
const METAAPI_TOKEN = Deno.env.get('METAAPI_TOKEN');

const COSTO_CHALLENGE_BRUCIATA = 500;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

async function getKey() {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET_RAW), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
}

async function canAccessTrade(sb: any, payload: any, tradeId: string): Promise<{ ok: boolean; trade?: any; err?: string }> {
  const { data: trade, error } = await sb.from('trades').select('*').eq('id', tradeId).single();
  if (error || !trade) return { ok: false, err: 'Trade non trovato' };
  if (payload.role === 'admin' || payload.role === 'operator') return { ok: true, trade };
  if (payload.role === 'client' && payload.clientId === trade.client_id) return { ok: true, trade };
  return { ok: false, err: 'Non autorizzato' };
}

async function safeMetaFetch(url: string): Promise<{ ok: boolean; status: number; text: string; data?: any }> {
  try {
    const r = await fetch(url, { headers: { 'auth-token': METAAPI_TOKEN!, 'Accept': 'application/json' } });
    const txt = await r.text();
    let data: any = null;
    try { data = JSON.parse(txt); } catch {}
    return { ok: r.ok, status: r.status, text: txt, data };
  } catch (err: any) {
    return { ok: false, status: 0, text: 'DNS/network error: ' + (err.message || String(err)) };
  }
}

async function fetchMetaApiTrades(metaapiAccountId: string, startTime: string, endTime: string) {
  if (!METAAPI_TOKEN) throw new Error('METAAPI_TOKEN non configurato nelle variabili d\' ambiente di Supabase');
  const regions = ['new-york', 'london'];
  const s = encodeURIComponent(startTime);
  const e = encodeURIComponent(endTime);
  const errors: string[] = [];

  for (const region of regions) {
    const url = `https://metastats-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${metaapiAccountId}/historical-trades/${s}/${e}`;
    const r = await safeMetaFetch(url);
    if (r.ok && r.data) {
      const arr = Array.isArray(r.data) ? r.data : (r.data.trades ?? r.data.historicalTrades ?? []);
      return arr;
    }
    errors.push(`MetaStats ${region}: ${r.status} ${r.text.slice(0, 120)}`);
  }

  for (const region of regions) {
    const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${metaapiAccountId}/history-deals/time/${s}/${e}`;
    const r = await safeMetaFetch(url);
    if (r.ok && r.data) {
      const deals = Array.isArray(r.data) ? r.data : (r.data.deals ?? []);
      return groupDealsIntoTrades(deals);
    }
    errors.push(`Client ${region}: ${r.status} ${r.text.slice(0, 120)}`);
  }

  throw new Error('MetaApi non raggiungibile. Dettaglio tentativi: ' + errors.join(' | '));
}

function groupDealsIntoTrades(deals: any[]): any[] {
  const byPos: Record<string, any> = {};
  for (const d of deals) {
    const pid = d.positionId || d._id;
    if (!pid) continue;
    const isIn = (d.entryType || '').toUpperCase().includes('IN');
    const isOut = (d.entryType || '').toUpperCase().includes('OUT');
    if (!byPos[pid]) byPos[pid] = { positionId: pid, symbol: d.symbol, volume: d.volume, profit: 0 };
    const p = byPos[pid];
    if (isIn) {
      p.type = d.type || p.type;
      p.openTime = d.time || p.openTime;
      p.openPrice = d.price ?? p.openPrice;
      p.volume = d.volume || p.volume;
      p.orderId = d.orderId || p.orderId;
    }
    if (isOut) {
      p.closeTime = d.time || p.closeTime;
      p.closePrice = d.price ?? p.closePrice;
    }
    if (typeof d.profit === 'number') p.profit += d.profit;
    if (typeof d.commission === 'number') p.commission = (p.commission || 0) + d.commission;
    if (typeof d.swap === 'number') p.swap = (p.swap || 0) + d.swap;
  }
  return Object.values(byPos).filter((t: any) => t.openTime);
}

function mapMetaStatsTrade(mt: any, tradeId: string, clientId: string, abbonamentoId: string) {
  const typeRaw = (mt.type || '').toString().toUpperCase();
  const direction = typeRaw.includes('BUY') ? 'buy' : typeRaw.includes('SELL') ? 'sell' : 'buy';
  return {
    trade_id: tradeId, abbonamento_id: abbonamentoId, client_id: clientId,
    symbol: mt.symbol || 'XAUUSD', direction,
    volume: parseFloat(mt.volume ?? mt.lots ?? 0) || 0,
    open_time: mt.openTime || mt.open_time,
    close_time: mt.closeTime || mt.close_time || null,
    open_price: parseFloat(mt.openPrice ?? mt.open_price ?? 0) || 0,
    close_price: mt.closePrice != null ? parseFloat(mt.closePrice) : (mt.close_price != null ? parseFloat(mt.close_price) : null),
    profit: mt.profit != null ? parseFloat(mt.profit) : null,
    metaapi_position_id: mt.positionId || mt._id || null,
    metaapi_order_id: mt.orderId || null,
    account_type: 'broker', synced_from_metaapi: true,
  };
}

function calcolaEconomicsOpzioneA(esito: string, pnlLordoBroker: number): { lordo: number, costo: number, netto: number } {
  if (esito === 'profit') {
    const lordo = pnlLordoBroker;
    const costo = COSTO_CHALLENGE_BRUCIATA;
    const netto = lordo - costo;
    return { lordo, costo, netto };
  }
  if (esito === 'scenarioB') {
    return { lordo: pnlLordoBroker, costo: 0, netto: pnlLordoBroker };
  }
  return { lordo: pnlLordoBroker, costo: 0, netto: pnlLordoBroker };
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
  const tradeId = parts.length >= 2 && parts[0] === 'trades' ? parts[1] : null;
  const action = parts.length >= 3 ? parts[2] : null;
  const opId = parts.length >= 4 ? parts[3] : null;

  if (req.method === 'GET' && !tradeId) {
    const abbonamentoId = url.searchParams.get('abbonamentoId');
    const clientId = url.searchParams.get('clientId');
    if (!abbonamentoId && !clientId) return json({ error: 'abbonamentoId o clientId obbligatorio' }, 400);

    if (payload.role === 'client') {
      if (clientId && payload.clientId !== clientId) return json({ error: 'Non autorizzato' }, 403);
      if (abbonamentoId) {
        const { data: abb } = await sb.from('abbonamenti').select('client_id').eq('id', abbonamentoId).single();
        if (!abb || abb.client_id !== payload.clientId) return json({ error: 'Non autorizzato' }, 403);
      }
    }

    const limit = parseInt(url.searchParams.get('limit') ?? '100');
    let q: any = sb.from('trades').select('*, trade_operations(count)').order('trade_date', { ascending: false }).limit(limit);
    if (abbonamentoId) q = q.eq('abbonamento_id', abbonamentoId);
    else if (clientId) q = q.eq('client_id', clientId);
    const { data } = await q;
    const trades = (data ?? []).map((t: any) => ({
      ...t,
      ops_count: Array.isArray(t.trade_operations) && t.trade_operations[0] ? (t.trade_operations[0].count ?? 0) : 0,
      trade_operations: undefined,
    }));
    return json({ trades });
  }

  if (req.method === 'GET' && tradeId === 'broker-live') {
    const abbonamentoId = url.searchParams.get('abbonamentoId');
    if (!abbonamentoId) return json({ error: 'abbonamentoId obbligatorio' }, 400);
    const { data: abb } = await sb.from('abbonamenti').select('client_id, metaapi_id').eq('id', abbonamentoId).single();
    if (!abb) return json({ error: 'Abbonamento non trovato' }, 404);
    if (payload.role === 'client' && payload.clientId !== abb.client_id) return json({ error: 'Non autorizzato' }, 403);
    if (!abb.metaapi_id) return json({ error: 'L\'abbonamento non ha un account MetaApi configurato' }, 400);

    const today = new Date();
    const fromDate = url.searchParams.get('from') || new Date(today.getTime() - 7 * 24 * 3600 * 1000).toISOString().split('T')[0];
    const toDate = url.searchParams.get('to') || today.toISOString().split('T')[0];
    const startTime = fromDate + 'T00:00:00.000Z';
    const endTime = toDate + 'T23:59:59.999Z';

    let metaTrades: any[] = [];
    try { metaTrades = await fetchMetaApiTrades(abb.metaapi_id, startTime, endTime); }
    catch (err: any) { return json({ error: err.message }, 502); }

    const trades = metaTrades.map((mt: any) => {
      const typeRaw = (mt.type || '').toString().toUpperCase();
      return {
        id: mt.positionId || mt._id,
        symbol: mt.symbol || 'XAUUSD',
        direction: typeRaw.includes('BUY') ? 'buy' : 'sell',
        volume: parseFloat(mt.volume ?? mt.lots ?? 0) || 0,
        open_time: mt.openTime || mt.open_time,
        close_time: mt.closeTime || mt.close_time || null,
        open_price: parseFloat(mt.openPrice ?? mt.open_price ?? 0) || 0,
        close_price: mt.closePrice != null ? parseFloat(mt.closePrice) : (mt.close_price != null ? parseFloat(mt.close_price) : null),
        profit: mt.profit != null ? parseFloat(mt.profit) : null,
        commission: mt.commission != null ? parseFloat(mt.commission) : null,
        swap: mt.swap != null ? parseFloat(mt.swap) : null,
      };
    });

    return json({ trades, metaapi_account_id: abb.metaapi_id, from: fromDate, to: toDate, count: trades.length });
  }

  if (req.method === 'POST' && !tradeId) {
    if (!['admin', 'operator'].includes(payload.role)) return json({ error: 'Non autorizzato' }, 403);
    const body = await req.json();
    const { abbonamento_id, trade_date, giorno, esito, challenge, profitto_broker_lordo, note, metaapi_order_id } = body;
    if (!abbonamento_id || !giorno || !esito) return json({ error: 'abbonamento_id, giorno ed esito obbligatori' }, 400);

    const { data: abb } = await sb.from('abbonamenti').select('id, client_id, giorno_ciclo').eq('id', abbonamento_id).single();
    if (!abb) return json({ error: 'Abbonamento non trovato' }, 404);

    const lordo = Number(profitto_broker_lordo ?? 0);
    const economics = calcolaEconomicsOpzioneA(esito, lordo);
    const dataTrade = trade_date ?? new Date().toISOString().split('T')[0];
    const { data: trade, error } = await sb.from('trades').insert({
      abbonamento_id, client_id: abb.client_id,
      trade_date: dataTrade, data: dataTrade,
      giorno, esito,
      challenge: challenge ?? (esito === 'profit' ? 'Bruciata' : 'Vinta'),
      profitto_broker_lordo: economics.lordo,
      costo_challenge_prop: economics.costo,
      profitto_netto_cliente: economics.netto,
      risultato: economics.netto,
      note, metaapi_order_id,
    }).select().single();
    if (error) return json({ error: error.message }, 400);

    const nuovoGiorno = esito === 'profit' ? 1 : Math.min(giorno + 1, 4);
    await sb.from('abbonamenti').update({ giorno_ciclo: nuovoGiorno, ultimo_ciclo: new Date().toISOString() }).eq('id', abbonamento_id);

    if (esito === 'scenarioB' && giorno === 4) {
      const { data: cfg } = await sb.from('strategy_config').select('loss_cumul').eq('giorno', 4).single();
      await sb.from('rimborsi').insert({
        client_id: abb.client_id, abbonamento_id,
        importo: (cfg as any)?.loss_cumul ?? 5859,
        stato: 'da_pagare',
        note: `Auto da trade ${(trade as any).id}`,
      });
    }

    return json(trade, 201);
  }

  if (req.method === 'GET' && tradeId && action === 'operations') {
    const check = await canAccessTrade(sb, payload, tradeId);
    if (!check.ok) return json({ error: check.err }, 403);
    const { data } = await sb.from('trade_operations').select('*').eq('trade_id', tradeId).order('open_time', { ascending: true });
    return json({ operations: data ?? [], trade: check.trade });
  }

  if (req.method === 'POST' && tradeId && action === 'operations') {
    if (!['admin', 'operator'].includes(payload.role)) return json({ error: 'Non autorizzato' }, 403);
    const check = await canAccessTrade(sb, payload, tradeId);
    if (!check.ok) return json({ error: check.err }, 403);
    const body = await req.json();
    const { symbol, direction, volume, open_time, close_time, open_price, close_price, profit, note, account_type } = body;
    if (!symbol || !direction || volume == null || !open_time || open_price == null) {
      return json({ error: 'Campi obbligatori: symbol, direction, volume, open_time, open_price' }, 400);
    }
    if (!['buy', 'sell'].includes(direction)) return json({ error: 'direction deve essere buy o sell' }, 400);
    const { data, error } = await sb.from('trade_operations').insert({
      trade_id: tradeId, abbonamento_id: check.trade.abbonamento_id, client_id: check.trade.client_id,
      symbol, direction, volume,
      open_time, close_time: close_time || null,
      open_price, close_price: close_price ?? null,
      profit: profit ?? null, note: note || null,
      account_type: account_type || 'broker',
      synced_from_metaapi: false,
    }).select().single();
    if (error) return json({ error: error.message }, 400);
    return json({ operation: data }, 201);
  }

  if (req.method === 'DELETE' && tradeId && action === 'operations' && opId) {
    if (!['admin', 'operator'].includes(payload.role)) return json({ error: 'Non autorizzato' }, 403);
    const check = await canAccessTrade(sb, payload, tradeId);
    if (!check.ok) return json({ error: check.err }, 403);
    const { error } = await sb.from('trade_operations').delete().eq('id', opId).eq('trade_id', tradeId);
    if (error) return json({ error: error.message }, 400);
    return json({ message: 'Operazione eliminata' });
  }

  if (req.method === 'POST' && tradeId && action === 'sync-metaapi') {
    if (!['admin', 'operator'].includes(payload.role)) return json({ error: 'Non autorizzato' }, 403);
    const check = await canAccessTrade(sb, payload, tradeId);
    if (!check.ok) return json({ error: check.err }, 403);

    const { data: abb } = await sb.from('abbonamenti').select('metaapi_id').eq('id', check.trade.abbonamento_id).single();
    const metaapiAccountId = abb?.metaapi_id;
    if (!metaapiAccountId) return json({ error: 'Questo abbonamento non ha un account MetaApi configurato' }, 400);

    const tradeDate = check.trade.trade_date;
    const startTime = tradeDate + 'T00:00:00.000Z';
    const endTime = tradeDate + 'T23:59:59.999Z';

    let metaTrades: any[] = [];
    try { metaTrades = await fetchMetaApiTrades(metaapiAccountId, startTime, endTime); }
    catch (err: any) { return json({ error: err.message }, 502); }

    if (metaTrades.length === 0) {
      return json({ message: 'Nessuna operazione MetaApi trovata per la data ' + tradeDate, imported: 0 });
    }

    const rows = metaTrades.map(mt => mapMetaStatsTrade(mt, tradeId, check.trade.client_id, check.trade.abbonamento_id)).filter(r => r.metaapi_position_id);

    let imported = 0;
    const errors: string[] = [];
    for (const row of rows) {
      const { error } = await sb.from('trade_operations').upsert(row, { onConflict: 'trade_id,metaapi_position_id' });
      if (error) errors.push(error.message);
      else imported++;
    }

    await sb.from('metaapi_sync_log').insert({
      abbonamento_id: check.trade.abbonamento_id,
      trades_count: imported,
      status: errors.length ? 'partial' : 'ok',
      error_msg: errors.length ? errors.join('; ').slice(0, 500) : null,
    });

    return json({ message: `Importate ${imported} operazioni dal broker`, imported, total_found: metaTrades.length, errors });
  }

  if (req.method === 'POST' && tradeId === 'bulk-import-metaapi') {
    if (!['admin', 'operator'].includes(payload.role)) return json({ error: 'Non autorizzato' }, 403);
    const body = await req.json();
    const { abbonamentoId, from, to } = body;
    if (!abbonamentoId || !from || !to) return json({ error: 'abbonamentoId, from e to obbligatori' }, 400);

    const { data: abb } = await sb.from('abbonamenti').select('id, client_id, metaapi_id').eq('id', abbonamentoId).single();
    if (!abb) return json({ error: 'Abbonamento non trovato' }, 404);
    if (!abb.metaapi_id) return json({ error: 'L\'abbonamento non ha un account MetaApi configurato' }, 400);
    const clientId = abb.client_id;

    const startTime = from + 'T00:00:00.000Z';
    const endTime = to + 'T23:59:59.999Z';

    let metaTrades: any[] = [];
    try { metaTrades = await fetchMetaApiTrades(abb.metaapi_id, startTime, endTime); }
    catch (err: any) { return json({ error: err.message }, 502); }

    if (metaTrades.length === 0) {
      return json({ message: `Nessuna operazione MetaApi nel range ${from} → ${to}`, challenges_created: 0, operations_imported: 0, rimborsi_created: 0 });
    }

    await sb.from('trades').delete().eq('abbonamento_id', abbonamentoId).gte('trade_date', from).lte('trade_date', to).ilike('note', '%auto%');
    await sb.from('rimborsi').delete().eq('abbonamento_id', abbonamentoId).gte('data_rimborso', from).lte('data_rimborso', to).ilike('note', '%auto%');

    const byDate: Record<string, any[]> = {};
    for (const mt of metaTrades) {
      const ot = mt.openTime || mt.open_time;
      if (!ot) continue;
      const d = new Date(ot).toISOString().split('T')[0];
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(mt);
    }
    const sortedDates = Object.keys(byDate).sort();

    const cfgR = await sb.from('strategy_config').select('loss_cumul').eq('giorno', 4).single();
    const refundAmount = (cfgR.data as any)?.loss_cumul ?? 5859;

    let pendingGiorno = 1;
    let cycleOps: any[] = [];
    let challengesCreated = 0;
    let operationsImported = 0;
    let rimborsiCreated = 0;
    let intermediateDays = 0;
    const errors: string[] = [];

    async function finalizeCycle(date: string, giorno: number, isScenarioB: boolean, pnlLordo: number, ops: any[]) {
      const economics = calcolaEconomicsOpzioneA(isScenarioB ? 'scenarioB' : 'profit', pnlLordo);
      const tradeData: any = {
        abbonamento_id: abbonamentoId, client_id: clientId,
        trade_date: date, data: date, giorno,
        esito: isScenarioB ? 'scenarioB' : 'profit',
        challenge: isScenarioB ? 'Vinta' : 'Bruciata',
        profitto_broker_lordo: Math.round(economics.lordo * 100) / 100,
        costo_challenge_prop: economics.costo,
        profitto_netto_cliente: Math.round(economics.netto * 100) / 100,
        risultato: Math.round(economics.netto * 100) / 100,
        note: isScenarioB ? 'Auto-import Scenario B (garanzia attivata al giorno 4)' : `Auto-import challenge bruciata al giorno ${giorno}`,
      };
      const newR = await sb.from('trades').insert(tradeData).select('id').single();
      if (newR.error) { errors.push(`Trade ${date}: ${newR.error.message}`); return; }
      const tradeIdForDay = newR.data.id;
      challengesCreated++;

      const rows = ops.map(mt => mapMetaStatsTrade(mt, tradeIdForDay, clientId, abbonamentoId)).filter(r => r.metaapi_position_id);
      for (const row of rows) {
        const { error } = await sb.from('trade_operations').upsert(row, { onConflict: 'trade_id,metaapi_position_id' });
        if (error) errors.push(`Op ${date}: ${error.message}`);
        else operationsImported++;
      }

      if (isScenarioB) {
        const refundR = await sb.from('rimborsi').insert({
          client_id: clientId, abbonamento_id: abbonamentoId,
          importo: refundAmount, data_rimborso: date, stato: 'pagato',
          note: `Auto-import da trade ${tradeIdForDay}`,
        });
        if (!refundR.error) rimborsiCreated++;
        else errors.push(`Rimborso ${date}: ${refundR.error.message}`);
      }
    }

    for (const date of sortedDates) {
      const dayOps = byDate[date];
      const dayPnl = dayOps.reduce((s, t) => s + (t.profit || 0) + (t.commission || 0) + (t.swap || 0), 0);
      const isProfit = dayPnl >= 0;
      cycleOps.push(...dayOps);
      if (isProfit) {
        await finalizeCycle(date, pendingGiorno, false, dayPnl, cycleOps);
        pendingGiorno = 1;
        cycleOps = [];
      } else if (pendingGiorno === 4) {
        await finalizeCycle(date, 4, true, dayPnl, cycleOps);
        pendingGiorno = 1;
        cycleOps = [];
      } else {
        pendingGiorno++;
        intermediateDays++;
      }
    }

    if (pendingGiorno > 1) {
      await sb.from('abbonamenti').update({ giorno_ciclo: pendingGiorno, ultimo_ciclo: new Date().toISOString() }).eq('id', abbonamentoId);
    }

    await sb.from('metaapi_sync_log').insert({
      abbonamento_id: abbonamentoId,
      trades_count: operationsImported,
      status: errors.length ? 'partial' : 'ok',
      error_msg: errors.length ? errors.join('; ').slice(0, 500) : null,
    });

    return json({
      message: `${challengesCreated} challenge chiuse, ${rimborsiCreated} rimborsi, ${operationsImported} operazioni importate. ${intermediateDays} giorni intermedi (ciclo non chiuso).`,
      challenges_created: challengesCreated,
      operations_imported: operationsImported,
      rimborsi_created: rimborsiCreated,
      intermediate_days: intermediateDays,
      open_cycle_day: pendingGiorno > 1 ? pendingGiorno : null,
      days_processed: sortedDates.length,
      errors,
    });
  }

  // ── ADMIN: WIPE TEST DATA ────────────────────────────────────────────────
  // Cancella tutti i dati di test (trades, trade_operations, rimborsi, metaapi_sync_log)
  // e azzera credenziali MT5 + ciclo su tutti gli abbonamenti.
  // PRESERVA: clients, abbonamenti (struttura), users, strategy_config.
  // Richiede payload.role === 'admin' e body.confirm === 'RESET-ALL-DATA'.
  if (req.method === 'POST' && tradeId === 'admin-wipe-test-data') {
    if (payload.role !== 'admin') return json({ error: 'Solo admin può eseguire wipe' }, 403);
    let body: any = {};
    try { body = await req.json(); } catch {}
    if (body?.confirm !== 'RESET-ALL-DATA') {
      return json({ error: 'Conferma mancante o non valida (atteso confirm="RESET-ALL-DATA")' }, 400);
    }

    const results: Record<string, any> = {};
    const errors: string[] = [];

    // 1) trade_operations (FK -> trades, abbonamenti, clients)
    const r1 = await sb.from('trade_operations').delete({ count: 'exact' }).not('id', 'is', null);
    if (r1.error) errors.push('trade_operations: ' + r1.error.message);
    else results.trade_operations_deleted = r1.count ?? 0;

    // 2) rimborsi
    const r2 = await sb.from('rimborsi').delete({ count: 'exact' }).not('id', 'is', null);
    if (r2.error) errors.push('rimborsi: ' + r2.error.message);
    else results.rimborsi_deleted = r2.count ?? 0;

    // 3) trades
    const r3 = await sb.from('trades').delete({ count: 'exact' }).not('id', 'is', null);
    if (r3.error) errors.push('trades: ' + r3.error.message);
    else results.trades_deleted = r3.count ?? 0;

    // 4) metaapi_sync_log
    const r4 = await sb.from('metaapi_sync_log').delete({ count: 'exact' }).not('id', 'is', null);
    if (r4.error) errors.push('metaapi_sync_log: ' + r4.error.message);
    else results.sync_log_deleted = r4.count ?? 0;

    // 5) abbonamenti: clear MT5 + reset ciclo
    const r5 = await sb.from('abbonamenti').update({
      mt5_server: null,
      mt5_account: null,
      mt5_pwd: null,
      metaapi_id: null,
      giorno_ciclo: 1,
      ultimo_ciclo: null,
    }, { count: 'exact' }).not('id', 'is', null);
    if (r5.error) errors.push('abbonamenti reset: ' + r5.error.message);
    else results.abbonamenti_reset = r5.count ?? 0;

    return json({
      message: errors.length
        ? 'Wipe parziale (vedi errors)'
        : 'Wipe completato: stato zero ripristinato',
      ...results,
      errors,
      preserved: ['clients', 'abbonamenti (struttura)', 'users', 'strategy_config'],
    }, errors.length ? 207 : 200);
  }

  return json({ error: 'Metodo non supportato' }, 405);
});
