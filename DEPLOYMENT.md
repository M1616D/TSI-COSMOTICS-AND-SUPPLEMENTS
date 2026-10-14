# Deployment runbook — TSI Cosmetics

Setup, secret names and the test checklist live in [`README.md`](README.md). This file
covers **deploying, rolling back, automatic deploys and rotating secrets**.

---

## Current state (be precise about this)

- The Worker was **deployed to production on 2026-10-14** by this work, latest
  version `9754e88e-cccd-4f11-b024-adca5be0395a`, using the repo-root layout
  (`worker/src/index.js` + the repository root as static assets).
- Live URL: <https://tsicosmeticsandsupplements.bereket1515mamuye.workers.dev>
  — admin panel at `/admin/`. The URL did not change.
- Secrets present on the Worker: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`,
  `ADMIN_PASSWORD`, `SESSION_SECRET`, `GITHUB_TOKEN` (set 2026-10-14). The admin
  panel can therefore read and write the repository.
- **Open GitHub incident (2026-10-14).** The repository is reachable and writable
  through `https://api.github.com/repositories/1298297633`, but every path that uses
  the `M1616D/TSI-COSMETICS-AND-SUPPLEMENTS` **name** returns 404 — the REST API,
  `git` over HTTPS, `raw.githubusercontent.com` and GitHub Pages all fail, from more
  than one network. GitHub's own metadata (REST by id, GraphQL) still reports the
  repo as public, enabled and correctly named.

  Consequences while it lasts:

  1. `git push` / `git fetch` cannot reach the remote. To publish a change, use the
     admin panel (which addresses the repo by id) or the GitHub contents API with
     `GITHUB_REPO_ID`. `GITHUB_REPO_ID = "1298297633"` in `wrangler.toml` is what keeps
     the admin panel working; without it the panel reports *repo-not-found*.
  2. The GitHub Pages mirror at `https://M1616D.github.io/TSI-COSMETICS-AND-SUPPLEMENTS/`
     is down. The Cloudflare Worker is unaffected — it serves the storefront itself.

  This needs GitHub support to resolve; nothing in this repository can fix it.
- The `ADMIN_KV` KV namespace is created and bound
  (`f58ecd40eb2940f3b5798f9f141dcc74`); it stores the admin password hash and the
  session epoch.
- The old standalone worker `tsi-order-worker` is **untouched**. The main worker
  handles `/api/order` on the same origin, so nothing points at the old one.

---

## 1. Deploy

```cmd
cd "C:\Users\HP\Downloads\TSI COSMETICS"

rem Optional: preview locally first (see README §7 for why --persist-to is needed)
npx wrangler dev --port 8788 --ip 127.0.0.1 --persist-to "%TEMP%\tsi-dev-state"

rem Deploy
npx wrangler deploy
```

Verify after deploying:

```cmd
curl -I https://tsicosmeticsandsupplements.bereket1515mamuye.workers.dev/
curl -s https://tsicosmeticsandsupplements.bereket1515mamuye.workers.dev/content.json | head
curl -o /dev/null -w "%{http_code}\n" https://tsicosmeticsandsupplements.bereket1515mamuye.workers.dev/wrangler.toml
```

The last one must print **404** — it proves `.assetsignore` is still keeping source and
secrets out of the public asset upload. Check `.dev.vars` and `/worker/src/index.js`
the same way.

## 2. Automatic deploys (admin save → live site)

Connect the repository once:

1. Cloudflare → **Workers & Pages → tsicosmeticsandsupplements → Settings → Builds → Connect to Git**.
2. Repository `M1616D/TSI-COSMOTICS-AND-SUPPLEMENTS`, branch `main`.
3. No build command; deploy command `npx wrangler deploy`; root directory = repository root.

After that, every admin save commits to `main` and Cloudflare redeploys within about a
minute. If a build fails, the previous working version keeps serving and the admin
panel never reports the change as "live" (its **Check Live Site** compares the live
catalog with the repo and only says yes when they match).

## 3. Rollback

**Fastest:** Cloudflare → the Worker → **Deployments** → pick the last good version →
**Rollback**. Traffic switches immediately; nothing is rebuilt.

**From git:** revert the offending commit and push; Workers Builds redeploys the
previous state.

```cmd
git revert <commit-sha>
git push origin main
```

Admin saves are normal commits, so a single bad catalog edit can be reverted on its own.

## 4. Rotating a secret or the admin password

| What | How |
|---|---|
| Admin password (normal way) | Admin panel → **Security → Change Admin Password**. Stored as a PBKDF2 hash in `ADMIN_KV`; all existing sessions are signed out. |
| Admin password (if locked out) | `npx wrangler secret put ADMIN_PASSWORD`, then delete the KV entry: `npx wrangler kv key delete admin_password --namespace-id f58ecd40eb2940f3b5798f9f141dcc74` (the secret becomes active again). |
| `TELEGRAM_BOT_TOKEN` | BotFather → `/revoke` → new token → `npx wrangler secret put TELEGRAM_BOT_TOKEN` |
| `GITHUB_TOKEN` | GitHub → revoke the old token → create a new fine-grained token (Contents: Read and write) → `npx wrangler secret put GITHUB_TOKEN` |
| `SESSION_SECRET` | `npx wrangler secret put SESSION_SECRET` — immediately invalidates every admin session |

`wrangler secret put` takes effect immediately; a redeploy is not required.

## 5. KV namespace

```cmd
rem list namespaces
npx wrangler kv namespace list

rem inspect the stored password hash / epoch
npx wrangler kv key list --namespace-id f58ecd40eb2940f3b5798f9f141dcc74
```

Keys used: `admin_password` (PBKDF2 hash) and `session_epoch` (integer). If the
namespace is missing, the panel cannot change passwords and says so; logins keep
working off the `ADMIN_PASSWORD` secret.

## 6. Retiring the old `tsi-order-worker`

Only after a real order has been delivered by this Worker.

1. Place a test order on the live site and confirm the Telegram message arrives.
2. Confirm nothing points at the old worker (the storefront posts to
   `window.location.origin + '/api/order'`).
3. Cloudflare → Workers & Pages → `tsi-order-worker` → **Unpublish** it. Keep it that
   way for a week before deleting — unpublishing is reversible in seconds.
4. If a route pointed `…/api/order` at the old worker, delete that route.

The old config is kept in-repo for reference at `worker/wrangler.toml.legacy`.

## 7. GitHub Pages mirror

The repository root is also the GitHub Pages site, so
<https://m1616d.github.io/TSI-COSMOTICS-AND-SUPPLEMENTS/> keeps working as a static
copy. Two things to know:

- Orders from the mirror are posted cross-origin to `store.siteUrl` in `content.json`.
  That origin must be listed in `ALLOWED_ORIGINS` in `wrangler.toml`.
- The admin panel must be used on the Worker URL — a cookie from `github.io` is never
  sent to `workers.dev`.

If you would rather not maintain the mirror, turn GitHub Pages off in the repository
settings; nothing else depends on it.
