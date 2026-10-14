/**
 * TSI Cosmetics — Combined Cloudflare Worker
 * Serves: the static storefront (index.html), the private admin panel (/admin/),
 *         the Telegram order API (/api/order), and the protected admin API (/api/admin/*).
 *
 * Repo layout: the public site lives at the REPOSITORY ROOT (index.html, admin/,
 * data/, file/, content.json) so the same repo can also be served by GitHub Pages.
 * The Worker serves those as static assets — `.assetsignore` keeps source and
 * secrets out of the public upload.
 *
 * Secrets (set with: wrangler secret put NAME)  — never commit real values
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_OWNER_CHAT_ID
 *   GITHUB_TOKEN          (fine-grained PAT: Contents = Read and write on this repo)
 *   ADMIN_PASSWORD        (bootstrap password; once changed in the admin panel the
 *                          PBKDF2 hash in KV takes priority)
 *   SESSION_SECRET        (long random string used to sign the admin session cookie)
 *
 * Vars (wrangler.toml [vars])
 *   GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH
 *
 * Bindings
 *   ASSETS   — static asset binding
 *   ADMIN_KV — optional KV namespace that stores the current admin password hash
 */

/* ── Limits ─────────────────────────────────────────────────── */
const MAX_BODY = 8_000;
const MAX_ITEMS = 20;
const MAX_QTY = 99;
const MAX_STR = 500;
const MAX_NAME = 120;
const MAX_PHONE = 20;
const TG_LIMIT = 4000;
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 hours
const COOKIE_NAME = 'tsi_admin';
const MAX_PW = 200;
const MIN_PW = 8;
const PBKDF2_ITERATIONS = 150_000;
const PW_KEY = 'admin_password';
/* Bumped on every password change so already-issued session cookies stop working. */
const EPOCH_KEY = 'session_epoch';

const MAX_UPLOAD_BASE64 = 9_000_000;    // ~6.7 MB of bytes
const MAX_CATALOG_BYTES = 400_000;
const MAX_CONTENT_BYTES = 120_000;

/* Only these GitHub paths may ever be written by the admin API (repo-root layout). */
const WRITE_ALLOW = [
  /^data\/products\.json$/,
  /^content\.json$/,
  /^file\/(products|brands|gallery)\/[A-Za-z0-9._-]+$/,
];
/* Only these extensions may be uploaded as images. */
const IMG_EXT = /\.(png|jpe?g|webp|gif|avif|svg)$/i;

const IMG_MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

const CATALOG_PATH = 'data/products.json';
const CONTENT_PATH = 'content.json';

/* ── Small helpers ──────────────────────────────────────────── */
function j(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}

function safe(v, max = MAX_STR) {
  return String(v ?? '').slice(0, max).trim();
}

function validPhone(v) {
  const s = (v ?? '').trim().replace(/[\s\-().]/g, '');
  return /^(09|07)\d{8}$/.test(s) || /^\+251[79]\d{8}$/.test(s);
}

function genRef() {
  return 'TSI-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function allowedPath(p) {
  return typeof p === 'string' && WRITE_ALLOW.some((re) => re.test(p));
}

/* Cross-origin access for the public order endpoint only. This lets the same
   storefront, when served from GitHub Pages, submit orders to this Worker. */
function orderCors(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin) return {};
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/* Reject cross-site mutations (CSRF hardening) for cookie-authenticated routes. */
function sameOrigin(req) {
  const origin = req.headers.get('Origin');
  if (!origin) return true; // same-origin fetches may omit Origin; cookie is SameSite=Strict
  try { return origin === new URL(req.url).origin; } catch { return false; }
}

/* ── HMAC session helpers ───────────────────────────────────── */
async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/* Constant-time-ish comparison; both are base64 of a SHA-256 HMAC (fixed length). */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/* Current session epoch (0 when KV is not bound). */
async function getEpoch(env) {
  if (!env.ADMIN_KV) return 0;
  try {
    const v = parseInt(await env.ADMIN_KV.get(EPOCH_KEY), 10);
    return isFinite(v) && v > 0 ? v : 0;
  } catch { return 0; }
}

async function createSession(secret, epoch) {
  const payload = btoa(JSON.stringify({ ok: true, exp: Date.now() + SESSION_TTL, e: epoch || 0 }));
  const sig = await hmacSign(secret, payload);
  return `${payload}.${sig}`;
}

async function verifySession(secret, cookie, epoch = 0) {
  if (!secret || !cookie) return false;
  const dot = cookie.lastIndexOf('.');
  if (dot < 0) return false;
  const payload = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = await hmacSign(secret, payload);
  if (!timingSafeEqual(expected, sig)) return false;
  try {
    const data = JSON.parse(atob(payload));
    const e = typeof data.e === 'number' ? data.e : 0;
    return data.ok === true && data.exp > Date.now() && e === epoch;
  } catch { return false; }
}

function getSessionCookie(req) {
  const h = req.headers.get('Cookie') ?? '';
  const m = h.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return m ? m[1] : null;
}

