// Shared text-to-speech helper -- used by both the Planner Assistant's voice
// replies (assistant.js) and live/demo alert narration (alerts.js). One
// shared call site so the two features cancel/replace each other cleanly
// instead of two independent SpeechSynthesis calls talking over one another
// (e.g. a jam alert firing mid-reply).
export function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text.replace(/\n+/g, ". "));
  window.speechSynthesis.speak(utter);
}

export function speechSupported() {
  return "speechSynthesis" in window;
}
