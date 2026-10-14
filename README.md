# TSI Cosmetics — storefront + secure admin + Telegram ordering

One Cloudflare Worker serves everything: the public storefront, the private admin
panel, the Telegram order endpoint and the authenticated admin API. The catalog and
**all site text/settings live in this GitHub repo** — there is no database. The admin
panel edits them and commits the change to GitHub; Cloudflare Workers Builds then
redeploys automatically.

| | |
|---|---|
| **Live site** | <https://tsicosmeticsandsupplements.bereket1515mamuye.workers.dev> |
| **Admin panel** | <https://tsicosmeticsandsupplements.bereket1515mamuye.workers.dev/admin/> |
| **Repository** | <https://github.com/M1616D/TSI-COSMOTICS-AND-SUPPLEMENTS> |
| **GitHub Pages mirror** | <https://m1616d.github.io/TSI-COSMOTICS-AND-SUPPLEMENTS/> |

> **Read §1 first.** The admin panel cannot save anything until the `GITHUB_TOKEN`
> secret exists on the Worker — the Security tab says so explicitly.

---

## 1. Before you can edit your site: add `GITHUB_TOKEN`

The admin panel publishes by committing to GitHub, so it needs a token with write
access to this repository.

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Repository access: **Only select repositories** → `M1616D/TSI-COSMOTICS-AND-SUPPLEMENTS`.
3. Repository permissions → **Contents: Read and write**. Nothing else. (Metadata: Read is added automatically.)
4. Copy the token (it looks like `github_pat_…`).
5. Cloudflare dashboard → **Workers & Pages → tsicosmeticsandsupplements → Settings → Variables and Secrets → Add → Secret**, name `GITHUB_TOKEN`, paste the value, save.
6. Open the admin panel → **Security** tab → **Refresh**. "Publishing connected" should now be green. No redeploy is needed.

If the Security tab says **GitHub token rejected**, the token has expired, was
revoked, or lacks *Contents: Read and write* — create a new one and repeat step 5.

---

## 2. Admin login and password

- **Sign in at** <https://tsicosmeticsandsupplements.bereket1515mamuye.workers.dev/admin/>
- **The password is the `ADMIN_PASSWORD` secret** you set in Cloudflare
  (Worker → Settings → Variables and Secrets). It is not stored in this repo and
  cannot be read back out of Cloudflare — if you have forgotten it, set a new one
  with `npx wrangler secret put ADMIN_PASSWORD` and use that.
- **Change it without touching Cloudflare:** admin panel → **Security → Change Admin Password**.
  The new password is stored as a salted PBKDF2 hash (150,000 iterations) in the
  `ADMIN_KV` KV namespace and takes priority over the secret from then on.
  You are signed out immediately and must sign in again with the new one.

Password storage precedence: **KV hash → `ADMIN_PASSWORD` secret**. So you can start
with the secret and move to the KV hash the first time you change the password in the panel.

> Local development uses `.dev.vars` (git-ignored). Its password is **`localtest1234`**
> and only affects `http://127.0.0.1:8788` — never the live site.

---

## 3. Project structure

The public site lives at the **repository root** so that the same repo also works as
a static GitHub Pages mirror. `wrangler.toml` serves that whole directory as static
assets, minus everything listed in `.assetsignore`.

```
TSI COSMETICS/                    ← deployed root; the public site
├── wrangler.toml                 ← the ONE Worker config (deploy from here)
├── .assetsignore                 ← keeps source + secrets OUT of the public upload
├── .gitignore                    ← keeps local secrets out of git
├── .dev.vars                     ← local secrets only (never in git, never served)
├── index.html                    ← storefront + merged checkout (no order.html)
├── content.json                  ← ALL editable text + settings
├── admin/index.html              ← private admin panel
├── data/products.json            ← product catalog + brands (the "database")
├── file/{products,brands,gallery}/  ← uploaded images
├── worker/src/index.js           ← the Worker (API, admin API, Telegram, publishing)
└── README.md, DEPLOYMENT.md      ← docs (not served — see .assetsignore)
```