function sessionCookieHeader(value, { clear = false, secure = true } = {}) {
  const parts = [`${COOKIE_NAME}=${clear ? '' : value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secure) parts.push('Secure');
  parts.push(`Max-Age=${clear ? 0 : SESSION_TTL / 1000}`);
  return parts.join('; ');
}

/* ── Password hashing (PBKDF2-SHA256) ───────────────────────── */
function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derivePw(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}

/* Stored form:  pbkdf2$<iterations>$<saltB64>$<hashB64> */
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePw(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(hash)}`;
}

async function verifyStoredHash(stored, password) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  if (!isFinite(iterations) || iterations < 1000) return false;
  let salt, expected;
  try { salt = b64ToBytes(parts[2]); expected = b64ToBytes(parts[3]); } catch { return false; }
  const actual = await derivePw(password, salt, iterations);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(bytesToB64(actual), bytesToB64(expected));
}

/* The KV hash wins over the ADMIN_PASSWORD secret, so a password changed in the
   admin panel takes effect immediately and permanently. */
async function getStoredHash(env) {
  if (!env.ADMIN_KV) return null;
  try { return await env.ADMIN_KV.get(PW_KEY); } catch { return null; }
}

async function verifyAdminPassword(env, password) {
  const stored = await getStoredHash(env);
  if (stored) return verifyStoredHash(stored, password);
  if (!env.ADMIN_PASSWORD) return false;
  return timingSafeEqual(safe(password, MAX_PW), safe(env.ADMIN_PASSWORD, MAX_PW));
}

async function passwordConfigured(env) {
  if (env.ADMIN_KV && (await getStoredHash(env))) return true;
  return !!env.ADMIN_PASSWORD;
}

/* ── Login throttling (best effort, per isolate) ────────────── */
const loginHits = new Map(); // ip -> { n, until }
function throttleLogin(ip) {
  const now = Date.now();
  const rec = loginHits.get(ip);
  if (rec && rec.until > now && rec.n >= 8) return false;
  if (!rec || rec.until < now) loginHits.set(ip, { n: 1, until: now + 5 * 60 * 1000 });
  else rec.n++;
  return true;
}
function clearLoginHits(ip) { loginHits.delete(ip); }

/* ── GitHub helpers ─────────────────────────────────────────── */
function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'TSI-Cosmetics-Worker/1.2',
  };
}
/* Base URL for the repository.

   /repositories/{id} is GitHub's documented alias for /repos/{owner}/{repo}:
   it accepts the same sub-paths (contents, git/refs, …) and the same methods.
   We prefer it when GITHUB_REPO_ID is set because it keeps working across
   renames — and because a repository can be reachable by id while its
   owner/name path resolves to 404. */
function ghRepo(env) {
  if (env.GITHUB_REPO_ID) return `https://api.github.com/repositories/${encodeURIComponent(env.GITHUB_REPO_ID)}`;
  return `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}`;
}
function ghConfigured(env) {
  const target = env.GITHUB_REPO_ID || (env.GITHUB_OWNER && env.GITHUB_REPO);
  return !!(env.GITHUB_TOKEN && target && env.GITHUB_BRANCH);
}
/* Human-readable target for messages (owner/name, plus the id we actually use). */
function ghTargetLabel(env) {
  const name = (env.GITHUB_OWNER && env.GITHUB_REPO) ? `${env.GITHUB_OWNER}/${env.GITHUB_REPO}` : 'repository';
  return env.GITHUB_REPO_ID ? `${name} (id ${env.GITHUB_REPO_ID})` : name;
}
const GH_MISSING = 'Publishing is not configured yet: the GITHUB_TOKEN secret is missing on this Worker. Add it in Cloudflare → Worker → Settings → Variables and Secrets, then reload this page.';
async function ghGuard(env) {
  const state = await checkPublishing(env);
  if (state === 'ok') return null;
  const msg = state === 'missing' ? GH_MISSING
    : state === 'invalid-token' ? 'GitHub rejected the GITHUB_TOKEN secret (401/403). Create a fine-grained token with Contents: Read and write on this repo, or renew the expired one, then set it again in Cloudflare.'
    : state === 'repo-not-found' ? `GitHub could not find ${ghTargetLabel(env)}. Check the GITHUB_OWNER / GITHUB_REPO (or GITHUB_REPO_ID) values in wrangler.toml, and that the token is scoped to this repository.`
    : 'Could not reach the GitHub API (' + state + '). Try again in a moment.';
  return j({ ok: false, error: msg, publishing: state }, 503);
}

/* Verify the token can actually read the repo, so the admin can tell the owner
   the difference between "not set", "wrong token" and "ready". */
let pubCache = { at: 0, value: null };
async function checkPublishing(env) {
  if (!ghConfigured(env)) return 'missing';
  const now = Date.now();
  if (pubCache.value && now - pubCache.at < 30_000) return pubCache.value;
  let value;
  try {
    const res = await fetch(ghRepo(env), { headers: ghHeaders(env) });
    if (res.ok) value = 'ok';
    else if (res.status === 401 || res.status === 403) value = 'invalid-token';
    else if (res.status === 404) value = 'repo-not-found';
    else value = 'error-' + res.status;
  } catch {
    value = 'unreachable';
  }
  pubCache = { at: now, value };
  return value;
}

async function ghGet(env, path, ref) {
  const url = `${ghRepo(env)}/contents/${path}?ref=${encodeURIComponent(ref || env.GITHUB_BRANCH)}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} → ${res.status}`);
  return res.json();
}

