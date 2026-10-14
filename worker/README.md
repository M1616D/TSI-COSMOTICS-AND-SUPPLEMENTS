# `worker/` — server-side code

Everything in this folder is **never served publicly**. `.assetsignore` in the
repository root excludes this whole directory from the Cloudflare asset upload, so
browsing to `/worker/src/index.js` on the live site returns 404 (verified).

| File | What it is |
|---|---|
| `src/index.js` | The one Worker: storefront assets, `/api/order`, `/api/admin/*`, GitHub publishing |
| `test/api-test.js` | Local API test battery (59 assertions) — see README §8 |
| `.dev.vars.example` | Template for the local secrets file |
| `wrangler.toml.legacy` | The old standalone `tsi-order-worker` config, kept for reference only |

The active configuration is the **root** `wrangler.toml`, which deploys from the
repository root:

```cmd
cd "C:\Users\HP\Downloads\TSI COSMETICS"
npx wrangler deploy
```

Do **not** run `wrangler` from inside this folder — `wrangler.toml.legacy` is
deliberately named `.legacy` so it cannot be picked up and deployed as a second
worker.

## What `src/index.js` does

1. **`POST /api/order`** — validates the order (name, Ethiopian phone, city, address,
   items, length caps, honeypot), then sends a formatted message to Telegram.
   Cross-origin POSTs are allowed only for the origins in `ALLOWED_ORIGINS`, which is
   what lets the GitHub Pages mirror submit orders.
2. **`/api/admin/*`** — HMAC-signed session cookie (`SESSION_SECRET`), 8-hour expiry,
   login throttling, `Origin` checks on mutations, and a write allow-list of exactly
   `data/products.json`, `content.json` and `file/{products,brands,gallery}/<file>`.
3. **`POST /api/admin/password`** — verifies the current password, stores the new one
   as a PBKDF2 hash in `ADMIN_KV`, and bumps the session epoch so old cookies die.
4. **`GET /api/admin/status`** — reports the truth about what is configured: whether
   GitHub publishing works, whether Telegram is configured, whether the KV store is
   bound, and where the password comes from.
5. **`GET /api/admin/verify`** — compares the catalog served by the live site with the
   catalog in the repo, so "live" means live.
6. **Static assets** — anything else is served from the repository root, with
   `Cache-Control: no-cache` for HTML and JSON so admin edits appear immediately.
