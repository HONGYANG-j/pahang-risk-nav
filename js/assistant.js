import { State } from "./state.js";
import { getDistrictAt } from "./risk.js";

const BUCKETS = ["morning", "afternoon", "evening", "night"];
const DISCLOSURE = "(Based on placeholder synthetic sample data -- not a validated model.)";

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

function appendMessage(role, text) {
  const log = document.getElementById("assistant-log");
  if (!log) return;
  const row = document.createElement("div");
  row.className = `assistant-msg assistant-msg-${role}`;
  row.textContent = text;
  log.append(row);
  log.scrollTop = log.scrollHeight;
}

function ask(text) {
  if (!text.trim()) return;
  appendMessage("user", text);
  appendMessage("bot", answerQuery(text));
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
}