async function ghList(env, path) {
  const url = `${ghRepo(env)}/contents/${path}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub LIST ${path} → ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function ghPut(env, path, base64Content, message, sha) {
  if (!allowedPath(path)) throw new Error('Path not allowed: ' + path);
  const body = { message, content: base64Content, branch: env.GITHUB_BRANCH };
  if (sha) body.sha = sha;
  const res = await fetch(`${ghRepo(env)}/contents/${path}`, {
    method: 'PUT', headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub PUT ${path} → ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

async function ghDelete(env, path, sha, message) {
  if (!allowedPath(path)) throw new Error('Path not allowed: ' + path);
  const res = await fetch(`${ghRepo(env)}/contents/${path}`, {
    method: 'DELETE', headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha, branch: env.GITHUB_BRANCH }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub DELETE ${path} → ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

/* UTF-8 safe base64 (works for both text and raw byte strings) */
function toBase64Utf8(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64DecodeToUtf8(b64) { return decodeURIComponent(escape(atob((b64 || '').replace(/\n/g, '')))); }

/* ── Telegram order message ─────────────────────────────────── */
function buildTgMsg(data, ref, ts) {
  const lines = [
    'NEW ORDER — TSI COSMETICS',
    '─────────────────────────',
    `Order reference: ${ref}`,
    'Status: Pending owner confirmation',
    `Submitted: ${ts}`,
    '',
    'CUSTOMER DETAILS',
    `Name: ${data.name}`,
    `Phone: ${data.phone}`,
    `Alt phone: ${data.altPhone || 'Not provided'}`,
    `City: ${data.city}`,
    `Address: ${data.address}`,
    `Delivery notes: ${data.notes || 'Not provided'}`,
    `Customer note: ${data.orderNote || 'Not provided'}`,
    '',
    'ORDER ITEMS',
  ];
  let total = 0;
  for (const it of data.items) {
    const line = it.unitPrice * it.qty;
    total += line;
    lines.push(`  ${it.name} (${it.brand}) — ${it.qty} x ${it.unitPrice.toLocaleString()} ETB = ${line.toLocaleString()} ETB`);
  }
  lines.push('', `Estimated subtotal: ${total.toLocaleString()} ETB`, '', 'OWNER ACTION', 'Contact customer to confirm pricing, availability, and arrange payment.');
  const msg = lines.join('\n');
  return msg.length > TG_LIMIT ? msg.slice(0, TG_LIMIT - 40) + '\n[truncated]' : msg;
}

/* ── /api/order ─────────────────────────────────────────────── */
async function handleOrder(req, env) {
  if (req.method !== 'POST') return j({ ok: false, error: 'Method not allowed' }, 405);
  const ct = req.headers.get('Content-Type') ?? '';
  if (!ct.includes('application/json')) return j({ ok: false, error: 'JSON required' }, 400);
  const cl = parseInt(req.headers.get('Content-Length') ?? '0', 10);
  if (cl > MAX_BODY) return j({ ok: false, error: 'Request too large' }, 413);

  let body;
  try {
    const txt = await req.text();
    if (txt.length > MAX_BODY) return j({ ok: false, error: 'Request too large' }, 413);
    body = JSON.parse(txt);
  } catch { return j({ ok: false, error: 'Invalid JSON' }, 400); }

  if (body.website) return j({ ok: true, ref: genRef() }); // honeypot: silent discard

  const name = safe(body.name, MAX_NAME);
  const phone = safe(body.phone, MAX_PHONE);
  const city = safe(body.city);
  const address = safe(body.address);

  if (!name) return j({ ok: false, error: 'Name required' }, 400);
  if (!validPhone(phone)) return j({ ok: false, error: 'Invalid phone number' }, 400);
  if (!city) return j({ ok: false, error: 'City required' }, 400);
  if (!address) return j({ ok: false, error: 'Address required' }, 400);

  const raw = Array.isArray(body.items) ? body.items : [];
  if (!raw.length) return j({ ok: false, error: 'No items' }, 400);
  if (raw.length > MAX_ITEMS) return j({ ok: false, error: 'Too many items' }, 400);

  const items = raw.map((i) => ({
    name: safe(i.name, 120),
    brand: safe(i.brand, 80),
    qty: Math.min(Math.max(parseInt(i.qty, 10) || 1, 1), MAX_QTY),
    unitPrice: Math.max(parseFloat(i.unitPrice) || 0, 0),
  })).filter((i) => i.name && i.qty > 0);
  if (!items.length) return j({ ok: false, error: 'No valid items' }, 400);

  const ref = safe(body.ref, 20) || genRef();
  const data = {
    ref, name, phone,
    altPhone: safe(body.altPhone, MAX_PHONE),
    city, address,
    notes: safe(body.notes), orderNote: safe(body.orderNote), items,
  };

  const ts = new Date().toLocaleString('en-ET', { timeZone: 'Africa/Addis_Ababa', dateStyle: 'medium', timeStyle: 'short' });
  const msg = buildTgMsg(data, ref, ts);

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_OWNER_CHAT_ID) {
    console.error('TSI: Telegram secrets not configured');
    return j({ ok: false, error: 'Order service is not configured yet. Please contact us directly.' }, 503);
  }

  let tgRes;
  try {
    tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_OWNER_CHAT_ID, text: msg, disable_web_page_preview: true }),
    });
  } catch (e) {
    console.error('TSI: Telegram fetch error', e.message);
    return j({ ok: false, error: 'Could not reach the notification service. Please try again.' }, 502);
  }

  let tgData = {};
  try { tgData = await tgRes.json(); } catch { /* ignore */ }
  if (!tgRes.ok || !tgData.ok) {
    console.error('TSI: Telegram error', tgRes.status, tgData.description ?? '');
    return j({ ok: false, error: 'Notification failed. Please try again or contact us directly.' }, 502);
  }
  return j({ ok: true, ref });
}

/* ── Admin: auth ────────────────────────────────────────────── */
async function requireAdmin(req, env) {
  return verifySession(env.SESSION_SECRET, getSessionCookie(req), await getEpoch(env));
}

async function handleAdminAuth(req, env, pathname, url) {
  const secureCookie = url.protocol === 'https:';

  if (pathname === '/api/admin/login' && req.method === 'POST') {
    if (!sameOrigin(req)) return j({ ok: false, error: 'Cross-origin request rejected' }, 403);
    const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (!throttleLogin(ip)) return j({ ok: false, error: 'Too many attempts. Try again later.' }, 429);

    let body;
    try { body = await req.json(); } catch { return j({ ok: false, error: 'Invalid JSON' }, 400); }
    const pw = safe(body.password, MAX_PW);

    if (!env.SESSION_SECRET) {
      return j({ ok: false, error: 'Admin is not configured (SESSION_SECRET missing).' }, 503);
    }
    if (!(await passwordConfigured(env))) {
      return j({ ok: false, error: 'Admin is not configured (ADMIN_PASSWORD missing).' }, 503);
    }
    if (!pw || !(await verifyAdminPassword(env, pw))) {
      await new Promise((r) => setTimeout(r, 600)); // slow brute force
      return j({ ok: false, error: 'Invalid credentials' }, 401);
    }
    clearLoginHits(ip);
    const token = await createSession(env.SESSION_SECRET, await getEpoch(env));
    return j({ ok: true }, 200, { 'Set-Cookie': sessionCookieHeader(token, { secure: secureCookie }) });
  }

  if (pathname === '/api/admin/logout' && req.method === 'POST') {
    return j({ ok: true }, 200, { 'Set-Cookie': sessionCookieHeader('', { clear: true, secure: secureCookie }) });
  }

  return null; // fall through
}

/* ── Admin: change password ─────────────────────────────────── */
async function handlePasswordChange(req, env) {
  if (!sameOrigin(req)) return j({ ok: false, error: 'Cross-origin request rejected' }, 403);
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!throttleLogin(ip)) return j({ ok: false, error: 'Too many attempts. Try again later.' }, 429);

  let body;
  try { body = await req.json(); } catch { return j({ ok: false, error: 'Invalid JSON' }, 400); }
  const current = safe(body.current, MAX_PW);
  const next = safe(body.next, MAX_PW);

  if (!env.ADMIN_KV) {
    return j({ ok: false, error: 'Changing the password is not enabled on this Worker: the ADMIN_KV binding is missing. See README §“Change the admin password”.' }, 503);
  }
  if (!current || !(await verifyAdminPassword(env, current))) {
    await new Promise((r) => setTimeout(r, 600));
    return j({ ok: false, error: 'Your current password is incorrect.' }, 401);
  }
  if (next.length < MIN_PW) return j({ ok: false, error: `The new password must be at least ${MIN_PW} characters.` }, 400);
  if (next === current) return j({ ok: false, error: 'The new password must be different from the current one.' }, 400);

  try {
    await env.ADMIN_KV.put(PW_KEY, await hashPassword(next));
    // Invalidate every session that was issued with the old password.
    await env.ADMIN_KV.put(EPOCH_KEY, String((await getEpoch(env)) + 1));
  } catch (e) {
    return j({ ok: false, error: 'Could not save the new password: ' + e.message }, 502);
  }
  clearLoginHits(ip);
  return j({ ok: true, message: 'Password changed. Please sign in again with the new password.', reauth: true });
}

/* ── Admin: catalog (products + brands) ─────────────────────── */
async function readCatalogFile(env) {
  const file = await ghGet(env, CATALOG_PATH);
  if (!file) return { data: { products: [], brands: [] }, sha: null };
  let data;
  try { data = JSON.parse(b64DecodeToUtf8(file.content)); } catch { data = { products: [], brands: [] }; }
  if (!Array.isArray(data.products)) data.products = [];
  if (!Array.isArray(data.brands)) data.brands = [];
  return { data, sha: file.sha };
}

function validateCatalog(data) {
  if (!data || typeof data !== 'object') return 'Catalog must be an object.';
  if (!Array.isArray(data.products)) return 'products must be an array.';
  if (data.brands !== undefined && !Array.isArray(data.brands)) return 'brands must be an array.';
  const seen = new Set();
  for (const p of data.products) {
    if (!p || typeof p !== 'object') return 'Each product must be an object.';
    if (!p.id || typeof p.id !== 'string') return 'Every product needs a string id.';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(p.id)) return `Invalid product id: ${p.id}`;
    if (seen.has(p.id)) return `Duplicate product id: ${p.id}`;
    seen.add(p.id);
    if (!p.name || typeof p.name !== 'string') return `Product ${p.id} needs a name.`;
    if (!p.brand || typeof p.brand !== 'string') return `Product ${p.id} needs a brand.`;
    if (!p.category || typeof p.category !== 'string') return `Product ${p.id} needs a category.`;
    if (typeof p.price !== 'number' || !isFinite(p.price) || p.price < 0) return `Product ${p.id} needs a numeric price.`;
    if (!p.image || typeof p.image !== 'string') return `Product ${p.id} needs an image.`;
  }
  return null;
}

function validateBrands(brands) {
  if (!Array.isArray(brands)) return 'brands must be an array.';
  const seen = new Set();
  for (const b of brands) {
    if (!b || typeof b !== 'object') return 'Each brand must be an object.';
    if (!b.id || typeof b.id !== 'string') return 'Every brand needs a string id.';
    if (seen.has(b.id)) return `Duplicate brand id: ${b.id}`;
    seen.add(b.id);
    if (!b.name || typeof b.name !== 'string') return `Brand ${b.id} needs a name.`;
  }
  return null;
}

async function handleCatalog(req, env, pathname) {
  if (pathname === '/api/admin/catalog' && req.method === 'GET') {
    const guard = await ghGuard(env);
    if (guard) return guard;
    try {
      const { data, sha } = await readCatalogFile(env);
      return j({ ok: true, sha, products: data.products, brands: data.brands });
    } catch (e) {
      return j({ ok: false, error: 'Could not load catalog: ' + e.message }, 502);
    }
  }

  if (pathname === '/api/admin/catalog' && req.method === 'PUT') {
    if (!sameOrigin(req)) return j({ ok: false, error: 'Cross-origin request rejected' }, 403);
    let body;
    try { body = await req.json(); } catch { return j({ ok: false, error: 'Invalid JSON' }, 400); }

    // Validate the submitted products BEFORE any network call, so bad input is
    // rejected with a clear 400 instead of depending on GitHub being reachable.
    const productErr = validateCatalog({ products: body.products, brands: [] });
    if (productErr) return j({ ok: false, error: productErr }, 400);

    const guard = await ghGuard(env);
    if (guard) return guard;

    // Re-read the current file: the sha prevents concurrent edits from silently
    // clobbering each other, and existing brands are kept when the client sends only
    // products — so a product save can never wipe the brands array.
    let existing;
    try { existing = await ghGet(env, CATALOG_PATH); }
    catch (e) { return j({ ok: false, error: 'Could not read the current catalog: ' + e.message }, 502); }

    let existingBrands = [];
    if (existing) {
      try { existingBrands = JSON.parse(b64DecodeToUtf8(existing.content)).brands || []; } catch { existingBrands = []; }
    }

    const brands = Array.isArray(body.brands) ? body.brands : existingBrands;
    const brandsErr = validateBrands(brands);
    if (brandsErr) return j({ ok: false, error: brandsErr }, 400);

    const catalog = { products: body.products, brands };

    const content = JSON.stringify(catalog, null, 2);
    if (content.length > MAX_CATALOG_BYTES) return j({ ok: false, error: 'Catalog too large to save.' }, 413);

    try {
      const result = await ghPut(env, CATALOG_PATH, toBase64Utf8(content),
        'Admin: update product catalog', existing ? existing.sha : undefined);
      return j({
        ok: true,
        commit: result.commit?.sha ?? null,
        commitUrl: result.commit?.html_url ?? null,
        published: false,
        message: 'Committed to GitHub. Cloudflare Workers Builds will deploy automatically.',
      });
    } catch (e) {
      return j({ ok: false, error: 'Save failed: ' + e.message }, 502);
    }
  }
  return null;
}

/* ── Admin: content.json (site text + settings) ─────────────── */
const DEFAULT_CONTENT = {
  store: {
    name: 'TSI Cosmetics',
    tagline: 'Cosmetics',
    siteUrl: 'https://tsicosmeticsandsupplements.bereket1515mamuye.workers.dev',
    currency: 'ETB',
    phone: '+251911695289',
    phoneDisplay: '+251 911 695 289',
    telegram: 'https://t.me/Tsi27278',
    telegramHandle: '@Tsi27278',
    tiktok: 'https://www.tiktok.com/@tsi.cosmotics',
    tiktokHandle: '@tsi.cosmotics',
    hours: 'Monday – Saturday, 9:00 AM – 8:00 PM',
    addressLine: 'Addis Ababa, Ethiopia',
  },
  theme: { primary: '#C4896F' },
  announcement: {
    enabled: true,
    text: 'Free delivery available across Addis Ababa',
    link: 'https://t.me/Tsi27278',
    linkText: 'Order via Telegram',
  },
  hero: {
    eyebrow: 'Imported Products · Ethiopia',
    title: 'Premium Beauty,',
    titleEm: 'Curated for You',
    text: 'TSI Cosmetics brings original skincare, cosmetics, and wellness products to Ethiopia. Browse our collection and order with confidence.',
  },
  shop: {
    title: 'Shop by',
    titleEm: 'Category',
    subtitle: 'Discover our full range of beauty, skincare, and wellness products.',
    priceNote: 'Prices shown are indicative. Please confirm current pricing when you place your order.',
    supplementsNote: 'Supplements are not evaluated by any regulatory authority and are not intended to diagnose, treat, cure, or prevent any disease. Consult a healthcare professional before use.',
  },
  about: {
    eyebrow: 'About TSI Cosmetics',
    title: 'Your Source for',
    titleEm: 'Original Beauty',
    p1: 'TSI Cosmetics brings a carefully selected range of beauty, skincare, and health products to customers in Ethiopia. We focus on sourcing quality products and making them accessible through straightforward, personal service.',
    p2: 'Whether you are looking for daily skincare essentials, colour cosmetics, hair treatments, or wellness supplements, our goal is to offer products you can trust — with service that is fast, honest, and helpful.',
    points: ['Quality products', 'Personal service', 'Honest pricing', 'Fast response'],
  },
  ordering: {
    consentText: 'I understand this is an order request. TSI Cosmetics will contact me to confirm availability, final pricing, and payment before the order is finalised.',
    subtotalLabel: 'Estimated Subtotal',
    taxNote: 'Final pricing, availability, delivery costs, and payment will be confirmed by the owner when they contact you.',
    deliveryNote: 'Delivery available across major Ethiopian cities.',
    paymentNote: 'Payment: Telebirr, bank transfer, or cash on delivery for eligible areas.',
    successNote: 'Your request has been received by TSI Cosmetics.',
  },
  footer: {
    blurb: 'Original imported cosmetics, skincare, and wellness products in Ethiopia. Order by phone or Telegram.',
    copyright: 'All rights reserved.',
    creditName: 'Triverse Studio',
    creditUrl: 'https://m1616d.github.io/Triverse-Studio/',
  },
  faq: {
    intro: 'Everything you need to know about ordering from TSI Cosmetics.',
    items: [
      { q: 'Are your products original imports?', a: 'We source our products carefully and aim to carry genuine imported goods. If you have questions about a specific product, please contact us before ordering.' },
      { q: 'How do I place an order?', a: 'Click "Order Now" on any product or in the navigation, fill in your details on the order form, and submit. We will contact you to confirm. You can also reach us on Telegram or by phone.' },
      { q: 'Do you deliver across Ethiopia?', a: 'We deliver to major cities and areas across Ethiopia. Contact us to confirm availability and delivery time for your area.' },
      { q: 'What payment methods do you accept?', a: 'We accept Telebirr, bank transfer, and cash on delivery for eligible areas. The owner will confirm payment details when they contact you.' },
      { q: 'Can I return or exchange a product?', a: 'If you receive an item that is damaged or not what you ordered, please contact us within 7 days of delivery and we will work with you to find a solution.' },
    ],
  },
};

/* Coerce any submitted content to the shape of DEFAULT_CONTENT.
   Unknown keys are dropped and every value is length-capped, so a saved blob
   can never be huge, wrong-typed, or able to inject markup into the storefront. */
function limitStr(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}
/* Deepest legitimate path in DEFAULT_CONTENT is faq.items[].q / .a, which sits
   at depth 4 (root → faq → items → item → field). A limit of 3 cut those fields
   to null on every save, silently blanking the FAQ, so allow headroom and make
   the fallback the template's own default — a value, never null. */
const MAX_TEMPLATE_DEPTH = 6;
function sanitizeByTemplate(tpl, val, depth = 0) {
  if (depth > MAX_TEMPLATE_DEPTH) return tpl === undefined ? null : JSON.parse(JSON.stringify(tpl));
  if (Array.isArray(tpl)) {
    const itemTpl = tpl[0];
    const arr = Array.isArray(val) ? val.slice(0, 12) : [];
    if (typeof itemTpl === 'string') return arr.map((x) => limitStr(x, 200)).filter(Boolean);
    if (itemTpl && typeof itemTpl === 'object') return arr.map((x) => sanitizeByTemplate(itemTpl, x, depth + 1));
    return [];
  }
  if (tpl && typeof tpl === 'object') {
    const src = (val && typeof val === 'object' && !Array.isArray(val)) ? val : {};
    const out = {};
    for (const k of Object.keys(tpl)) out[k] = sanitizeByTemplate(tpl[k], src[k], depth + 1);
    return out;
  }
  if (typeof tpl === 'boolean') return val === undefined ? tpl : !!val;
  if (typeof tpl === 'number') return (typeof val === 'number' && isFinite(val)) ? val : tpl;
  return val === undefined ? tpl : limitStr(val, 500);
}
function sanitizeContent(input) {
  return sanitizeByTemplate(DEFAULT_CONTENT, input);
}
/* Old deployments only had announcement + hero. Merge so nothing is lost. */
function migrateContent(raw) {
  return sanitizeContent(raw || {});
}

async function handleContent(req, env, pathname) {
  if (pathname === '/api/admin/content' && req.method === 'GET') {
    const guard = await ghGuard(env);
    if (guard) return guard;
    try {
      const file = await ghGet(env, CONTENT_PATH);
      if (!file) return j({ ok: true, sha: null, content: DEFAULT_CONTENT });
      let content;
      try { content = migrateContent(JSON.parse(b64DecodeToUtf8(file.content))); }
      catch { content = DEFAULT_CONTENT; }
      return j({ ok: true, sha: file.sha, content });
    } catch (e) {
      return j({ ok: false, error: 'Could not load content: ' + e.message }, 502);
    }
  }

  if (pathname === '/api/admin/content' && req.method === 'PUT') {
    if (!sameOrigin(req)) return j({ ok: false, error: 'Cross-origin request rejected' }, 403);
    let body;
    try { body = await req.json(); } catch { return j({ ok: false, error: 'Invalid JSON' }, 400); }
    if (!body.content || typeof body.content !== 'object') return j({ ok: false, error: 'Invalid content' }, 400);

    const content = sanitizeContent(body.content);
    const json = JSON.stringify(content, null, 2);
    if (json.length > MAX_CONTENT_BYTES) return j({ ok: false, error: 'Content too large.' }, 413);

    const guard = await ghGuard(env);
    if (guard) return guard;

    try {
      const existing = await ghGet(env, CONTENT_PATH);
      const result = await ghPut(env, CONTENT_PATH, toBase64Utf8(json),
        'Admin: update site content and settings', existing ? existing.sha : undefined);
      return j({ ok: true, commit: result.commit?.sha ?? null, commitUrl: result.commit?.html_url ?? null, published: false });
    } catch (e) {
      return j({ ok: false, error: 'Save failed: ' + e.message }, 502);
    }
  }
  return null;
}

/* ── Admin: image file manager ──────────────────────────────── */
async function handleFiles(req, env, pathname) {
  /* List */
  if (pathname === '/api/admin/files' && req.method === 'GET') {
    const guard = await ghGuard(env);
    if (guard) return guard;
    try {
      const dirs = ['products', 'brands', 'gallery'];
      const out = [];
      for (const d of dirs) {
        const items = await ghList(env, `file/${d}`);
        for (const it of items) {
          if (it.type !== 'file') continue;
          if (!IMG_EXT.test(it.name)) continue;
          out.push({ name: it.name, dir: d, path: `file/${d}/${it.name}`, url: `/file/${d}/${it.name}`, size: it.size, sha: it.sha });
        }
      }
      return j({ ok: true, files: out });
    } catch (e) {
      return j({ ok: false, error: 'Could not list files: ' + e.message }, 502);
    }
  }

  /* Upload */
  if (pathname === '/api/admin/upload' && req.method === 'POST') {
    if (!sameOrigin(req)) return j({ ok: false, error: 'Cross-origin request rejected' }, 403);
    let body;
    try { body = await req.json(); } catch { return j({ ok: false, error: 'Invalid JSON' }, 400); }

    const dir = safe(body.dir, 20);
    if (!['products', 'brands', 'gallery'].includes(dir)) return j({ ok: false, error: 'Invalid target folder' }, 400);

    const dataUrl = body.dataUrl;
    if (typeof dataUrl !== 'string') return j({ ok: false, error: 'Missing image data' }, 400);
    if (dataUrl.length > MAX_UPLOAD_BASE64) return j({ ok: false, error: 'Image is too large (max ~6 MB).' }, 413);

    const m = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
    if (!m) return j({ ok: false, error: 'Unsupported image format.' }, 400);
    const mime = m[1].toLowerCase();
    const ext = IMG_MIME_EXT[mime];
    if (!ext) return j({ ok: false, error: 'Supported formats: PNG, JPEG, WEBP, GIF, AVIF.' }, 400);

    let base = safe(body.name, 80).replace(/\.[A-Za-z0-9]+$/, '');
    base = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (!base) base = 'image-' + Date.now().toString(36);
    const filename = `${base}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const path = `file/${dir}/${filename}`;
    if (!allowedPath(path)) return j({ ok: false, error: 'Invalid target path' }, 400);

    const guard = await ghGuard(env);
    if (guard) return guard;

    try {
      const existing = await ghGet(env, path);
      const result = await ghPut(env, path, m[2], `Admin: upload ${dir} image ${filename}`, existing ? existing.sha : undefined);
      return j({
        ok: true,
        path, url: `/file/${dir}/${filename}`, name: filename,
        commit: result.commit?.sha ?? null,
        commitUrl: result.commit?.html_url ?? null,
      });
    } catch (e) {
      return j({ ok: false, error: 'Upload failed: ' + e.message }, 502);
    }
  }

  /* Delete (with reference guard) */
  if (pathname === '/api/admin/file' && req.method === 'DELETE') {
    if (!sameOrigin(req)) return j({ ok: false, error: 'Cross-origin request rejected' }, 403);
    let body;
    try { body = await req.json(); } catch { return j({ ok: false, error: 'Invalid JSON' }, 400); }
    const path = safe(body.path, 200);
    if (!path) return j({ ok: false, error: 'Missing path' }, 400);
    if (!allowedPath(path)) return j({ ok: false, error: 'Path not allowed' }, 400);

    const guard = await ghGuard(env);
    if (guard) return guard;

    try {
      // Reference check against catalog + content before deleting.
      if (!body.force) {
        const { data } = await readCatalogFile(env);
        const hay = JSON.stringify(data);
        if (hay.includes(path) || hay.includes('/' + path)) {
          return j({ ok: false, error: 'This image is still referenced by a product or brand. Reassign it first, or confirm forced deletion.', referenced: true }, 409);
        }
      }
      const existing = await ghGet(env, path);
      if (!existing) return j({ ok: false, error: 'File not found' }, 404);
      const result = await ghDelete(env, path, existing.sha, `Admin: delete image ${path}`);
      return j({ ok: true, commit: result.commit?.sha ?? null });
    } catch (e) {
      return j({ ok: false, error: 'Delete failed: ' + e.message }, 502);
    }
  }
  return null;
}

