/**
 * TSI Cosmetics — Cloudflare Worker Order Endpoint
 *
 * Environment variables (set as Worker Secrets in Cloudflare Dashboard):
 *   TELEGRAM_BOT_TOKEN   — bot token from @BotFather
 *   TELEGRAM_OWNER_CHAT_ID — your Telegram user/chat ID
 *   ALLOWED_ORIGIN       — your website origin, e.g. https://tsicosmetics.com
 *
 * Local development: copy .dev.vars.example to .dev.vars and fill in real values.
 * Never commit .dev.vars to Git.
 */

const MAX_BODY_BYTES   = 8_000;   // ~8 KB max request body
const MAX_ITEMS        = 20;      // max cart items per order
const MAX_QTY          = 99;      // max qty per item
const MAX_FIELD_LEN    = 500;     // max length for any text field
const MAX_NAME_LEN     = 120;
const MAX_PHONE_LEN    = 20;
const TG_MAX_MSG_LEN   = 4000;    // Telegram message char limit (safe buffer under 4096)

/* ------------------------------------------------------------------ */
/* CORS helper                                                          */
/* ------------------------------------------------------------------ */
function corsHeaders(origin, allowedOrigin) {
  // If no ALLOWED_ORIGIN configured, allow all (dev mode only — lock down in production)
  if (!allowedOrigin) {
    return {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age':       '86400',
    };
  }
  const acao = (origin && origin === allowedOrigin) ? origin : allowedOrigin;
  return {
    'Access-Control-Allow-Origin':  acao,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function jsonResponse(data, status, origin, allowedOrigin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin, allowedOrigin),
    },
  });
}

/* ------------------------------------------------------------------ */
/* Phone validation (Ethiopian formats)                                */
/* ------------------------------------------------------------------ */
function isValidPhone(val) {
  const v = (val || '').trim().replace(/[\s\-().]/g, '');
  return /^(09|07)\d{8}$/.test(v) || /^\+251[79]\d{8}$/.test(v);
}

/* ------------------------------------------------------------------ */
/* Sanitise: strip characters that break Telegram MarkdownV2          */
/* Using plain text mode — no special escaping needed                  */
/* ------------------------------------------------------------------ */
function safe(val, maxLen) {
  if (val === null || val === undefined) return '';
  return String(val).slice(0, maxLen || MAX_FIELD_LEN).trim();
}

/* ------------------------------------------------------------------ */
/* Build Telegram message (plain text)                                 */
/* ------------------------------------------------------------------ */
function buildMessage(data, submittedAt) {
  const lines = [];

  lines.push('NEW ORDER — TSI COSMETICS');
  lines.push('─────────────────────────');
  lines.push(`Order reference: ${data.ref}`);
  lines.push(`Status: Pending owner confirmation`);
  lines.push(`Submitted at: ${submittedAt}`);
  lines.push('');

  lines.push('CUSTOMER DETAILS');
  lines.push(`Full name: ${data.name}`);
  lines.push(`Phone number: ${data.phone}`);
  lines.push(`Alternative phone: ${data.altPhone || 'Not provided'}`);
  lines.push(`City / area: ${data.city}`);
  lines.push(`Delivery address: ${data.address}`);
  lines.push(`Delivery instructions: ${data.notes || 'Not provided'}`);
  lines.push(`Customer note: ${data.orderNote || 'Not provided'}`);
  lines.push('');

  lines.push('ORDER ITEMS');
  let subtotal = 0;
  data.items.forEach(item => {
    const lineTotal = item.unitPrice * item.qty;
    subtotal += lineTotal;
    lines.push(`  ${item.name} (${item.brand}) — ${item.qty} x ${item.unitPrice.toLocaleString()} ETB = ${lineTotal.toLocaleString()} ETB`);
  });
  lines.push('');
  lines.push(`Estimated subtotal: ${subtotal.toLocaleString()} ETB`);
  lines.push('');

  lines.push('OWNER ACTION');
  lines.push('Review this order, confirm product availability and final pricing,');
  lines.push('then contact the customer to arrange delivery and payment.');

  const msg = lines.join('\n');

  /* Truncate safely if somehow over limit */
  if (msg.length > TG_MAX_MSG_LEN) {
    return msg.slice(0, TG_MAX_MSG_LEN - 50) + '\n\n[Message truncated — check all items]';
  }
  return msg;
}

