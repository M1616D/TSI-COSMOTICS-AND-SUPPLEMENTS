# TSI Cosmetics — one Worker, storefront + secure admin + Telegram ordering

A single Cloudflare Worker (`tsicosmeticsandsupplements`) serves the public
storefront, the private admin panel, the Telegram order endpoint, and the
authenticated admin API. The catalog and **all content live in this GitHub repo** —
there is no database. The admin panel edits them and commits the change to GitHub;
Cloudflare Workers Builds then deploys automatically.

Live site: <https://tsicosmeticsandsupplements.bereket1515mamuye.workers.dev>
Repo: <https://github.com/M1616D/TSI-COSMOTICS-AND-SUPPLEMENTS>

---

## 1. Final project structure

```
TSI COSMETICS/
├── wrangler.toml               ← the ONE Worker config (deploy from here)
├── .dev.vars                   ← local secrets only (git-ignored)
├── .gitignore
├── README.md                   ← this file
├── DEPLOYMENT.md               ← deploy / rollback / retire-old-worker runbook
├── site/                       ← everything in here is PUBLIC static assets
│   ├── index.html              ← storefront + checkout (single page, no order.html)
│   ├── content.json            ← editable announcement + hero text
│   ├── admin/
│   │   └── index.html          ← private admin panel UI
│   ├── data/
│   │   └── products.json       ← product catalog + brands (the "database")
│   └── file/
│       ├── products/           ← uploaded product photos
│       ├── brands/
│       └── gallery/
└── worker/                     ← server-side code (never served as assets)
    ├── src/index.js            ← the combined Worker
    ├── README.md
    ├── .dev.vars.example
    └── wrangler.toml.legacy    ← old separate order-worker config (reference only)
```

There are exactly **two HTML files**: `site/index.html` (storefront) and
`site/admin/index.html` (admin). The old `order.html` is gone — checkout is now a
section inside `index.html`, so the customer never leaves the main site.

## 2. Routing

| Path | Who handles it |
|---|---|
| `/` | storefront (`site/index.html`) |
| `/admin/` | admin panel (login required to do anything) |
| `/data/products.json`, `/content.json`, `/file/…` | public static assets |
| `POST /api/order` | Worker → validated → Telegram |
| `/api/admin/*` | Worker → session-authenticated admin API |

`wrangler.toml` sets `run_worker_first = ["/api/*"]`: API requests reach the Worker,
everything else is served straight from Cloudflare's static layer.

The storefront posts to `window.location.origin + '/api/order'` — same origin, no
hard-coded external Worker URL anywhere.

---

## 3. One-time setup

### 3.1 GitHub personal access token (for automatic publishing)

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Repository access: **Only select repositories → M1616D/TSI-COSMOTICS-AND-SUPPLEMENTS**.
3. Permissions → Repository permissions → **Contents: Read and write**. Nothing else.
4. Generate and copy the token. Treat it like a password.

### 3.2 Cloudflare — connect the Worker to this repo (automatic deploys)

1. Push this project to the repo above (branch `main`).
2. Cloudflare dashboard → **Workers & Pages → tsicosmeticsandsupplements → Settings → Builds → Connect to Git**.
3. Select the repo and branch `main`.
4. Build settings: **no build command**, deploy command `npx wrangler deploy` (Wrangler
   reads the root `wrangler.toml`). Root directory: repository root.
5. Save. From now on every commit to `main` triggers a deploy.

### 3.3 Required secrets — names and placeholders only

Set every one of these in Cloudflare: **Worker → Settings → Variables and Secrets → Add → Secret**,
or from a terminal with `npx wrangler secret put <NAME>`.

| Secret name | Placeholder value | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `1234567890:AAA...your-bot-token` | sends order notifications |
| `TELEGRAM_OWNER_CHAT_ID` | `000000000` | your Telegram user id |
| `GITHUB_TOKEN` | `github_pat_xxxxxxxxxxxx` | commits catalog/content/image changes |
| `ADMIN_PASSWORD` | `choose-a-strong-password` | admin panel login |
| `SESSION_SECRET` | `a-long-random-32+-char-string` | signs the admin session cookie |

Non-secret variables (already in `wrangler.toml`): `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`.

**Never** put any of these values in `site/`, in this README, or in git. Real values
belong only in Cloudflare secrets (production) and `.dev.vars` (local, git-ignored).

---

## 4. Run it locally (Windows)

Prerequisite: Node.js 18+ (this project was tested on Node 26).

```cmd
cd "C:\Users\HP\Downloads\TSI COSMETICS"

rem 1. Local secrets (copy the template, then edit it)
copy worker\.dev.vars.example .dev.vars
notepad .dev.vars

rem 2. Start the Worker + site + local static assets
npx wrangler dev --port 8788

rem 3. Open http://127.0.0.1:8788/        (storefront)
rem         http://127.0.0.1:8788/admin/  (admin panel)
```

Change the cache / force a clean start with `npx wrangler dev --port 8788 --ip 127.0.0.1`.

> Local note: over plain `http://` the session cookie omits the `Secure` flag so login
> works on localhost. In production (https) the cookie is always `HttpOnly; Secure; SameSite=Strict`.

## 5. Deploying

```cmd
npx wrangler deploy
```

and set/rotate secrets the same way:

