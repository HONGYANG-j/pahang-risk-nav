const MAX_EVENTS = 30;

/** Appends a row to the on-screen event log. severity: "info" | "warn" | "danger". */
export function logEvent(text, severity = "info") {
  const list = document.getElementById("event-log-list");
  if (!list) return;

  const empty = list.querySelector(".event-log-empty");
  if (empty) empty.remove();

  const row = document.createElement("div");
  row.className = `event-row sev-${severity}`;

  const time = document.createElement("span");
  time.className = "event-time";
  time.textContent = new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const text_ = document.createElement("span");
  text_.className = "event-text";
  text_.textContent = text; // textContent, not innerHTML -- nothing here should ever be parsed as markup

  row.append(time, text_);
  list.append(row);

  while (list.children.length > MAX_EVENTS) {
    list.removeChild(list.firstChild);
  }
  list.scrollTop = list.scrollHeight;
}
