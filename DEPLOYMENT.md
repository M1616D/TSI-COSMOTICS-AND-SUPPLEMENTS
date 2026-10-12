## DEPLOYMENT STATUS (completed)

- Worker deployed: `https://tsi-order-worker.bereket1515mamuye.workers.dev`
- Bot token: set as Cloudflare secret (not in source code)
- Chat ID: set as Cloudflare secret (not in source code)
- End-to-end test: PASSED (order delivered to Telegram on 2026-10-12)

---



## Project Structure

```
TSI COSMETICS/
├── index.html          ← Main storefront
├── order.html          ← Dedicated order page
├── products.js         ← Shared product catalog and cart utilities
├── .gitignore
├── DEPLOYMENT.md       ← This file
└── worker/
    ├── src/
    │   └── index.js    ← Cloudflare Worker source
    ├── wrangler.toml   ← Worker configuration
    ├── .dev.vars.example
    └── .gitignore
```

---

## Step 1 — Create the Telegram Bot

1. Open Telegram and search for **@BotFather**.
2. Send `/newbot` and follow the prompts.
3. BotFather will give you a **bot token** that looks like `1234567890:ABCdef...`.
4. **Do not paste this token into any source file or GitHub repository.**
5. Open a conversation with your new bot and press **Start** (required before it can message you).

---

## Step 2 — Find Your Telegram Chat ID

Your chat ID is already known: **1383344605**

To verify, send any message to your bot, then open this URL in your browser
(replace `BOT_TOKEN` with your actual token):

```
https://api.telegram.org/botBOT_TOKEN/getUpdates
```

Look for `"id"` inside `"from"` in the response — that is your user ID.

---

## Step 3 — Deploy the Cloudflare Worker

### 3a. Install Wrangler (Cloudflare CLI)

You need Node.js installed. Then in Command Prompt:

```cmd
npm install -g wrangler
```

### 3b. Log in to Cloudflare

```cmd
wrangler login
```

This opens a browser window — log in with your free Cloudflare account.

### 3c. Deploy the Worker

```cmd
cd "C:\Users\HP\Downloads\TSI COSMETICS\worker"
wrangler deploy
```

Wrangler will print the Worker URL, which looks like:
```
https://tsi-order-worker.YOUR-SUBDOMAIN.workers.dev
```

Copy that URL — you need it in Step 5.

### 3d. Set the Bot Token as a Secret

```cmd
wrangler secret put TELEGRAM_BOT_TOKEN
```

When prompted, paste your bot token. It will be stored encrypted — never in source code.

### 3e. Set Your Chat ID

```cmd
wrangler secret put TELEGRAM_OWNER_CHAT_ID
```

When prompted, enter: `1383344605`

### 3f. Set the Allowed Origin

Edit `worker/wrangler.toml` and set `ALLOWED_ORIGIN` to your website URL:

```toml
[vars]
ALLOWED_ORIGIN = "https://tsicosmetics.com"
```

Then redeploy:

```cmd
wrangler deploy
```

---

## Step 4 — Connect the Website to the Worker

Open `order.html` and find this line near the top of the `<script>` section:

```javascript
const WORKER_URL = 'https://tsi-order-worker.YOUR-SUBDOMAIN.workers.dev/api/order';
```

Replace `YOUR-SUBDOMAIN` with your actual subdomain from Step 3c. Example:

```javascript
const WORKER_URL = 'https://tsi-order-worker.myname.workers.dev/api/order';
```

Save the file.

---

## Step 5 — Deploy the Website

### Option A — GitHub Pages (free, recommended for static sites)

1. Create a GitHub account at https://github.com if you do not have one.
2. Create a new repository called `tsi-cosmetics` (public or private).
3. Upload these files to the repository:
   - `index.html`
   - `order.html`
   - `products.js`
4. Go to the repository **Settings → Pages**.
5. Under "Source", select **Deploy from a branch → main → / (root)**.
6. GitHub will give you a URL like `https://YOURNAME.github.io/tsi-cosmetics/`.
7. Update `WORKER_URL` in `order.html` to use this origin if needed.
8. Update `ALLOWED_ORIGIN` in `wrangler.toml` and redeploy the Worker.

### Option B — Cloudflare Pages (free, recommended with custom domain)

1. Log in to https://dash.cloudflare.com.
2. Go to **Workers & Pages → Create application → Pages → Connect to Git**.
3. Connect your GitHub repository.
4. Set the build settings: no build command, output directory `/`.
5. Deploy.

---

## Step 6 — Test the Full Flow

1. Open your website and add a product to the cart.
2. Click "Order Now" — you should reach `order.html`.
3. Fill in the form with test data (use a fake name and address).
4. Click "Send Order Request".
5. Check that you receive a Telegram message from your bot.
6. Confirm the message contains all the customer details and items.

### If the order fails:

- **CORS error** — `ALLOWED_ORIGIN` in the Worker does not match your website's exact origin (including `https://`).
- **Bot token error** — The secret was not set correctly. Run `wrangler secret put TELEGRAM_BOT_TOKEN` again.
- **Chat ID error** — The bot has not been started. Open Telegram, find your bot, and press Start.
- **Worker URL wrong** — `WORKER_URL` in `order.html` has a typo or still contains `YOUR-SUBDOMAIN`.

---

## Step 7 — Update Products

To add, edit, or remove products:

1. Open `products.js`.
2. Edit the `PRODUCTS` array — add or modify entries.
3. Save the file and push to GitHub (or re-upload to your host).
4. The website updates automatically.

To change prices, update the `price` field for each product (in ETB).

---

## Security Notes

- The bot token is stored only as a Cloudflare Worker secret — never in source code or GitHub.
- The Worker validates and sanitises all submitted data server-side.
- The Worker recalculates prices from the client-submitted unit prices (which come from the static catalog).
- The customer never needs to touch Telegram — the Worker sends the notification automatically.
- No database is used — the Telegram message is the order record.

---

## Rotating a Compromised Bot Token

If your bot token is ever exposed:

1. Open Telegram → @BotFather → `/revoke` → select your bot.
2. BotFather will issue a new token.
3. Run `wrangler secret put TELEGRAM_BOT_TOKEN` with the new token.
4. Redeploy: `wrangler deploy`.

---

## Free Tier Limits (as of 2026)

| Service | Free limit |
|---|---|
| Cloudflare Workers | 100,000 requests/day |
| GitHub Pages | Unlimited static hosting |
| Cloudflare Pages | 500 builds/month, unlimited requests |
| Telegram Bot API | No documented rate limit for personal use |

These limits are more than sufficient for a small business order volume.
