// Edge function: checkout-receipt
// Chiamata dal webhook OxaPay (Netlify) quando lo stato diventa "Paid".
// 1) Carica l'ordine da checkout_orders
// 2) Genera la ricevuta PDF su carta intestata PROXIMA FUNDED LLC-FZ (pdf-lib)
// 3) Invia l'email brandizzata Proxima (formato ufficiale) con PDF allegato via Resend
// 4) Marca l'ordine come pagato (idempotente: non reinvia se email_sent_at valorizzato)
// Env: CHECKOUT_LINK_SECRET (auth interna), RESEND_API_KEY,
//      RESEND_FROM_PROXIMA (default 'Proxima Funded <noreply@loop-online.com>'),
//      DASHBOARD_URL (default dashboard clienti)

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const LINK_SECRET = Deno.env.get('CHECKOUT_LINK_SECRET') ?? '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const RESEND_FROM = Deno.env.get('RESEND_FROM_PROXIMA') ?? 'Proxima Funded <noreply@loop-online.com>';
// ZeptoMail (dominio proximafunded.com verificato): se ZEPTOMAIL_TOKEN e' impostato
// l'email parte da noreply@proximafunded.com, altrimenti fallback su Resend.
// Il token copiato dal pannello a volte include gia' il prefisso "Zoho-enczapikey": lo normalizziamo.
const ZEPTO_TOKEN = (Deno.env.get('ZEPTOMAIL_TOKEN') ?? '').trim().replace(/^Zoho-enczapikey\s+/i, '');
const ZEPTO_HOST = Deno.env.get('ZEPTOMAIL_HOST') ?? 'api.zeptomail.eu';
const ZEPTO_FROM_ADDR = Deno.env.get('ZEPTOMAIL_FROM') ?? 'noreply@proximafunded.com';
const ZEPTO_FROM_NAME = 'Proxima Funded';
const DASHBOARD_URL = Deno.env.get('DASHBOARD_URL') ?? 'https://loop-dashboard-clienti-v2.netlify.app';
const LOGO_URL = Deno.env.get('PROXIMA_LOGO_URL') ?? `${SUPABASE_URL}/storage/v1/object/public/assets/proxima-logo-full.png`;


// Logo ufficiale (fetch dallo Storage Supabase, cache in modulo). Sfondo navy #162733.
let LOGO_BYTES: Uint8Array | null = null;
async function getLogoBytes(): Promise<Uint8Array | null> {
  if (LOGO_BYTES) return LOGO_BYTES;
  try {
    const r = await fetch(LOGO_URL);
    if (!r.ok) return null;
    LOGO_BYTES = new Uint8Array(await r.arrayBuffer());
    return LOGO_BYTES;
  } catch { return null; }
}

// Dati aziendali (carta intestata ufficiale)
const CO_NAME = 'PROXIMA FUNDED LLC-FZ';
const CO_ADDR1 = 'Meydan Grandstand, 6th floor, Meydan Road,';
const CO_ADDR2 = 'Nad Al Sheba, Dubai, U.A.E.';
const CO_LIC = 'Licence Number 2542091.01';