There are exactly **two HTML files**: `index.html` and `admin/index.html`.

`.assetsignore` is important: it prevents `worker/`, `wrangler.toml`, `README.md`,
`DEPLOYMENT.md`, `.dev.vars`, `.wrangler/` and `.git/` from being publicly
downloadable. Verified live (2026-10-14): all of those return 404.

## 4. Routing

| Path | Handled by |
|---|---|
| `/` | storefront (`index.html`) |
| `/admin/` | admin panel (login required) |
| `/data/products.json`, `/content.json`, `/file/…` | static assets, revalidated (`Cache-Control: no-cache`) |
| `POST /api/order` | Worker → validated → Telegram |
| `/api/admin/*` | Worker → session-authenticated admin API |

`run_worker_first = ["/api/*", "/data/*", "/content.json"]` sends those paths through
the Worker (so caching headers can be controlled); everything else is served straight
from Cloudflare's static asset layer.

## 5. Required secrets and variables

Set these as **secrets** (Cloudflare → Worker → Settings → Variables and Secrets, or
`npx wrangler secret put <NAME>`):

| Secret | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | sends order notifications |
| `TELEGRAM_OWNER_CHAT_ID` | your Telegram user id |
| `GITHUB_TOKEN` | commits catalog/content/image changes — **required for the admin to work** |
| `ADMIN_PASSWORD` | bootstrap admin password |
| `SESSION_SECRET` | signs the admin session cookie |

Non-secret variables, already in `wrangler.toml`: `GITHUB_OWNER`, `GITHUB_REPO`,
`GITHUB_BRANCH`, `GITHUB_REPO_ID`, `ALLOWED_ORIGINS`.

`GITHUB_REPO_ID` (`1298297633`) makes the Worker address the repository as
`api.github.com/repositories/<id>` instead of `/repos/{owner}/{repo}`. GitHub documents
these as equivalent — the id form accepts the same contents/refs paths and methods —
and it keeps working when the name is renamed. It matters right now because the
owner/name path for this repository currently 404s on every public route (API, `git`,
`raw.githubusercontent.com`, GitHub Pages) while the id form works; see the incident
note at the top of [`DEPLOYMENT.md`](DEPLOYMENT.md). Remove the variable to go back to
name-based addressing.

Bindings in `wrangler.toml`: `ASSETS` (static files) and `ADMIN_KV`
(the password hash + session epoch).

## 6. Automatic publishing (admin → GitHub → Cloudflare)

Every save in the admin panel commits to this repo through the GitHub API. To make
Cloudflare redeploy automatically on that commit:

1. Cloudflare dashboard → **Workers & Pages → tsicosmeticsandsupplements → Settings → Builds → Connect to Git**.
2. Choose this repository, branch `main`.
3. Build settings: **no build command**, deploy command `npx wrangler deploy`,
   root directory = repository root.
4. Save.

After that, an admin save is live about a minute later, with no manual step. The
admin panel is honest about it: it shows the **commit link**, and **Check Live Site**
compares the catalog served by the live site with the catalog in the repo — it only
reports "live" when they are identical.

## 7. Local development (Windows)

```cmd
cd "C:\Users\HP\Downloads\TSI COSMETICS"

rem 1. Local secrets (only needed once)
copy worker\.dev.vars.example .dev.vars
notepad .dev.vars

rem 2. Start the Worker + site
npx wrangler dev --port 8788 --ip 127.0.0.1 --persist-to "..\tsi-dev-state"
```

Open <http://127.0.0.1:8788/> and <http://127.0.0.1:8788/admin/> (password `localtest1234`).

**`--persist-to` is required here.** The assets directory is the repository root, so
Wrangler's own local state files (`.wrangler/state`) would otherwise sit inside the
watched folder and trigger an endless reload loop ("Reloading local server…" forever,
and the port never opens). Pointing the state outside the project, as above, fixes it.

