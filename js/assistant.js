import { State } from "./state.js";
import { getDistrictAt } from "./risk.js";

const BUCKETS = ["morning", "afternoon", "evening", "night"];
const DISCLOSURE = "(Based on placeholder synthetic sample data -- not a validated model.)";

// Cloudflare Worker that holds the Groq key server-side and proxies chat
// requests -- see worker/README.md. Empty until deployed; askLLM() below
// treats an empty/unreachable URL as "not configured yet" and falls
// straight through to the grounded keyword answerQuery() below, so the
// assistant works (in its older, still-honest form) even before or during
// any Worker outage.
const LLM_WORKER_URL = "https://risk-nav-assistant.pahang-risk-nav.workers.dev";

export const SUGGESTIONS = ["Where should patrols go tonight?", "Any active jams?", "Summary for this time of day"];

function pct(score) {
  return `${Math.round(score * 100)}%`;
}

function describeFactors(entry) {
  return entry.top_factors && entry.top_factors.length ? entry.top_factors.join(", ") : "no single dominant factor";
}

function topDistrictsForBucket(bucket, n = 3) {
  return State.riskFeatures
    .map((f) => ({ district: f.district, ...f.risk_by_time[bucket] }))
    .filter((d) => d.score != null)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

/**
 * Answers a planner's question by querying the app's real, already-computed
 * state -- district risk table, active simulated jams, current time bucket.
 * This is deliberately NOT a call to a generative model: there is no backend
 * here to hold an API key safely, and more importantly, a free-generating
 * chatbot over this data risks inventing numbers that were never computed --
 * exactly the kind of fabricated finding the competition's ethics rules
 * forbid. Keyword matching selects which grounded lookup to run; the prose
 * around the number is templated, the number itself is never invented.
 */
export function answerQuery(rawInput) {
  const q = rawInput.trim().toLowerCase();
  if (!q) return "Ask a question, or tap a suggestion below.";

  const mentionedDistrict = State.riskFeatures.find((f) => q.includes(f.district.toLowerCase()));
  if (mentionedDistrict) {
    const bucket = BUCKETS.find((b) => q.includes(b)) || State.timeBucket;
    const d = mentionedDistrict.risk_by_time[bucket];
    if (!d) return `No data for ${mentionedDistrict.district} in that period.`;
    return (
      `${mentionedDistrict.district}, ${bucket}: fatal share of records ${pct(d.score)}` +
      (d.low_confidence ? " (low sample size)" : "") +
      `. Associated factors: ${describeFactors(d)}. Sample size n=${d.n}. ${DISCLOSURE}`
    );
  }

  if (/\bjams?\b|traffic|congestion|blocked/.test(q)) {
    if (!State.activeJams.length) return "No simulated jams active right now.";
    const lines = State.activeJams.map((j, i) => {
      const loc = getDistrictAt(j.lat, j.lng);
      return `#${i + 1} ${loc ? loc.district : "unmapped area"} (${j.botCount} vehicles clustered)`;
    });
    return `${State.activeJams.length} simulated jam(s) active: ${lines.join("; ")}. (Simulated traffic for demo purposes, not real users.)`;
  }

  if (/patrol|deploy|resource|allocat|dispatch/.test(q)) {
    const bucket = BUCKETS.find((b) => q.includes(b)) || (q.includes("tonight") ? "night" : State.timeBucket);
    const [top] = topDistrictsForBucket(bucket, 1);
    if (!top) return `No risk data available for ${bucket}.`;
    return `Recommended focus for ${bucket}: ${top.district} — ${pct(top.score)} fatal share, factors: ${describeFactors(top)}. ${DISCLOSURE}`;
  }

  const bucketOnly = BUCKETS.find((b) => q.includes(b));
  if (bucketOnly) {
    const top = topDistrictsForBucket(bucketOnly, 3);
    return `Top flagged districts for ${bucketOnly}: ${top.map((d) => `${d.district} (${pct(d.score)})`).join(", ")}. ${DISCLOSURE}`;
  }

  const top = topDistrictsForBucket(State.timeBucket, 3);
  return (
    `Currently viewing ${State.timeBucket}. Top flagged districts: ` +
    `${top.map((d) => `${d.district} (${pct(d.score)})`).join(", ")}. ` +
    `Try a district name, "patrols tonight", or "active jams". ${DISCLOSURE}`
  );
}

/**
 * Compact real-data summary sent as context to the LLM. Same underlying
 * facts answerQuery() above uses (district risk table, active jams, current
 * time bucket) plus a couple of extra fields (crash point / density model
 * counts) so the model can accurately describe what's real vs placeholder
 * if asked. The Worker's system prompt instructs the model to only use
 * facts from this object -- see worker/src/index.js.
 */
function buildContext() {
  return {
    time_bucket: State.timeBucket,
    districts: State.riskFeatures.map((f) => ({
      district: f.district,
      risk_by_time: Object.fromEntries(
        BUCKETS.filter((b) => f.risk_by_time[b]).map((b) => {
          const d = f.risk_by_time[b];
          return [b, { fatal_share_pct: Math.round(d.score * 100), top_factors: d.top_factors, n: d.n, low_confidence: !!d.low_confidence }];
        })
      ),
    })),
    active_jams: State.activeJams.map((j) => {
      const loc = getDistrictAt(j.lat, j.lng);
      return { district: loc ? loc.district : "unmapped area", bot_count: j.botCount };
    }),
    real_crash_points_recorded: State.crashPointsCount || null,
    real_density_model_cells: State.densityCells || null,
  };
}

/** Calls the Worker's /chat endpoint. Throws on any failure -- caller falls back. */
async function askLLM(message) {
  if (!LLM_WORKER_URL) throw new Error("LLM_WORKER_URL not configured");
  const res = await fetch(`${LLM_WORKER_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, context: buildContext() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.reason || data.error || `HTTP ${res.status}`);
  if (!data.reply) throw new Error("Empty reply from assistant");
  return data.reply;
}

function appendMessage(role, text) {
  const log = document.getElementById("assistant-log");
  if (!log) return null;
  const row = document.createElement("div");
  row.className = `assistant-msg assistant-msg-${role}`;
  row.textContent = text;
  log.append(row);
  log.scrollTop = log.scrollHeight;
  return row;
}

/** Reads a reply aloud -- only called for voice-initiated turns (see
 * initAssistant's mic wiring below), so typing a question never triggers
 * unexpected audio. cancel() first so a fast follow-up doesn't queue behind
 * (and eventually talk over) a reply still being read. */
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text.replace(/\n+/g, ". "));
  window.speechSynthesis.speak(utter);
}

// Same guard shape as demoBusy/crashLoading/densityLoading elsewhere in this
// app: askLLM is a real network round-trip, so without this a fast
// double-tap (Enter twice, or the mic re-tapped while a reply is still
// pending -- easy to do while waiting on a voice reply) fires a second
// concurrent request, producing two overlapping "Thinking…" bubbles and
// possibly out-of-order replies.
let assistantBusy = false;

async function ask(text, { viaVoice = false } = {}) {
  if (!text.trim() || assistantBusy) return;
  assistantBusy = true;
  syncAssistantBusyUI();
  appendMessage("user", text);
  const pending = appendMessage("bot", "Thinking…");
  let finalText;
  try {
    finalText = await askLLM(text);
  } catch (err) {
    console.warn("LLM assistant unavailable, falling back to grounded lookup:", err.message);
    const fallback = answerQuery(text);
    finalText = LLM_WORKER_URL ? `${fallback}\n\n(Real AI assistant unavailable right now -- showing the grounded lookup instead.)` : fallback;
  } finally {
    assistantBusy = false;
    syncAssistantBusyUI();
  }
  if (pending) pending.textContent = finalText;
  if (viaVoice) speak(finalText);
}

function syncAssistantBusyUI() {
  const sendBtn = document.getElementById("assistant-send-btn");
  const micBtn = document.getElementById("assistant-mic-btn");
  if (sendBtn) sendBtn.disabled = assistantBusy;
  if (micBtn) micBtn.disabled = assistantBusy;
}

export function initAssistant() {
  const modal = document.getElementById("assistant-modal");
  const input = document.getElementById("assistant-input");
  const openBtn = document.getElementById("assistant-btn");
  const closeBtn = document.getElementById("assistant-close-btn");
  const sendBtn = document.getElementById("assistant-send-btn");
  const backdrop = document.getElementById("assistant-backdrop");
  const suggestionsEl = document.getElementById("assistant-suggestions");

  SUGGESTIONS.forEach((s) => {
    const chip = document.createElement("button");
    chip.className = "assistant-chip";
    chip.textContent = s;
    chip.addEventListener("click", () => ask(s));
    suggestionsEl.append(chip);
  });

  const open = () => {
    modal.hidden = false;
    input.focus();
  };
  const close = () => {
    modal.hidden = true;
  };

  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);

  sendBtn.addEventListener("click", () => {
    ask(input.value);
    input.value = "";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      ask(input.value);
      input.value = "";
    }
  });

  // Voice in, voice out -- "talk to the AI instead of texting", the point
  // being not having to look at/type on a phone while riding. Web Speech
  // API is browser-native (no key, no backend), but support is real and
  // uneven (Firefox has none) -- feature-detected, and the button simply
  // doesn't render rather than existing as a dead control on browsers that
  // can't do it.
  const micBtn = document.getElementById("assistant-mic-btn");
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (micBtn && SpeechRecognitionCtor) {
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    let listening = false;

    recognition.addEventListener("start", () => {
      listening = true;
      micBtn.classList.add("listening");
    });
    recognition.addEventListener("end", () => {
      listening = false;
      micBtn.classList.remove("listening");
    });
    recognition.addEventListener("result", (e) => {
      const transcript = e.results[0][0].transcript;
      ask(transcript, { viaVoice: true });
    });
    recognition.addEventListener("error", (e) => {
      if (e.error === "not-allowed") appendMessage("bot", "Microphone access denied — enable it to ask by voice.");
      else if (e.error === "no-speech") appendMessage("bot", "Didn't catch that — try again.");
    });

    micBtn.addEventListener("click", () => {
      if (listening) recognition.stop();
      else recognition.start();
    });
  } else if (micBtn) {
    micBtn.hidden = true;
  }
}