/* ── Admin: honest publish verification ─────────────────────── */
/* Compares the catalog currently served by the live site with the catalog in the
   repo. Equal ⇒ the deploy finished and the change is really live. */
async function handleVerify(req, env, url) {
  if (req.method !== 'GET') return j({ ok: false, error: 'Method not allowed' }, 405);
  let live, liveContentOk = false;
  try {
    const res = await fetch(`${url.origin}/data/products.json?cb=${Date.now()}`, { cf: { cacheTtl: 0, cacheEverything: false } });
    if (!res.ok) return j({ ok: true, live: false, detail: `The live catalog returned HTTP ${res.status}.` });
    live = await res.json();
    try {
      const c = await fetch(`${url.origin}/content.json?cb=${Date.now()}`, { cf: { cacheTtl: 0, cacheEverything: false } });
      liveContentOk = c.ok;
    } catch { liveContentOk = false; }
  } catch (e) {
    return j({ ok: false, error: 'Verification failed: ' + e.message }, 502);
  }

  const liveProducts = Array.isArray(live.products) ? live.products : [];
  const liveIds = liveProducts.map((p) => p && p.id).join(',');

  let repoIds = null, repoErr = null;
  if (ghConfigured(env)) {
    try {
      const { data } = await readCatalogFile(env);
      repoIds = data.products.map((p) => p && p.id).join(',');
    } catch (e) { repoErr = e.message; }
  }

  const idsMatch = repoIds !== null && repoIds === liveIds;
  const liveOk = idsMatch && liveContentOk;

  return j({
    ok: true,
    live: liveOk,
    idsMatch,
    contentLive: liveContentOk,
    productCount: liveProducts.length,
    brandCount: Array.isArray(live.brands) ? live.brands.length : 0,
    detail: liveOk
      ? 'The live site is serving exactly what was saved to GitHub.'
      : (repoErr
        ? 'Could not read the repo to compare: ' + repoErr
        : (!liveContentOk
          ? 'The live site is not serving content.json yet.'
          : 'The live site is still serving an older catalog — the build has probably not finished yet.')),
  });
}

