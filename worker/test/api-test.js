/* Local test battery for the TSI Cosmetics Worker (run: node .freebuff/tsi-test.js) */
const fs = require('fs');
const path = require('path');

const B = process.env.TSI_BASE || 'http://127.0.0.1:8788';
const root = path.resolve(__dirname, '..', '..');
const vars = Object.fromEntries(
  fs.readFileSync(path.join(root, '.dev.vars'), 'utf8')
    .split(/\r?\n/).filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const PW = vars.ADMIN_PASSWORD;
const NEW_PW = 'tsi-local-test-' + Math.random().toString(36).slice(2, 8);

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push('  PASS  ' + name); }
  else { fail++; results.push('  FAIL  ' + name + (detail ? '  → ' + String(detail).slice(0, 220) : '')); }
}

async function req(p, opts = {}) {
  const res = await fetch(B + p, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { res, text, json, status: res.status, headers: res.headers };
}
function cookieFrom(res) {
  const sc = res.headers.get('set-cookie') || '';
  const m = sc.match(/tsi_admin=[^;]*/);
  return m ? m[0] : '';
}
const J = { 'Content-Type': 'application/json' };

(async () => {
  /* ── public assets ── */
  let r = await req('/');
  check('GET / → 200 html', r.status === 200 && /text\/html/.test(r.headers.get('content-type') || ''), r.status);
  check('homepage includes storefront markers', r.text.includes('TSI') && r.text.includes('chk-ov'));
  check('homepage includes the product picker styles', r.text.includes('.pklist') && r.text.includes('.pkadd'));
  check('homepage loads content.json relatively (works under a sub-path)', r.text.includes("fetch('content.json'") && r.text.includes("fetch('data/products.json'"));

  r = await req('/data/products.json');
  check('GET /data/products.json → 200 json', r.status === 200 && (r.headers.get('content-type') || '').includes('json'), r.status);
  check('catalog has 12 products', r.json && Array.isArray(r.json.products) && r.json.products.length === 12);
  check('data files are revalidated (Cache-Control no-cache)', /no-cache/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control'));

  r = await req('/content.json');
  check('GET /content.json → 200 json with store settings', r.status === 200 && r.json && r.json.store && r.json.store.name, r.status);
  check('content.json carries the full settings schema', !!(r.json.theme && r.json.faq && r.json.ordering && r.json.shop && r.json.about && r.json.footer));

  r = await req('/admin/');
  check('GET /admin/ → 200 html', r.status === 200 && (r.headers.get('content-type') || '').includes('html'), r.status);
  check('admin has Settings + Security tabs', r.text.includes('data-tab="settings"') && r.text.includes('data-tab="security"') && r.text.includes('panel-security'));

  for (const secretPath of ['/wrangler.toml', '/worker/src/index.js', '/README.md', '/DEPLOYMENT.md', '/.dev.vars', '/.assetsignore', '/.gitignore', '/.gitattributes']) {
    r = await req(secretPath);
    check('NOT public: ' + secretPath + ' → 404', r.status === 404, r.status);
  }
  r = await req('/file/products/README.txt');
  check('public folder file still served', r.status === 200, r.status);
  r = await req('/api/nope');
  check('unknown api → 404 json', r.status === 404 && r.json && r.json.ok === false, r.status);

  /* ── auth ── */
  r = await req('/api/admin/status');
  check('admin status without a session → 401', r.status === 401, r.status);
  r = await req('/api/admin/login', { method: 'POST', headers: J, body: JSON.stringify({ password: 'definitely-wrong' }) });
  check('wrong password → 401', r.status === 401, r.status);
  r = await req('/api/admin/login', { method: 'POST', headers: { ...J, Origin: 'https://evil.example' }, body: JSON.stringify({ password: PW }) });
  check('login from a foreign origin → 403', r.status === 403, r.status);

  r = await req('/api/admin/login', { method: 'POST', headers: J, body: JSON.stringify({ password: PW }) });
  const cookie = cookieFrom(r.res);
  const sc = r.res.headers.get('set-cookie') || '';
  check('correct password → 200 + session cookie', r.status === 200 && !!cookie, r.status + ' ' + sc.slice(0, 40));
  check('cookie is HttpOnly + SameSite=Strict', /HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc), sc);

  r = await req('/api/admin/status', { headers: { Cookie: cookie } });
  check('status with session → 200', r.status === 200 && r.json && r.json.ok === true, r.status);
  check('status reports KV password store bound', r.json && r.json.canChangePassword === true);
  check('status reports the correct repo', r.json && r.json.repo === (vars.GITHUB_OWNER + '/' + vars.GITHUB_REPO + '@' + vars.GITHUB_BRANCH), r.json && r.json.repo);
  check('status flags the deliberately-bad GitHub token', r.json && r.json.publishing === 'invalid-token' && r.json.canPublish === false, r.json && r.json.publishing);

  /* ── admin write paths (dummy GitHub token on purpose) ── */
  r = await req('/api/admin/catalog', { method: 'PUT', headers: J, body: JSON.stringify({ products: [] }) });
  check('catalog write without a session → 401', r.status === 401, r.status);

  r = await req('/api/admin/catalog', { method: 'PUT', headers: { ...J, Cookie: cookie }, body: JSON.stringify({ products: [{ id: 'x', name: 'no price' }] }) });
  check('invalid product is rejected with 400 before any GitHub call', r.status === 400, r.status + ' ' + (r.json && r.json.error));

  r = await req('/api/admin/catalog', { method: 'PUT', headers: { ...J, Cookie: cookie }, body: JSON.stringify({ products: [{ id: 'p1', name: 'A', brand: 'B', category: 'makeup', price: 10, image: 'https://x/y.jpg' }] }) });
  check('valid product with a bad token surfaces a clear GitHub error (503)', r.status === 503 && /GITHUB_TOKEN/.test(r.json.error || ''), r.status + ' ' + (r.json && r.json.error));

  r = await req('/api/admin/catalog', { method: 'PUT', headers: { ...J, Cookie: cookie, Origin: 'https://evil.example' }, body: JSON.stringify({ products: [] }) });
  check('catalog write from a foreign origin → 403', r.status === 403, r.status);

  r = await req('/api/admin/content', { headers: { Cookie: cookie } });
  check('content read reports the token problem honestly (503)', r.status === 503 && /GITHUB_TOKEN/.test(r.json.error || ''), r.status + ' ' + (r.json && r.json.error));

  r = await req('/api/admin/files', { headers: { Cookie: cookie } });
  check('media list reports the token problem honestly (503)', r.status === 503, r.status);

  r = await req('/api/admin/verify', { headers: { Cookie: cookie } });
  check('verify endpoint answers with an honest live=false', r.status === 200 && r.json && r.json.ok === true && r.json.live === false, JSON.stringify(r.json));

  r = await req('/api/admin/upload', { method: 'POST', headers: { ...J, Cookie: cookie }, body: JSON.stringify({ dir: 'products', name: 'x.txt', dataUrl: 'data:text/plain;base64,aGk=' }) });
  check('upload rejects a non-image payload → 400', r.status === 400, r.status);
  r = await req('/api/admin/upload', { method: 'POST', headers: { ...J, Cookie: cookie }, body: JSON.stringify({ dir: '../../etc', name: 'x.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }) });
  check('upload rejects a traversal folder → 400', r.status === 400, r.status);
  r = await req('/api/admin/file', { method: 'DELETE', headers: { ...J, Cookie: cookie }, body: JSON.stringify({ path: '../../wrangler.toml' }) });
  check('delete rejects a non-allowlisted path → 400', r.status === 400, r.status);

  /* ── password change ── */
  r = await req('/api/admin/password', { method: 'POST', headers: J, body: JSON.stringify({ current: PW, next: NEW_PW }) });
  check('password change without a session → 401', r.status === 401, r.status);

  r = await req('/api/admin/password', { method: 'POST', headers: { ...J, Cookie: cookie }, body: JSON.stringify({ current: 'wrong-current', next: NEW_PW }) });
  check('password change with a wrong current password → 401', r.status === 401, r.status);

  r = await req('/api/admin/password', { method: 'POST', headers: { ...J, Cookie: cookie }, body: JSON.stringify({ current: PW, next: 'short' }) });
  check('password change with a too-short password → 400', r.status === 400, r.status);

  r = await req('/api/admin/password', { method: 'POST', headers: { ...J, Cookie: cookie }, body: JSON.stringify({ current: PW, next: NEW_PW }) });
  check('password change with a valid new password → 200', r.status === 200 && r.json.ok === true, r.status + ' ' + (r.json && r.json.error));

  r = await req('/api/admin/status', { headers: { Cookie: cookie } });
  check('changing the password invalidates the previous session → 401', r.status === 401, r.status);

  r = await req('/api/admin/login', { method: 'POST', headers: J, body: JSON.stringify({ password: NEW_PW }) });
  check('new password works (KV overrides the secret)', r.status === 200, r.status);
  const cookie2 = cookieFrom(r.res);

  r = await req('/api/admin/login', { method: 'POST', headers: J, body: JSON.stringify({ password: PW }) });
  check('old password no longer works after the change', r.status === 401, r.status);

  r = await req('/api/admin/status', { headers: { Cookie: cookie2 } });
  check('status reports the password now comes from KV', r.json && r.json.passwordFromKv === true);

  r = await req('/api/admin/logout', { method: 'POST', headers: { Cookie: cookie2 } });
  const clearCookie = r.res.headers.get('set-cookie') || '';
  check('logout clears the session cookie (Max-Age=0)', r.status === 200 && /tsi_admin=;/.test(clearCookie) && /Max-Age=0/.test(clearCookie), clearCookie);
  r = await req('/api/admin/status', { headers: { Cookie: 'tsi_admin=' } });
  check('a cleared/absent cookie is not authenticated → 401', r.status === 401, r.status);
  r = await req('/api/admin/status', { headers: { Cookie: 'tsi_admin=not.a-real.token' } });
  check('a forged session cookie → 401', r.status === 401, r.status);

  /* ── orders ── */
  const goodOrder = { ref: 'TSI-TEST', name: 'Test Buyer', phone: '0911695289', city: 'Addis Ababa', address: 'Bole', items: [{ name: 'Serum', brand: 'GlowLab', qty: 2, unitPrice: 1000 }] };
  r = await req('/api/order', { method: 'POST', headers: J, body: JSON.stringify({ ...goodOrder, name: '' }) });
  check('order without a name → 400', r.status === 400, r.status);
  r = await req('/api/order', { method: 'POST', headers: J, body: JSON.stringify({ ...goodOrder, phone: '123' }) });
  check('order with a bad phone → 400', r.status === 400, r.status);
  r = await req('/api/order', { method: 'POST', headers: J, body: JSON.stringify({ ...goodOrder, items: [] }) });
  check('order without items → 400', r.status === 400, r.status);
  r = await req('/api/order', { method: 'POST', headers: J, body: JSON.stringify({ ...goodOrder, website: 'bot' }) });
  check('honeypot order is silently accepted', r.status === 200 && r.json.ok === true, r.status);
  r = await req('/api/order', { method: 'POST', headers: J, body: JSON.stringify(goodOrder) });
  check('valid order reports the missing Telegram config honestly (503)', r.status === 503, r.status + ' ' + (r.json && r.json.error));

  r = await req('/api/order', { method: 'OPTIONS', headers: { Origin: 'https://m1616d.github.io' } });
  check('CORS preflight from the GitHub Pages mirror → 204 + allow-origin', r.status === 204 && r.headers.get('access-control-allow-origin') === 'https://m1616d.github.io', r.status + ' ' + r.headers.get('access-control-allow-origin'));
  r = await req('/api/order', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  check('CORS preflight from a foreign origin gets no allow-origin', r.status === 204 && !r.headers.get('access-control-allow-origin'), r.status + ' ' + r.headers.get('access-control-allow-origin'));
  r = await req('/api/order', { method: 'POST', headers: { ...J, Origin: 'https://m1616d.github.io' }, body: JSON.stringify({ ...goodOrder, phone: 'x' }) });
  check('mirror order gets CORS headers on the error response', r.headers.get('access-control-allow-origin') === 'https://m1616d.github.io', r.headers.get('access-control-allow-origin'));

  console.log(results.join('\n'));
  console.log('\n' + pass + ' passed, ' + fail + ' failed  (' + (pass + fail) + ' assertions)');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('HARNESS ERROR: ' + e.stack); process.exit(1); });
