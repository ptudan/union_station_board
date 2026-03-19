const bodyEl = document.getElementById("board-body");
const metaEl = document.getElementById("meta");
const warningsEl = document.getElementById("warnings");
const refreshBtn = document.getElementById("refresh-btn");
const filterChips = [...document.querySelectorAll(".chip[data-filter]")];
const windowChips = [...document.querySelectorAll(".chip[data-window]")];

let currentFilter = "all";
let currentWindowMinutes = 60;
let latestEvents = [];

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function delayClass(delay) {
  if (delay < 0) return "early";
  if (delay <= 2) return "ok";
  if (delay <= 10) return "warn";
  return "bad";
}

function escapeHtml(raw) {
  return String(raw || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderRows(events) {
  const filtered =
    currentFilter === "all"
      ? events
      : events.filter((event) => event.eventType === currentFilter);

  if (filtered.length === 0) {
    bodyEl.innerHTML =
      '<tr><td colspan="7" style="color:#9fb1c6;">No trains in this window.</td></tr>';
    return;
  }

  bodyEl.innerHTML = filtered
    .map((event) => {
      const delay = Number(event.delayMinutes || 0);
      const delayText =
        delay === 0 ? "On time" : delay < 0 ? `${Math.abs(delay)} min early` : `${delay} min late`;
      return `
        <tr>
          <td>${formatTime(event.estimatedTime)}</td>
          <td>${escapeHtml(event.provider)}</td>
          <td><span class="pill ${event.eventType}">${escapeHtml(event.eventType)}</span></td>
          <td>${escapeHtml(event.trainId)}</td>
          <td>${escapeHtml(event.route || "-")}</td>
          <td>${escapeHtml(event.headsign || "-")}</td>
          <td class="delay ${delayClass(delay)}">${delayText}</td>
        </tr>
      `;
    })
    .join("");
}

function renderWarnings(warnings) {
  if (!warnings || warnings.length === 0) {
    warningsEl.innerHTML = "";
    return;
  }
  warningsEl.innerHTML = warnings
    .map((warning) => `<div class="warning">${escapeHtml(warning)}</div>`)
    .join("");
}

async function loadBoard() {
  metaEl.textContent = "Refreshing...";
  try {
    const res = await fetch(`/api/board?windowMinutes=${currentWindowMinutes}`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    latestEvents = data.events || [];
    renderRows(latestEvents);
    renderWarnings(data.warnings || []);
    const updated = new Date(data.updatedAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit"
    });
    metaEl.textContent = `${data.station} | Next ${data.windowMinutes} min | Last updated ${updated} | ${latestEvents.length} events`;
  } catch (error) {
    metaEl.textContent = `Load failed: ${error.message}`;
    bodyEl.innerHTML =
      '<tr><td colspan="7" style="color:#ff6f6f;">Could not load board data.</td></tr>';
  }
}

refreshBtn.addEventListener("click", loadBoard);

for (const chip of filterChips) {
  chip.addEventListener("click", () => {
    currentFilter = chip.dataset.filter;
    filterChips.forEach((button) => button.classList.remove("active"));
    chip.classList.add("active");
    renderRows(latestEvents);
  });
}

for (const chip of windowChips) {
  chip.addEventListener("click", () => {
    currentWindowMinutes = Number.parseInt(chip.dataset.window || "60", 10);
    windowChips.forEach((button) => button.classList.remove("active"));
    chip.classList.add("active");
    loadBoard();
  });
}

loadBoard();
setInterval(loadBoard, 5 * 60 * 1000);