/* ── Admin router ───────────────────────────────────────────── */
async function handleAdmin(req, env, pathname, url) {
  const auth = await handleAdminAuth(req, env, pathname, url);
  if (auth) return auth;

  if (!(await requireAdmin(req, env))) return j({ ok: false, error: 'Unauthorized' }, 401);

  if (pathname === '/api/admin/status' && req.method === 'GET') {
    return j({
      ok: true,
      authed: true,
      publishing: await checkPublishing(env),
      canPublish: (await checkPublishing(env)) === 'ok',
      canChangePassword: !!env.ADMIN_KV,
      passwordFromKv: !!(env.ADMIN_KV && (await getStoredHash(env))),
      usingSecretPassword: !!(await passwordConfigured(env)),
      repo: `${ghTargetLabel(env)}@${env.GITHUB_BRANCH || '?'}`,
      repoId: env.GITHUB_REPO_ID || null,
      ordersConfigured: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_OWNER_CHAT_ID),
    });
  }

  if (pathname === '/api/admin/password' && req.method === 'POST') {
    return handlePasswordChange(req, env);
  }

  const catalog = await handleCatalog(req, env, pathname);
  if (catalog) return catalog;

  const content = await handleContent(req, env, pathname);
  if (content) return content;

  const files = await handleFiles(req, env, pathname);
  if (files) return files;

  if (pathname === '/api/admin/verify') return handleVerify(req, env, url);

  return j({ ok: false, error: 'Not found' }, 404);
}

