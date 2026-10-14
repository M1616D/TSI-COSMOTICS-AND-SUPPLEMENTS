# Deployment runbook — TSI Cosmetics

The build, structure, secret names and test checklist live in [`README.md`](README.md).
This file covers **deploying, rolling back, and retiring the old order Worker**.

---

## Current state (be precise about this)

- The integrated Worker is **implemented in this repo** and was verified locally with
  `wrangler dev` (31 API assertions + browser checks). It is **not yet deployed** by
  this work.
- The live site `https://tsicosmeticsandsupplements.bereket1515mamuye.workers.dev`
  is the existing deployment; this project's `wrangler.toml` uses the same Worker
  name, so deploying keeps the same URL.
- The old standalone worker `tsi-order-worker` — recorded as deployed and end-to-end
  tested on 2026-10-12 — **has not been touched**. Keep it until §4 is complete.

---

## 1. Deploy the integrated Worker (Windows)

```cmd
cd "C:\Users\HP\Downloads\TSI COSMETICS"

rem Build/type-check locally first (optional but recommended)
npx wrangler dev --port 8788
rem  → check http://127.0.0.1:8788/ and /admin/ , then Ctrl+C

rem Deploy (uses the root wrangler.toml → worker/src/index.js + ./site assets)
npx wrangler deploy
```

Then set the secrets once, if you have not already:

```cmd
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_OWNER_CHAT_ID
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
```

Verify after deploying:

```cmd
curl -I https://tsicosmeticsandsupplements.bereket1515mamuye.workers.dev/
curl -s https://tsicosmeticsandsupplements.bereket1515mamuye.workers.dev/data/products.json
```

…and in a browser: the homepage, `/admin/`, one test order, and one admin save.

## 2. Automatic publishing

Connect the Worker to this GitHub repo once (Cloudflare → Workers & Pages →
tsicosmeticsandsupplements → Settings → Builds → Connect to Git, branch `main`,
no build command, deploy `npx wrangler deploy`). After that, every admin save commits
to GitHub and Cloudflare redeploys automatically — no manual step.

## 3. Rollback

**Fastest — unpublish the new build:** Cloudflare dashboard → the Worker →
**Deployments** → pick the last good deployment → **Rollback**. Traffic returns to it
immediately; no rebuild needed.

**From git:** revert the offending commit and push. Workers Builds redeploys the
previous state.

```cmd
git revert <commit-sha>
git push origin main
```

Admin saves are normal commits on `main`, so they can be reverted individually —
for example to undo one bad catalog edit without losing unrelated changes.

**Last resort:** re-deploy a known-good commit locally with
`npx wrangler deploy --var ... ` from that checkout. Because all content lives in git,
`git revert` is almost always the right tool.

## 4. Retiring the old `tsi-order-worker` (only after §1 is verified)

Do **not** delete it before the combined `/api/order` has delivered a real test order.

1. Confirm the integrated endpoint works end-to-end: place a test order on the main
   site and confirm you receive the Telegram message (fake customer details only).
2. Confirm the storefront posts to `/api/order` on the **same** origin (it does — see
   `site/index.html`), so nothing points at the old worker anymore.
3. In Cloudflare → Workers & Pages → `tsi-order-worker` → **Settings**:
   - Option A (reversible): **Unpublish** / disable the Worker. It keeps its code and
     URL and can be re-enabled in seconds.
   - Option B: **Delete** it once you are confident. Prefer Option A for a week.
4. If a custom route pointed `…/api/order` at the old worker, remove that route so the
   request is handled by the main worker.

The old config is preserved in-repo as `worker/wrangler.toml.legacy` for reference.

## 5. Rotating a leaked secret

| Leaked | What to do |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather → `/revoke` → new token → `wrangler secret put TELEGRAM_BOT_TOKEN` |
| `GITHUB_TOKEN` | GitHub → revoke the PAT → create a new fine-grained token → `wrangler secret put GITHUB_TOKEN` |
| `ADMIN_PASSWORD` | `wrangler secret put ADMIN_PASSWORD` (all sessions keep working until they expire; rotate `SESSION_SECRET` to force everyone out) |
| `SESSION_SECRET` | `wrangler secret put SESSION_SECRET` — this immediately invalidates every existing admin session |

Deploy is not required after `wrangler secret put`; secrets take effect immediately.