To reset the local password back to `.dev.vars` (`localtest1234`), delete the local
state folder (`..\tsi-dev-state`).

## 8. Testing

`npx wrangler dev` was run against a **fresh** KV state and a 59-assertion API battery
was executed against it — all 59 pass. Re-run it with:

```cmd
npx wrangler dev --port 8788 --ip 127.0.0.1 --persist-to "%TEMP%\tsi-test-state"
node worker\test\api-test.js
```

What the battery covers: static asset content types, that source/secrets are **not**
public, catalog + content JSON shape, `Cache-Control`, login (wrong password, foreign
`Origin`, correct password), cookie flags, admin 401s, input validation happening
*before* any GitHub call, honest GitHub errors, upload/delete path validation,
password change + session invalidation, order validation + honeypot, and CORS
preflight for the mirror.

Browser checks (local): checkout overlay sits above the navbar, the order panel lists
all products when the cart is empty, multi-item line amounts and totals, admin login,
all five tabs, the honest config banner, settings form mapping, theme preview,
password change and forced re-sign-in.

Live checks (deployed): `/`, `/admin/`, `/content.json`, `/data/products.json` return
200 with correct types; `/wrangler.toml`, `/worker/src/index.js`, `README.md`,
`DEPLOYMENT.md`, `.dev.vars`, `.git/`, `.wrangler/` return 404; `/api/admin/status` is
401 unauthenticated; `/api/order` rejects a bad phone with 400; the cross-origin
preflight from `https://m1616d.github.io` is allowed; and one real test order was
delivered to the owner's Telegram (confirming the live order path end-to-end).

## 9. GitHub Pages mirror (optional)

The repo root is also a working static copy of the storefront, so
<https://m1616d.github.io/TSI-COSMOTICS-AND-SUPPLEMENTS/> keeps working.

- It fetches `data/products.json` and `content.json` **relatively**, so it works both
  at the domain root (Worker) and under the `/TSI-COSMOTICS-AND-SUPPLEMENTS/` sub-path
  (GitHub Pages).
- GitHub Pages cannot run the order API, so on a `github.io` host the storefront sends
  orders to the origin in `content.json → store.siteUrl`. `ALLOWED_ORIGINS` in
  `wrangler.toml` authorises that one origin for cross-origin POSTs.
- The admin panel **must** be used on the Worker URL: a session cookie set on
  `github.io` would never be sent to `workers.dev`.

## 10. Security model

- Admin sessions are HMAC-signed cookies (`SESSION_SECRET`): `HttpOnly`,
  `SameSite=Strict`, `Secure` on https, 8-hour expiry.
- **A password change bumps a session epoch stored in KV**, which invalidates every
  previously issued session cookie at once.
- Login and password changes are throttled per IP; wrong passwords are rejected after
  a deliberate delay.
- Cookie-authenticated mutations reject cross-origin requests (`Origin` check).
- The admin API can write to exactly three path patterns: `data/products.json`,
  `content.json`, `file/{products,brands,gallery}/<file>`. Path traversal and writes to
  `worker/`, `wrangler.toml`, etc. are rejected.
- Uploads are validated by MIME type and size (~6 MB) and filenames are sanitised.
- An image cannot be deleted while a product still references it (409) unless the
  owner explicitly forces it.
- Saved content is coerced to a fixed schema, so it cannot be oversized or inject markup.
- Order input is validated and length-capped server-side; a honeypot catches bots.
- No secret is ever sent to the browser, and no secret is served as a static asset.

## 11. What still needs the owner

1. **Add the `GITHUB_TOKEN` secret** (§1) — without it nothing can be saved.
2. **Connect Workers Builds** to the repo (§6) for automatic deploys.
3. **Change the admin password** in the Security tab if the current one has ever been
   shared or written down anywhere public.
4. `.dev.vars` was previously committed to this public repository. It has been removed
   from the repo, but treat any value that was in it as public: rotate the token and
   password if you reused them, and delete them from the file in your working copy.
5. Run the local battery (§8) after any future Worker change.
