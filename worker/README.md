# Planner Assistant backend (Cloudflare Worker)

Holds the Groq API key server-side and proxies chat requests from the app.
This is the one part of the project that isn't static — everything else is
still plain GitHub Pages.

## Why a separate service at all

The frontend (`risk-nav-app/`) is static files on GitHub Pages. Any key
shipped in frontend JS is public — a scanner finds it within minutes of a
push. This Worker is the only place the Groq key ever lives, as a Cloudflare
secret, never in a file, never committed, never pasted into chat with an AI
assistant (including this one).

## One-time setup

Run these from this `worker/` directory, in your own terminal:

```bash
npm install
npx wrangler login
```

`wrangler login` opens a browser tab to authorize against your Cloudflare
account (free tier is enough — sign up at dash.cloudflare.com first if you
don't have one).

Create the rate-limiting KV store:

```bash
npx wrangler kv namespace create RATE_LIMIT_KV
```

This prints an `id`. Paste it into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

Set the Groq key as a secret — **regenerate a fresh key at console.groq.com
first** if you're reusing one that was ever pasted anywhere outside this
terminal:

```bash
npx wrangler secret put GROQ_API_KEY
```

This prompts you to paste the key directly into your terminal. It is sent
straight to Cloudflare and stored as an encrypted secret — it never touches
this repo, and never needs to be shown to anyone helping you write code.

## Deploy

```bash
npx wrangler deploy
```

Prints a URL like `https://risk-nav-assistant.<your-subdomain>.workers.dev`.
That URL is **not** sensitive — it's the public address of the proxy, safe
to share, safe to hardcode in the frontend (`js/assistant.js`'s
`LLM_WORKER_URL`).

## Updating later

Any code change here needs `npx wrangler deploy` again to go live — same
"local ≠ deployed" discipline as the GitHub Pages frontend.

## Cost / abuse guards already built in

- CORS restricted to the deployed GitHub Pages origin (plus localhost for
  testing) — `src/index.js`'s `ALLOWED_ORIGINS`.
- Per-visitor limit: 20 requests/hour (by IP, via the KV store).
- Global limit: 300 requests/day, shared across all visitors — caps worst-case
  cost regardless of per-IP limits.
- Short, cheap model (`llama-3.1-8b-instant`), capped at 300 output tokens.

None of this is bulletproof (a determined caller can still hit `/chat`
directly with curl, bypassing CORS), but it's a reasonable bar for a
low-traffic demo. If this ever needs to survive real public traffic, the KV
counters would want to move to a Durable Object for correctness under
concurrent requests.

## Local testing

```bash
npx wrangler dev
```

Runs the Worker locally (needs the same `wrangler secret put` done once,
`wrangler dev` reads local secrets separately — it'll prompt).