const PRICES: Record<string, { label: string; price: number }> = {
  k50: { label: '50K Challenge — Proxima Funded', price: 250 },
  k100: { label: '100K Challenge — Proxima Funded', price: 500 },
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-internal-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const money = (n: number) => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// ── PDF ────────────────────────────────────────────────────────────────────
async function buildReceiptPdf(o: {
  receiptNo: string; date: string; name: string; email: string; phone: string;
  address: string; orderId: string; trackId: string;
  lines: Array<{ label: string; qty: number; unit: number; total: number }>;
  total: number;
}): Promise<string> {
  const NAVY = rgb(0x16 / 255, 0x27 / 255, 0x33 / 255); // #162733 (brand book)
  const GOLD = rgb(0xE8 / 255, 0xB5 / 255, 0x6C / 255);
  const GOLD_SOFT = rgb(0xF0 / 255, 0xCE / 255, 0xA4 / 255);
  const GRAY = rgb(0.42, 0.47, 0.53);
  const DARK = rgb(0.10, 0.14, 0.19);
  const GREEN = rgb(0.10, 0.62, 0.36);
  const LIGHT = rgb(0.93, 0.94, 0.95);

  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4
  const W = 595.28, H = 841.89;
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);

  const spaced = (t: string, gap = ' ') => t.split('').join(gap);
  const rightX = (t: string, f: any, s: number, right: number) => right - f.widthOfTextAtSize(t, s);

  // Header band navy con logo ufficiale in alto a sx
  const BAND_H = 150;
  page.drawRectangle({ x: 0, y: H - BAND_H, width: W, height: BAND_H, color: NAVY });
  const logoBytes = await getLogoBytes();
  let logoImg: any = null;
  if (logoBytes) {
    try { logoImg = await doc.embedPng(logoBytes); }
    catch { try { logoImg = await doc.embedJpg(logoBytes); } catch { logoImg = null; } }
  }
  if (logoImg) {
    const lh = 124;
    const lw = logoImg.width / logoImg.height * lh;
    page.drawImage(logoImg, { x: 48, y: H - BAND_H + (BAND_H - lh) / 2, width: lw, height: lh });
  } else {
    // Fallback testuale se il logo non è raggiungibile
    page.drawText(spaced('PROXIMA'), { x: 50, y: H - 72, size: 25, font: bold, color: rgb(1, 1, 1) });
    page.drawText(spaced('FUNDED', '  '), { x: 52, y: H - 92, size: 10.5, font: reg, color: GOLD });
  }
  const t1 = 'PAYMENT RECEIPT';
  page.drawText(t1, { x: rightX(t1, bold, 15, 545), y: H - 66, size: 15, font: bold, color: GOLD_SOFT });
  const t2 = `Receipt No. ${o.receiptNo}`;
  page.drawText(t2, { x: rightX(t2, reg, 9.5, 545), y: H - 84, size: 9.5, font: reg, color: rgb(1, 1, 1) });
  const t3 = o.date;
  page.drawText(t3, { x: rightX(t3, reg, 9.5, 545), y: H - 98, size: 9.5, font: reg, color: rgb(0.78, 0.82, 0.87) });

  // Dati societa in alto a sx (sotto la fascia)
  let y = H - 178;
  page.drawText(CO_NAME, { x: 50, y, size: 10, font: bold, color: DARK }); y -= 13;
  page.drawText(CO_ADDR1, { x: 50, y, size: 9, font: reg, color: GRAY }); y -= 12;
  page.drawText(CO_ADDR2, { x: 50, y, size: 9, font: reg, color: GRAY }); y -= 12;
  page.drawText(CO_LIC, { x: 50, y, size: 9, font: reg, color: GRAY });

  // Billed to (colonna destra)
  let yb = H - 178;
  page.drawText('BILLED TO', { x: 340, y: yb, size: 8.5, font: bold, color: GOLD }); yb -= 14;
  page.drawText(o.name || '-', { x: 340, y: yb, size: 10.5, font: bold, color: DARK }); yb -= 13;
  page.drawText(o.email || '-', { x: 340, y: yb, size: 9, font: reg, color: GRAY }); yb -= 12;
  if (o.phone) { page.drawText(o.phone, { x: 340, y: yb, size: 9, font: reg, color: GRAY }); yb -= 12; }
  if (o.address) {
    // wrap semplice a ~40 caratteri
    const words = o.address.split(' ');
    let line = '';
    for (const w2 of words) {
      if ((line + ' ' + w2).trim().length > 40) {
        page.drawText(line.trim(), { x: 340, y: yb, size: 9, font: reg, color: GRAY }); yb -= 12; line = w2;
      } else line += ' ' + w2;
    }
    if (line.trim()) { page.drawText(line.trim(), { x: 340, y: yb, size: 9, font: reg, color: GRAY }); yb -= 12; }
  }

  // Tabella
  let ty = H - 300;
  page.drawRectangle({ x: 50, y: ty, width: 495, height: 26, color: NAVY });
  page.drawText('DESCRIPTION', { x: 60, y: ty + 8.5, size: 9, font: bold, color: rgb(1, 1, 1) });
  page.drawText('QTY', { x: 358, y: ty + 8.5, size: 9, font: bold, color: rgb(1, 1, 1) });
  page.drawText('UNIT PRICE', { x: rightX('UNIT PRICE', bold, 9, 465), y: ty + 8.5, size: 9, font: bold, color: rgb(1, 1, 1) });
  page.drawText('TOTAL', { x: rightX('TOTAL', bold, 9, 535), y: ty + 8.5, size: 9, font: bold, color: rgb(1, 1, 1) });
  ty -= 28;
  for (const ln of o.lines) {
    page.drawText(ln.label, { x: 60, y: ty, size: 10, font: reg, color: DARK });
    page.drawText(String(ln.qty), { x: 362, y: ty, size: 10, font: reg, color: DARK });
    const u = `$${money(ln.unit)}`;
    page.drawText(u, { x: rightX(u, reg, 10, 465), y: ty, size: 10, font: reg, color: DARK });
    const tt = `$${money(ln.total)}`;
    page.drawText(tt, { x: rightX(tt, bold, 10, 535), y: ty, size: 10, font: bold, color: DARK });
    ty -= 8;
    page.drawLine({ start: { x: 50, y: ty }, end: { x: 545, y: ty }, thickness: 0.7, color: LIGHT });
    ty -= 18;
  }

  // Totale
  ty -= 4;
  page.drawRectangle({ x: 50, y: ty - 9, width: 495, height: 32, color: rgb(0.97, 0.93, 0.86) });
  page.drawText('TOTAL PAID', { x: 60, y: ty, size: 11, font: bold, color: NAVY });
  const tot = `$${money(o.total)} USD`;
  page.drawText(tot, { x: rightX(tot, bold, 13, 535), y: ty - 1, size: 13, font: bold, color: NAVY });

  // Dettagli pagamento
  ty -= 44;
  page.drawText('PAYMENT DETAILS', { x: 50, y: ty, size: 8.5, font: bold, color: GOLD }); ty -= 15;
  page.drawText('Method: Cryptocurrency — processed by OxaPay', { x: 50, y: ty, size: 9, font: reg, color: GRAY }); ty -= 12;
  page.drawText(`Order ID: ${o.orderId}`, { x: 50, y: ty, size: 9, font: reg, color: GRAY }); ty -= 12;
  if (o.trackId) { page.drawText(`Track ID: ${o.trackId}`, { x: 50, y: ty, size: 9, font: reg, color: GRAY }); ty -= 12; }
  page.drawText('Status: PAID', { x: 50, y: ty, size: 9.5, font: bold, color: GREEN });

  // Footer band (come carta intestata)
  page.drawRectangle({ x: 0, y: 0, width: W, height: 62, color: NAVY });
  const f1 = CO_NAME, f2 = `${CO_ADDR1} ${CO_ADDR2}`, f3 = CO_LIC;
  page.drawText(f1, { x: (W - bold.widthOfTextAtSize(f1, 9)) / 2, y: 40, size: 9, font: bold, color: GOLD_SOFT });
  page.drawText(f2, { x: (W - reg.widthOfTextAtSize(f2, 8.5)) / 2, y: 27, size: 8.5, font: reg, color: GOLD_SOFT });
  page.drawText(f3, { x: (W - reg.widthOfTextAtSize(f3, 8.5)) / 2, y: 14, size: 8.5, font: reg, color: GOLD_SOFT });

  return await doc.saveAsBase64();
}

