/* Verifies the admin panel's GitHub publishing path end-to-end.
 *
 * Runs against a LOCAL `wrangler dev` server (default http://127.0.0.1:8788)
 * that has a real GITHUB_TOKEN in its .dev.vars, so every assertion below
 * exercises the same code path the live Worker runs — including real reads and
 * a real commit against the M1616D/TSI-COSMOTICS-AND-SUPPLEMENTS repo.
 *
 *   node worker/test/publish-test.js [baseUrl] [adminPassword]
 *
 * Exit code 0 = every check passed.
 */
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const PASSWORD = process.argv[3] || process.env.TSI_ADMIN_PASSWORD || 'tsi-local-dev-2026';
const LOCAL_CONTENT = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'content.json'), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

let cookie = '';
async function call(path, { method = 'GET', body, origin = BASE } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (origin) headers['Origin'] = origin;
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

(async () => {
  console.log(`\nPublishing path check against ${BASE} (real GitHub repo)\n`);

  /* 1. Auth ---------------------------------------------------------------- */
  console.log('Auth');
  const crossOrigin = await call('/api/admin/login', { method: 'POST', body: { password: PASSWORD }, origin: 'https://evil.example' });
  check('login from a foreign Origin is rejected (403)', crossOrigin.status === 403, `got ${crossOrigin.status}`);

  const badPw = await call('/api/admin/login', { method: 'POST', body: { password: 'definitely-wrong' } });
  check('wrong password is rejected (401)', badPw.status === 401, `got ${badPw.status}`);

  const login = await call('/api/admin/login', { method: 'POST', body: { password: PASSWORD } });
  check('correct password logs in (200)', login.status === 200 && login.json && login.json.ok === true, `got ${login.status}`);
  if (!cookie) { console.log('\nNo session cookie — aborting.\n'); process.exit(1); }

  const noAuth = await fetch(BASE + '/api/admin/status').then((r) => r.status);
  check('status without a session is 401', noAuth === 401, `got ${noAuth}`);

  /* 2. Status must tell the truth about publishing ------------------------- */
  console.log('\nStatus / configuration');
  const st = await call('/api/admin/status');
  const s = st.json || {};
  check('status returns 200', st.status === 200, `got ${st.status}`);
  check('publishing === "ok" (token really validated against GitHub)', s.publishing === 'ok', `got ${JSON.stringify(s.publishing)}`);
  check('canPublish === true', s.canPublish === true);
  check('repo points at the real repo and is addressed by id',
    String(s.repo).includes('M1616D/TSI-COSMETICS-AND-SUPPLEMENTS') && s.repoId === '1298297633',
    `got repo=${s.repo} repoId=${s.repoId}`);
  check('KV-backed password change available', s.canChangePassword === true);
  console.log(`        → repo=${s.repo} repoId=${s.repoId} telegram=${s.ordersConfigured}`);

  /* 3. Reading the repo through the admin API ------------------------------ */
  console.log('\nReading from GitHub through the Worker');
  const cat = await call('/api/admin/catalog');
  const products = (cat.json && Array.isArray(cat.json.products)) ? cat.json.products : null;
  check('catalog GET succeeds', cat.status === 200 && !!products, `status ${cat.status} ${cat.json && cat.json.error ? cat.json.error : ''}`);
  if (products) {
    console.log(`        → ${products.length} products read from GitHub: ${products.map((p) => p.id).join(', ')}`);
    check('catalog has products with ids and prices', products.every((p) => p && p.id && typeof p.price === 'number' && p.name));
  }

  const content = await call('/api/admin/content');
  const stored = content.json && content.json.content;
  check('content GET succeeds with a sha', content.status === 200 && !!content.json.sha, `status ${content.status}`);
  check('content carries the store settings block the storefront needs',
    !!(stored && stored.store && stored.store.name && stored.store.currency), `store=${JSON.stringify(stored && stored.store)}`);
  check('content carries the theme colour', !!(stored && stored.theme && stored.theme.primary));

  const files = await call('/api/admin/files');
  check('media file listing succeeds', files.status === 200 && Array.isArray(files.json.files), `status ${files.status}`);

  /* 4. Writing to the repo: a real commit --------------------------------- */
  console.log('\nWriting to GitHub through the Worker (creates a real commit)');
  if (stored) {
    const save = await call('/api/admin/content', { method: 'PUT', body: { content: stored } });
    check('content PUT succeeds (real commit created)', save.status === 200 && save.json && save.json.ok === true,
      `status ${save.status} ${save.json && save.json.error ? save.json.error : ''}`);
    if (save.json && save.json.commit) {
      console.log(`        → commit ${save.json.commit.slice(0, 10)}  ${save.json.commitUrl || ''}`);
      check('commit sha returned', /^[0-9a-f]{40}$/.test(save.json.commit));
      check('commit URL points at the real repo', String(save.json.commitUrl).includes('/M1616D/TSI-COSMOTICS-AND-SUPPLEMENTS/commit/'));
    } else {
      check('commit sha returned', false, 'no commit in response');
    }
  } else {
    check('content PUT succeeds (real commit created)', false, 'skipped — no stored content to write back');
  }

  /* 5. Write path is origin-guarded --------------------------------------- */
  const crossPut = await call('/api/admin/content', { method: 'PUT', body: { content: stored || {} }, origin: 'https://evil.example' });
  check('content PUT from a foreign Origin is rejected (403)', crossPut.status === 403, `got ${crossPut.status}`);

  /* 5b. A save must not alter a single value ------------------------------ */
  /* Regression guard: the template sanitiser used to cut anything deeper than
     three levels, which silently turned every faq.items[].q/.a into null on
     save. Round-trip the real content.json and compare value-for-value. */
  console.log('\nSave round-trip (no value may change)');
  const rtSave = await call('/api/admin/content', { method: 'PUT', body: { content: LOCAL_CONTENT } });
  check('full content.json saves', rtSave.status === 200 && rtSave.json && rtSave.json.ok === true,
    `status ${rtSave.status} ${rtSave.json && rtSave.json.error ? rtSave.json.error : ''}`);
  const rtRead = await call('/api/admin/content');
  const rtContent = rtRead.json && rtRead.json.content;
  const nulls = [];
  (function findNulls(v, p = '') {
    if (v === null) { nulls.push(p); return; }
    if (Array.isArray(v)) v.forEach((x, i) => findNulls(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') Object.keys(v).forEach((k) => findNulls(v[k], p ? `${p}.${k}` : k));
  })(rtContent);
  check('saved content contains no null fields', nulls.length === 0, nulls.length ? 'nulls at ' + nulls.slice(0, 6).join(', ') : '');
  check('saved content is value-for-value identical to content.json',
    JSON.stringify(rtContent) === JSON.stringify(LOCAL_CONTENT),
    JSON.stringify(rtContent) === JSON.stringify(LOCAL_CONTENT) ? '' : 'first difference between\n' + JSON.stringify(rtContent).slice(0, 200) + '\nand\n' + JSON.stringify(LOCAL_CONTENT).slice(0, 200));
  check('FAQ questions and answers survive the save',
    !!(rtContent && rtContent.faq && rtContent.faq.items && rtContent.faq.items.length === LOCAL_CONTENT.faq.items.length
      && rtContent.faq.items.every((it, i) => it.q === LOCAL_CONTENT.faq.items[i].q && it.a === LOCAL_CONTENT.faq.items[i].a)),
    JSON.stringify(rtContent && rtContent.faq && rtContent.faq.items && rtContent.faq.items[0]));

  /* 6. Publish verification ---------------------------------------------- */
  console.log('\nPublish verification');
  const verify = await call('/api/admin/verify');
  check('verify endpoint responds', verify.status === 200 && verify.json && verify.json.ok === true, `status ${verify.status}`);
  if (verify.json) {
    console.log(`        → live=${verify.json.live} idsMatch=${verify.json.idsMatch} contentLive=${verify.json.contentLive} products=${verify.json.productCount}`);
    check('verify actually compares the repo to the live site (idsMatch true)', verify.json.idsMatch === true, `detail: ${verify.json.detail}`);
  }

  /* 7. Safety rails -------------------------------------------------------- */
  console.log('\nSafety rails');
  const noSession = await fetch(BASE + '/api/admin/catalog').then((r) => r.status);
  check('catalog is not readable without a session (401)', noSession === 401, `got ${noSession}`);
  const badPath = await call('/api/admin/file', { method: 'DELETE', body: { path: '../../.git/config' } });
  check('path traversal in a delete is refused', badPath.status >= 400, `got ${badPath.status}`);
  const badJson = await call('/api/admin/catalog', { method: 'PUT', body: { garbage: true } });
  check('invalid catalog payload is refused', badJson.status >= 400, `got ${badJson.status}`);

  console.log(`\n${'-'.repeat(60)}\n${pass} passed, ${fail} failed\n`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nHarness error:', e); process.exit(1); });
