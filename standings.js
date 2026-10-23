// Renders data/results.json, which the bot publishes when staff record a round.
// Self-contained on purpose: like home.js it owns its helpers and exposes nothing.
(() => {
  "use strict";

  const RESULTS_URL = "data/results.json";
  const POLL_INTERVAL_MS = 5 * 60 * 60_000; // results change once a race weekend
  const LOCALE = "en-GB";

  const $ = (id) => document.getElementById(id);
  const state = { data: null, division: null };
  let lastCheckedAt = 0;

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function relative(iso) {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return "";
    const seconds = Math.round((then.getTime() - Date.now()) / 1000);
    const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
    for (const [unit, size] of units) {
      if (Math.abs(seconds) >= size) {
        return new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" }).format(Math.round(seconds / size), unit);
      }
    }
    return "just now";
  }

  function setStatus(text, isError) {
    const status = $("standings-status");
    if (!status) return;
    status.textContent = text;
    status.classList.toggle("error", Boolean(isError));
  }

  function divisions() {
    return (state.data?.divisions ?? []).filter((division) => division && division.name);
  }

  function currentDivision() {
    const list = divisions();
    return list.find((division) => division.name === state.division) ?? list[0] ?? null;
  }

  function renderNav() {
    const nav = $("standings-nav");
    nav.innerHTML = divisions().map((division) =>
      `<button type="button" data-division="${esc(division.name)}" aria-pressed="${division.name === currentDivision()?.name}">${esc(division.name)}</button>`
    ).join("");

    nav.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        state.division = button.dataset.division;
        renderNav();
        render();
      });
    });
  }

  function driverCells(row) {
    const handle = row.username && row.username !== row.name
      ? ` <span class="handle">@${esc(row.username)}</span>` : "";
    return `<tr>
      <td class="num">${esc(row.position)}</td>
      <td><b>${esc(row.name)}</b>${handle}</td>
      <td>${esc(row.team ?? "")}</td>
      <td class="num"><b>${esc(row.points ?? 0)}</b></td>
      <td class="num">${esc(row.wins ?? 0)}</td>
      <td class="num">${esc(row.podiums ?? 0)}</td>
    </tr>`;
  }

  function teamCells(row) {
    return `<tr>
      <td class="num">${esc(row.position)}</td>
      <td><b>${esc(row.name)}</b></td>
      <td class="num"><b>${esc(row.points ?? 0)}</b></td>
      <td class="num">${esc(row.wins ?? 0)}</td>
    </tr>`;
  }

  function emptyRow(columns, message) {
    return `<tr><td colspan="${columns}" class="empty-line">${esc(message)}</td></tr>`;
  }

  function renderLatest(division) {
    const block = $("last-round");
    const rounds = (division?.rounds ?? []).filter((round) => round && round.classification?.length);
    if (!rounds.length) {
      block.hidden = true;
      block.innerHTML = "";
      return;
    }

    const round = [...rounds].sort((a, b) => (b.round ?? 0) - (a.round ?? 0))[0];
    const heading = `Round ${round.round}${round.circuit ? ` — ${round.circuit}` : ""}`;
    const extras = [
      round.pole ? `Pole: ${round.pole.name}` : "",
      round.fastest_lap ? `Fastest lap: ${round.fastest_lap.name}` : "",
    ].filter(Boolean).join(" · ");

    const places = round.classification.slice(0, 5).map((entry) => {
      const badge = Number.isInteger(entry.position) ? `P${entry.position}` : "DNF";
      const points = entry.points ? ` · ${entry.points} pts` : "";
      return `<li><span class="pos">${esc(badge)}</span><b>${esc(entry.name)}</b>
        <span class="team-note">${esc(entry.short ?? "")}${points}</span></li>`;
    }).join("");

    block.hidden = false;
    block.innerHTML = `
      <div class="last-round-head">
        <h3>Latest round</h3>
        <p class="last-round-title">${esc(heading)}</p>
        ${extras ? `<p class="last-round-meta">${esc(extras)}</p>` : ""}
      </div>
      <ol class="last-round-list">${places}</ol>`;
  }

  function render() {
    if (!state.data) return;
    const division = currentDivision();
    if (!division) {
      $("standings-drivers").innerHTML = "";
      $("standings-teams").innerHTML = "";
      $("last-round").hidden = true;
      return;
    }

    const standings = division.standings ?? {};
    const drivers = standings.drivers ?? [];
    const teams = standings.teams ?? [];

    $("standings-drivers").innerHTML = drivers.length
      ? drivers.map(driverCells).join("")
      : emptyRow(6, "No rounds recorded yet.");
    $("standings-teams").innerHTML = teams.length
      ? teams.map(teamCells).join("")
      : emptyRow(4, "No rounds recorded yet.");

    renderLatest(division);
    $("standings-updated").textContent = state.data.updated_at
      ? `${state.data.season ?? "Season"} · updated ${relative(state.data.updated_at)}`
      : (state.data.season ?? "");

    const roundCount = (division.rounds ?? []).length;
    setStatus(
      `${division.name} · ${roundCount} round${roundCount === 1 ? "" : "s"} recorded · ${drivers.length} driver${drivers.length === 1 ? "" : "s"} scored`,
      false,
    );
  }

  async function refresh() {
    try {
      const response = await fetch(`${RESULTS_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (response.status === 404) {
        state.data = { divisions: [] };
        renderNav();
        render();
        $("standings-drivers").innerHTML = "";
        $("standings-teams").innerHTML = "";
        $("standings-updated").textContent = "";
        $("last-round").hidden = true;
        setStatus("No rounds recorded yet — results appear here after the first race.", false);
        lastCheckedAt = Date.now();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      state.data = await response.json();
      if (state.division && !divisions().some((division) => division.name === state.division)) {
        state.division = null;
      }
      renderNav();
      render();
      lastCheckedAt = Date.now();
    } catch (error) {
      console.warn("Standings refresh failed:", error);
      if (!state.data) {
        setStatus("Standings are not available yet — the bot publishes them after each round.", true);
      }
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastCheckedAt >= POLL_INTERVAL_MS) refresh();
  });

  refresh();
})();