/* ------------------------------------------------------------------ */
/* Main handler                                                         */
/* ------------------------------------------------------------------ */
export default {
  async fetch(request, env) {
    const origin        = request.headers.get('Origin') || '';
    const allowedOrigin = (env.ALLOWED_ORIGIN || '').trim();

    /* ---- Preflight ---- */
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, allowedOrigin),
      });
    }

    /* ---- Only POST /api/order ---- */
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/api/order') {
      return jsonResponse({ ok: false, error: 'Not found' }, 404, origin, allowedOrigin);
    }

    /* ---- Origin check (skip if ALLOWED_ORIGIN is empty — dev mode) ---- */
    if (allowedOrigin && origin && origin !== allowedOrigin) {
      return jsonResponse({ ok: false, error: 'Forbidden' }, 403, origin, allowedOrigin);
    }

    /* ---- Content-Type check ---- */
    const ct = request.headers.get('Content-Type') || '';
    if (!ct.includes('application/json')) {
      return jsonResponse({ ok: false, error: 'Content-Type must be application/json' }, 400, origin, allowedOrigin);
    }

    /* ---- Body size limit ---- */
    const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
    if (contentLength > MAX_BODY_BYTES) {
      return jsonResponse({ ok: false, error: 'Request too large' }, 413, origin, allowedOrigin);
    }

    /* ---- Parse body ---- */
    let body;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) {
        return jsonResponse({ ok: false, error: 'Request too large' }, 413, origin, allowedOrigin);
      }
      body = JSON.parse(text);
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400, origin, allowedOrigin);
    }

    /* ---- Validate required fields ---- */
    const name    = safe(body.name,    MAX_NAME_LEN);
    const phone   = safe(body.phone,   MAX_PHONE_LEN);
    const city    = safe(body.city,    MAX_FIELD_LEN);
    const address = safe(body.address, MAX_FIELD_LEN);

    if (!name)              return jsonResponse({ ok: false, error: 'Name is required' },    400, origin, allowedOrigin);
    if (!isValidPhone(phone)) return jsonResponse({ ok: false, error: 'Invalid phone number' }, 400, origin, allowedOrigin);
    if (!city)              return jsonResponse({ ok: false, error: 'City is required' },    400, origin, allowedOrigin);
    if (!address)           return jsonResponse({ ok: false, error: 'Address is required' }, 400, origin, allowedOrigin);

    /* ---- Validate items ---- */
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length) {
      return jsonResponse({ ok: false, error: 'No items in order' }, 400, origin, allowedOrigin);
    }
    if (rawItems.length > MAX_ITEMS) {
      return jsonResponse({ ok: false, error: 'Too many items' }, 400, origin, allowedOrigin);
    }

    const items = rawItems.map(item => ({
      name:      safe(item.name,  120),
      brand:     safe(item.brand, 80),
      qty:       Math.min(Math.max(parseInt(item.qty, 10) || 1, 1), MAX_QTY),
      unitPrice: Math.max(parseFloat(item.unitPrice) || 0, 0),
    })).filter(i => i.name && i.qty > 0);

    if (!items.length) {
      return jsonResponse({ ok: false, error: 'No valid items in order' }, 400, origin, allowedOrigin);
    }

    /* ---- Build sanitised data object ---- */
    const ref = safe(body.ref, 20) || ('TSI-' + Math.random().toString(36).substr(2, 6).toUpperCase());

    const data = {
      ref,
      name,
      phone,
      altPhone:  safe(body.altPhone,  MAX_PHONE_LEN),
      city,
      address,
      notes:     safe(body.notes,     MAX_FIELD_LEN),
      orderNote: safe(body.orderNote, MAX_FIELD_LEN),
      items,
    };

    /* ---- Build Telegram message ---- */
    const submittedAt = new Date().toLocaleString('en-ET', {
      timeZone:  'Africa/Addis_Ababa',
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    const message = buildMessage(data, submittedAt);

    /* ---- Send to Telegram ---- */
    const botToken = env.TELEGRAM_BOT_TOKEN;
    const chatId   = env.TELEGRAM_OWNER_CHAT_ID;

    if (!botToken || !chatId) {
      /* Misconfigured — do not expose details to client */
      console.error('TSI Worker: TELEGRAM_BOT_TOKEN or TELEGRAM_OWNER_CHAT_ID not configured');
      return jsonResponse({ ok: false, error: 'Order service not configured. Please contact us directly.' }, 503, origin, allowedOrigin);
    }

    const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

    let tgRes;
    try {
      tgRes = await fetch(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text:    message,
        }),
      });
    } catch (fetchErr) {
      console.error('TSI Worker: Telegram fetch failed', fetchErr.message);
      return jsonResponse({ ok: false, error: 'Could not reach Telegram. Please try again.' }, 502, origin, allowedOrigin);
    }

    let tgData;
    try {
      tgData = await tgRes.json();
    } catch {
      tgData = {};
    }

    if (!tgRes.ok || !tgData.ok) {
      /* Log the Telegram error description server-side only */
      console.error('TSI Worker: Telegram API error', tgRes.status, tgData.description || '');
      return jsonResponse({
        ok:    false,
        error: 'The notification could not be delivered. Please try again or contact us directly.',
      }, 502, origin, allowedOrigin);
    }

    /* ---- Success ---- */
    return jsonResponse({ ok: true, ref }, 200, origin, allowedOrigin);
  },
};