// ── Email (formato ufficiale Proxima Funded) ───────────────────────────────
function buildEmailHtml(p: {
  firstName: string; receiptNo: string; date: string; orderId: string; trackId: string;
  lines: Array<{ label: string; qty: number; total: number }>; total: number; dashboardUrl: string;
}): string {
  const rows = p.lines.map((l) => `
    <tr>
      <td style="padding:11px 0;font-family:'Montserrat',Arial,sans-serif;font-size:13px;color:rgba(220,228,240,0.85);border-bottom:1px solid rgba(232,181,108,0.14)">${l.qty}x ${l.label}</td>
      <td align="right" style="padding:11px 0;font-family:'Montserrat',Arial,sans-serif;font-size:13px;font-weight:700;color:#F0CEA4;border-bottom:1px solid rgba(232,181,108,0.14)">$${money(l.total)}</td>
    </tr>`).join('');
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" lang="en">
  <head>
    <meta content="width=device-width" name="viewport" />
    <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta content="IE=edge" http-equiv="X-UA-Compatible" />
    <meta content="telephone=no,address=no,email=no,date=no,url=no" name="format-detection" />
  </head>
  <body dir="ltr" lang="en" style="background-color:#0a0f16;margin:0;padding:0">
    <table border="0" width="100%" cellpadding="0" cellspacing="0" role="presentation" align="center" style="background-color:#0a0f16">
      <tbody>
        <tr>
          <td align="center" style="padding:36px 16px">
            <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;background-color:#121B26;border-radius:18px;overflow:hidden;box-shadow:0 0 60px rgba(232,181,108,0.10), 0 4px 40px rgba(0,0,0,0.6)">
              <tbody>
                <tr>
                  <td align="center" style="padding:38px 40px 30px 40px;background-color:#162733">
                    <p style="margin:0;padding:0;font-family:'Montserrat',Arial,sans-serif;font-size:30px;font-weight:800;color:#FFFFFF;letter-spacing:6px">PROXIMA</p>
                    <p style="margin:4px 0 0 0;padding:0;font-family:'Montserrat',Arial,sans-serif;font-size:12px;font-weight:500;color:#E8B56C;letter-spacing:9px">FUNDED</p>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:26px 40px;background:linear-gradient(100deg,#795A3E 0%,#E8B56C 45%,#F3DD9F 100%)">
                    <p style="margin:0 0 4px 0;padding:0;font-family:'Montserrat',Arial,sans-serif;font-size:11px;font-weight:700;color:#16232F;letter-spacing:3px">&#9989;&nbsp;&nbsp;PAYMENT RECEIVED</p>
                    <h1 style="margin:0;padding:0;font-family:'Montserrat',Arial,sans-serif;font-size:24px;font-weight:800;color:#16232F">Payment Receipt</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding:40px 40px 10px 40px">
                    <p style="margin:0 0 20px 0;font-family:'Montserrat',Arial,sans-serif;font-size:15px;color:#FFFFFF;line-height:1.6">Hi <strong style="color:#F0CEA4">${p.firstName}</strong>,</p>
                    <p style="margin:0 0 26px 0;font-family:'Montserrat',Arial,sans-serif;font-size:14px;color:rgba(220,228,240,0.85);line-height:1.8">Payment received! Your challenge is ready and has been loaded into the <strong style="color:#F0CEA4">Loop System</strong> to start a new cycle. Your official receipt is attached to this email as a PDF.</p>
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#182633;border:1px solid rgba(232,181,108,0.22);border-radius:12px;margin:0 0 18px 0">
                      <tbody>
                        <tr><td style="padding:20px 24px 6px 24px">
                          <p style="margin:0 0 6px 0;font-family:'Montserrat',Arial,sans-serif;font-size:10px;font-weight:700;color:#E8B56C;letter-spacing:2px">&#128203;&nbsp;ORDER SUMMARY</p>
                          <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                            <tbody>
                              ${rows}
                              <tr>
                                <td style="padding:14px 0 16px 0;font-family:'Montserrat',Arial,sans-serif;font-size:14px;font-weight:800;color:#FFFFFF">Total paid</td>
                                <td align="right" style="padding:14px 0 16px 0;font-family:'Montserrat',Arial,sans-serif;font-size:20px;font-weight:900;color:#F3DD9F">$${money(p.total)} <span style="font-size:11px;font-weight:600;color:rgba(220,228,240,0.6)">USD</span></td>
                              </tr>
                            </tbody>
                          </table>
                        </td></tr>
                      </tbody>
                    </table>
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#182633;border:1px solid rgba(232,181,108,0.22);border-radius:12px;margin:0 0 8px 0">
                      <tbody>
                        <tr><td style="padding:20px 24px 18px 24px">
                          <p style="margin:0 0 10px 0;font-family:'Montserrat',Arial,sans-serif;font-size:10px;font-weight:700;color:#E8B56C;letter-spacing:2px">&#128179;&nbsp;PAYMENT DETAILS</p>
                          <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                            <tbody>
                              <tr><td style="padding:6px 0;font-family:'Montserrat',Arial,sans-serif;font-size:12.5px;color:rgba(220,228,240,0.6)">Receipt No.</td><td align="right" style="padding:6px 0;font-family:'Montserrat',Arial,sans-serif;font-size:12.5px;font-weight:700;color:#FFFFFF">${p.receiptNo}</td></tr>
                              <tr><td style="padding:6px 0;font-family:'Montserrat',Arial,sans-serif;font-size:12.5px;color:rgba(220,228,240,0.6)">Date</td><td align="right" style="padding:6px 0;font-family:'Montserrat',Arial,sans-serif;font-size:12.5px;font-weight:700;color:#FFFFFF">${p.date}</td></tr>
                              <tr><td style="padding:6px 0;font-family:'Montserrat',Arial,sans-serif;font-size:12.5px;color:rgba(220,228,240,0.6)">Order ID</td><td align="right" style="padding:6px 0;font-family:'Montserrat',Arial,sans-serif;font-size:11.5px;font-weight:700;color:#F0CEA4">${p.orderId}</td></tr>
                              ${p.trackId ? `<tr><td style="padding:6px 0;font-family:'Montserrat',Arial,sans-serif;font-size:12.5px;color:rgba(220,228,240,0.6)">Track ID</td><td align="right" style="padding:6px 0;font-family:'Montserrat',Arial,sans-serif;font-size:12.5px;font-weight:700;color:#FFFFFF">${p.trackId}</td></tr>` : ''}
                              <tr><td style="padding:6px 0;font-family:'Montserrat',Arial,sans-serif;font-size:12.5px;color:rgba(220,228,240,0.6)">Method</td><td align="right" style="padding:6px 0;font-family:'Montserrat',Arial,sans-serif;font-size:12.5px;font-weight:700;color:#FFFFFF">Cryptocurrency</td></tr>
                              <tr><td style="padding:6px 0;font-family:'Montserrat',Arial,sans-serif;font-size:12.5px;color:rgba(220,228,240,0.6)">Status</td><td align="right" style="padding:6px 0;font-family:'Montserrat',Arial,sans-serif;font-size:12.5px;font-weight:800;color:#34D399">PAID</td></tr>
                            </tbody>
                          </table>
                        </td></tr>
                      </tbody>
                    </table>
                    <p style="margin:30px 0 12px 0;padding:0;text-align:center">
                      <a href="${p.dashboardUrl}" style="display:inline-block;background:linear-gradient(135deg,#a37c4d 0%,#E8B56C 55%,#F3DD9F 130%);color:#16232F;font-family:'Montserrat',Arial,sans-serif;font-size:13px;font-weight:800;letter-spacing:2px;text-decoration:none;padding:15px 40px;border-radius:8px">VIEW DASHBOARD</a>
                    </p>
                    <p style="margin:8px 0 30px 0;font-family:'Montserrat',Arial,sans-serif;font-size:12px;color:rgba(220,228,240,0.45);line-height:1.7;text-align:center">Good luck with your trading! Remember to follow your risk management rules.</p>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:24px 40px 32px 40px;border-top:1px solid rgba(232,181,108,0.12)">
                    <p style="margin:0 0 6px 0;font-family:'Montserrat',Arial,sans-serif;font-size:10.5px;color:rgba(220,228,240,0.4)">&copy; 2026 Proxima Funded LLC-FZ. All rights reserved.</p>
                    <p style="margin:0;font-family:'Montserrat',Arial,sans-serif;font-size:9.5px;color:rgba(220,228,240,0.3)">${CO_ADDR1} ${CO_ADDR2} &mdash; ${CO_LIC}</p>
                  </td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table>
  </body>
</html>`;
}

function buildEmailText(p: { firstName: string; receiptNo: string; total: number; orderId: string; dashboardUrl: string }): string {
  return `Hi ${p.firstName},

Payment received! Your challenge is ready and has been loaded into the Loop System to start a new cycle.

Receipt No. ${p.receiptNo}
Order ID: ${p.orderId}
Total paid: $${money(p.total)} USD
Status: PAID

Your official receipt is attached as PDF.

Dashboard: ${p.dashboardUrl}

Proxima Funded LLC-FZ
${CO_ADDR1} ${CO_ADDR2}
${CO_LIC}`;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!LINK_SECRET) return json({ error: 'secret_missing' }, 500);

  const auth = req.headers.get('x-internal-secret');
  if (!auth || !safeEq(auth, LINK_SECRET)) return json({ error: 'unauthorized' }, 401);

  let b: any = {};
  try { b = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const orderId = b.order_id;
  if (!orderId) return json({ error: 'order_id_required' }, 400);

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: o, error } = await sb.from('checkout_orders').select('*').eq('order_id', orderId).single();
  if (error || !o) return json({ error: 'order_not_found' }, 404);
  if (o.email_sent_at) return json({ ok: true, already_sent: true, receipt_no: o.receipt_no });

  const receiptNo = o.receipt_no || `PF-${new Date().getFullYear()}-${String(o.receipt_seq).padStart(4, '0')}`;
  const dateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Europe/Rome' });
  const trackId = String(b.track_id ?? o.track_id ?? '');

  const items = (o.items || {}) as Record<string, number>;
  const lines: Array<{ label: string; qty: number; unit: number; total: number }> = [];
  for (const k of ['k50', 'k100']) {
    const q = Number(items[k]) || 0;
    if (q > 0) lines.push({ label: PRICES[k].label, qty: q, unit: PRICES[k].price, total: q * PRICES[k].price });
  }
  const total = Number(o.amount) || lines.reduce((s, l) => s + l.total, 0);
  const firstName = (o.name || '').split(' ')[0] || 'trader';

  // PDF
  let pdfB64 = '';
  try {
    pdfB64 = await buildReceiptPdf({
      receiptNo, date: dateStr, name: o.name || '', email: o.email || '', phone: o.phone || '',
      address: o.address || '', orderId, trackId, lines, total,
    });
  } catch (e: any) {
    return json({ error: 'pdf_failed', detail: e?.message || String(e) }, 500);
  }

  // Email con allegato: ZeptoMail (mittente proximafunded.com) se configurato, altrimenti Resend
  if (!o.email) return json({ error: 'client_email_missing' }, 400);
  const html = buildEmailHtml({ firstName, receiptNo, date: dateStr, orderId, trackId, lines, total, dashboardUrl: DASHBOARD_URL });
  const text = buildEmailText({ firstName, receiptNo, total, orderId, dashboardUrl: DASHBOARD_URL });
  const subject = `Payment Received — Receipt ${receiptNo} | Proxima Funded`;
  let mailId: string | undefined;
  let provider = 'resend';
  if (ZEPTO_TOKEN) {
    provider = 'zeptomail';
    try {
      const r = await fetch(`https://${ZEPTO_HOST}/v1.1/email`, {
        method: 'POST',
        headers: { 'Authorization': `Zoho-enczapikey ${ZEPTO_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: { address: ZEPTO_FROM_ADDR, name: ZEPTO_FROM_NAME },
          to: [{ email_address: { address: o.email, name: o.name || undefined } }],
          subject,
          htmlbody: html,
          textbody: text,
          attachments: [{ content: pdfB64, mime_type: 'application/pdf', name: `Receipt-${receiptNo}.pdf` }],
        }),
      });
      const raw = await r.text();
      let d: any = {};
      try { d = JSON.parse(raw); } catch { /* body non JSON */ }
      if (!r.ok) {
        const det = d?.error?.details?.[0]?.message || d?.error?.message || d?.message || raw.slice(0, 300);
        return json({ error: 'zeptomail_failed', status: r.status, host: ZEPTO_HOST, detail: det }, 502);
      }
      mailId = d?.request_id;
    } catch (e: any) {
      return json({ error: 'zeptomail_unreachable', detail: e?.message || String(e) }, 502);
    }
  } else {
    if (!RESEND_API_KEY) return json({ error: 'mail_not_configured' }, 500);
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: RESEND_FROM,
          to: [o.email],
          subject,
          html, text,
          attachments: [{ filename: `Receipt-${receiptNo}.pdf`, content: pdfB64 }],
        }),
      });
      const d = await r.json();
      if (!r.ok) return json({ error: 'resend_failed', detail: d?.message || `HTTP ${r.status}` }, 502);
      mailId = d?.id;
    } catch (e: any) {
      return json({ error: 'resend_unreachable', detail: e?.message || String(e) }, 502);
    }
  }

  const now = new Date().toISOString();
  await sb.from('checkout_orders').update({
    status: 'paid',
    receipt_no: receiptNo,
    track_id: trackId || o.track_id,
    paid_amount: b.paid_amount != null ? Number(b.paid_amount) : total,
    paid_currency: b.currency ?? 'USD',
    paid_at: now,
    email_sent_at: now,
  }).eq('order_id', orderId);

  return json({ ok: true, receipt_no: receiptNo, email_id: mailId, provider });
});
