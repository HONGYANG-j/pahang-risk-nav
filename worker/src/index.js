// Small backend for the Planner Assistant's real LLM mode.
//
// Why this exists at all: the frontend is static (GitHub Pages, no server),
// so it can never safely hold a Groq API key -- anything shipped to the
// browser is public. This Worker is the one piece of real infrastructure
// that holds GROQ_API_KEY (set via `wrangler secret put`, never committed,
// never visible to the frontend) and proxies chat requests to Groq on the
// frontend's behalf.
//
// Grounding, not free generation: the frontend sends the app's own real
// current state (district risk table, active simulated jams, dataset
// caveats) as `context`, and the system prompt below instructs the model to
// only use that data -- same anti-fabrication stance js/assistant.js's
// keyword-templated version already held, just now enforced via prompt
// instead of by construction. That's a weaker guarantee than the old
// approach (a model can still ignore the instruction), which is exactly why
// the frontend keeps the old templated answerQuery() as an automatic
// fallback if this call fails, times out, or gets rate-limited.

const ALLOWED_ORIGINS = new Set([
  "https://hongyang-j.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

const GROQ_MODEL = "openai/gpt-oss-20b"; // cheapest text-only model on this account, plenty for short grounded Q&A
// gpt-oss-20b is a reasoning model -- it can spend tokens on an internal
// reasoning trace before ever emitting final answer content. At the
// original 300, a question that invited more "thinking" (e.g. comparing
// multiple districts) could exhaust the whole budget on reasoning and
// return empty content, surfacing as a 502 "empty_reply" and silently
// falling back to the grounded lookup -- found via live testing, not a
// guess. Real cost is still negligible at this model's pricing even at 4x
// the budget.
const MAX_TOKENS = 1200;
// Raised from 20/hour and 300/day. 20/hour is genuinely tight for the one
// case that matters most here: rehearsing and recording a demo video, where
// several takes x a few questions each can quietly cross it -- and hitting
// the limit mid-take degrades silently to the templated fallback, i.e. the
// "this is a real LLM" moment breaks on camera with no obvious cause. Cost
// is not the binding constraint at this model's pricing: even 500 requests
// in a day is a few cents. Still bounded, so a shared link can't run away.
const IP_LIMIT_PER_HOUR = 60; // per-visitor abuse guard
const GLOBAL_LIMIT_PER_DAY = 500; // total-cost guard, shared across all visitors

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

async function incrementAndCheck(kv, key, limit, ttlSeconds) {
  const current = parseInt((await kv.get(key)) || "0", 10);
  if (current >= limit) return false;
  await kv.put(key, String(current + 1), { expirationTtl: ttlSeconds });
  return true;
}

function buildSystemPrompt(context) {
  return `You are the Planner Assistant inside a Pahang (Malaysia) road-safety navigation prototype, built for the DAX 2026 competition. You help a road-safety planner or patrol dispatcher reason about the app's own data.

STRICT RULES -- these matter more than being helpful:
1. Only use facts, numbers, and district names present in the CURRENT APP DATA block below. Never invent a statistic, district, or figure that isn't there.
2. This data is EXPLICITLY a placeholder: the source dataset's outcome/factor columns are independently shuffled (synthetic), so district risk scores are illustrative, not a validated model. If your answer references a risk score, say so briefly.
3. The recorded crash coordinates and the density-model hotspots ARE verified real locations (unlike the risk scores) -- you may describe them as real if asked what's real vs placeholder.
4. Simulated jams are simulated traffic for demo purposes, never real users -- say so if asked about them.
5. If the question needs data not present below, say plainly that you don't have that data, instead of guessing.
6. Keep answers short: 2-4 sentences, plain language, no markdown.

CURRENT APP DATA:
${JSON.stringify(context, null, 2)}`;
}

async function handleChat(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400, origin);
  }

  const message = typeof body.message === "string" ? body.message.trim().slice(0, 500) : "";
  if (!message) return json({ error: "Missing 'message'." }, 400, origin);
  const context = body.context && typeof body.context === "object" ? body.context : {};

  if (env.RATE_LIMIT_KV) {
    const now = new Date();
    const hourKey = `ip:${request.headers.get("CF-Connecting-IP") || "unknown"}:${now.toISOString().slice(0, 13)}`;
    const dayKey = `global:${now.toISOString().slice(0, 10)}`;

    const ipOk = await incrementAndCheck(env.RATE_LIMIT_KV, hourKey, IP_LIMIT_PER_HOUR, 3600);
    if (!ipOk) return json({ error: "rate_limited", reason: "Too many requests from this visitor -- try again shortly." }, 429, origin);

    const globalOk = await incrementAndCheck(env.RATE_LIMIT_KV, dayKey, GLOBAL_LIMIT_PER_DAY, 86400);
    if (!globalOk) return json({ error: "rate_limited", reason: "Daily assistant quota reached -- try again tomorrow." }, 429, origin);
  }

  if (!env.GROQ_API_KEY) {
    return json({ error: "server_misconfigured", reason: "GROQ_API_KEY secret not set." }, 500, origin);
  }

  const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: buildSystemPrompt(context) },
        { role: "user", content: message },
      ],
      max_tokens: MAX_TOKENS,
      temperature: 0.3,
    }),
  });

  if (!groqRes.ok) {
    const detail = await groqRes.text().catch(() => "");
    return json({ error: "upstream_error", reason: `Groq API error (${groqRes.status})`, detail: detail.slice(0, 300) }, 502, origin);
  }

  const data = await groqRes.json();
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) return json({ error: "empty_reply" }, 502, origin);

  return json({ reply }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (url.pathname === "/health") {
      return json({ ok: true }, 200, origin);
    }
    if (url.pathname === "/chat" && request.method === "POST") {
      return handleChat(request, env, origin);
    }
    return json({ error: "not_found" }, 404, origin);
  },
};