```cmd
npx wrangler secret put ADMIN_PASSWORD
```

## 6. Using the admin panel

Sign in at `/admin/` with `ADMIN_PASSWORD`. Three tabs:

- **Products** — add, edit, duplicate, hide/publish, delete (with confirmation),
  search, filter by category, sort, and reorder up/down. Each product keeps a stable
  `id`, so renaming a product never breaks a cart or an existing order.
- **Media** — drag-and-drop or choose images (PNG/JPEG/WEBP/GIF/AVIF, ≤ ~6 MB each).
  Images are committed to `site/file/products|brands|gallery/`. You can copy a path,
  assign it to a product (via *Pick from library* in the product form), and delete —
  deletion is **refused while a product still references the image** unless you
  explicitly confirm a forced delete.
- **Content** — the announcement bar and hero text.

### How automatic publishing works

Every save commits a change to this GitHub repo. Cloudflare Workers Builds notices the
commit and redeploys the Worker automatically — you never edit files or redeploy by
hand for routine product changes. The panel is deliberately honest about this: it
shows the **commit link** and a **Check live site** button that re-fetches the live
`/data/products.json` from the site origin. If a build fails, nothing is reported as
"live" and the previous working site keeps serving — the commit simply sits on `main`
until the build is fixed.

---

## 7. Security model

- The admin session is an HMAC-signed cookie (`SESSION_SECRET`), `HttpOnly`,
  `Secure`, `SameSite=Strict`, 8-hour expiry. All `/api/admin/*` routes (except
  login/logout) return **401** without a valid cookie.
- Login is throttled after repeated failures, and wrong passwords are rejected after
  a deliberate delay.
- Cookie-authenticated mutations reject cross-origin requests (`Origin` check).
- The admin API may only write to an explicit allow-list of paths
  (`site/data/products.json`, `site/content.json`, `site/file/{products,brands,gallery}/<file>`).
  Path traversal and writes to `worker/`, `wrangler.toml`, etc. are rejected.
- Uploads are validated by MIME type and size, and filenames are sanitised.
- Order input is validated and length-capped server-side; a honeypot catches bots.
- **No secret is ever sent to the browser.** Tokens live only in Worker secrets.

---

## 8. Test checklist

Legend: ✅ passed · ❌ failed · ⚠️ not tested here (needs live credentials / a real order)

| # | Check | Result |
|---|---|---|
| 1 | Main homepage returns HTML and displays correctly | ✅ passed (local `wrangler dev`) |
| 2 | CSS, JS, fonts, icons, images load (no downloads) | ✅ passed (200s, no console errors) |
| 3 | Product search, categories, cart, quantity controls | ✅ passed |
| 4 | Checkout opens and preserves items/quantities | ✅ passed (cart survived; subtotal correct) |
| 5 | Form validation + customer consent | ✅ passed (all 5 errors shown; empty submit blocked) |
| 6 | Order reaches the owner's Telegram | ⚠️ not tested here (needs real bot token) |
| 7 | Storefront + API on one Worker origin | ✅ passed (`/api/order` same-origin) |
| 8 | Admin requests fail when unauthenticated | ✅ passed (401 on status/catalog/files/upload) |
| 9 | Only the owner can publish changes | ✅ passed (401 unauthenticated; 403 cross-origin) |
| 10 | Admin creates/edits a product | ✅ passed (UI + validation verified in browser) |
| 11 | Admin uploads/previews/replaces an image | ⚠️ upload path validated; live commit not tested (no real token) |
| 12 | Image delete blocked while referenced | ✅ passed (409 + forced-delete confirm) |
| 13 | Products/images saved to intended GitHub paths | ⚠️ not tested here (no real `GITHUB_TOKEN`) |
| 14 | Commit triggers Cloudflare auto-deploy | ⚠️ requires Workers Builds connected (owner action) |
| 15 | Admin shows honest publishing status | ✅ passed (commit link + live-check; failures reported) |
| 16 | Failed deploy does not report success | ✅ passed (errors surfaced, never "live") |
| 17 | GitHub + Telegram tokens absent from browser | ✅ passed (grep of served pages) |
| 18 | Unexpected paths cannot be written | ✅ passed (traversal + non-allowlisted → 400) |
| 19 | Checkout works during normal admin activity | ✅ passed (separate routes/credentials) |
| 20 | Desktop, tablet, mobile | ✅ passed (responsive CSS; desktop + narrow verified) |
| 21 | No critical JS errors / broken controls | ✅ passed (clean console) |
| 22 | No unintended file downloads | ✅ passed (correct content types) |

31 automated API assertions pass, plus browser checks of the storefront and admin.

## 9. What is done vs. what still needs you

**Done in the repository:** the integrated Worker, the merged single-page storefront
+ checkout, the admin panel with product/media/content management, the GitHub-backed
catalog, path/authorisation hardening, and this documentation.

**Still requires you (cannot be done from the repo):**
1. Set the five secrets in Cloudflare (§3.3).
2. Create the fine-grained GitHub token (§3.1).
3. Connect Workers Builds to this repo for automatic deploys (§3.2).
4. Run one real end-to-end test order to your Telegram (§8 row 6).
5. After that passes, retire the old worker (§`DEPLOYMENT.md`).

Nothing above is claimed as already configured or deployed unless you have done it.