/* ── Entry point ────────────────────────────────────────────── */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      if (pathname === '/api/order' || pathname.startsWith('/api/order/')) {
        const cors = orderCors(request, env);
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        const res = await handleOrder(request, env);
        if (!Object.keys(cors).length) return res;
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        return new Response(res.body, { status: res.status, headers });
      }
      if (pathname.startsWith('/api/admin')) {
        return await handleAdmin(request, env, pathname, url);
      }
      if (pathname.startsWith('/api/')) {
        return j({ ok: false, error: 'Not found' }, 404);
      }
    } catch (e) {
      console.error('TSI: unhandled API error', e && e.stack ? e.stack : e);
      return j({ ok: false, error: 'Server error' }, 500);
    }

    if (env.ASSETS) {
      try {
        const res = await env.ASSETS.fetch(request);
        // Always revalidate HTML and the JSON data files so admin edits show up
        // immediately instead of waiting for a browser cache to expire.
        const isHtml = pathname === '/' || pathname.endsWith('.html') || pathname === '/admin' || pathname === '/admin/';
        const isData = pathname.endsWith('.json') || pathname.startsWith('/data/');
        if (isHtml || isData) {
          const headers = new Headers(res.headers);
          headers.set('Cache-Control', 'no-cache, must-revalidate');
          return new Response(res.body, { status: res.status, headers });
        }
        return res;
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }
    return new Response('Not found', { status: 404 });
  },
};
