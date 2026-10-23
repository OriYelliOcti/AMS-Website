// FIA race-control desk. Reached only at #ams-FIA, never linked from the page.
//
// The access code is held as a SHA-256 digest, not as text, so the file itself
// does not spell it out. That is still concealment rather than security: anyone
// who reads this file can see how the check works. What actually protects the
// league is that nothing here can write — the desk reads the published payloads
// and the repo token stays in the page that owns publishing.
(() => {
  "use strict";

  const HASH = "#ams-fia";
  const CODE_SHA256 = "387212a44247c12e2829f6f4c49c22c053ca58bba77bcd613d441bac4c716741";
  const UNLOCK_KEY = "ams-fia-unlocked";
  const LINEUPS_URL = "data/lineups.json";
  const RESULTS_URL = "data/results.json";
  const LOCALE = "en-GB";

  const $ = (id) => document.getElementById(id);
  const section = $("fia");
  if (!section) return;

  let body = null; // cached payloads, so re-entry does not refetch
  const publicTitle = document.title;

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function initials(name) {
    const cleaned = String(name).replace(/[^\p{L}\p{N} ]/gu, " ").trim();
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
  }

  async function digest(text) {
    const bytes = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function note(text, isError) {
    const el = $("fia-gate-note");
    el.textContent = text;
    el.classList.toggle("error", Boolean(isError));
  }

  function isOpen() {
    return location.hash.toLowerCase() === HASH;
  }

  function setMode(on) {
    document.body.dataset.fia = on ? "on" : "";
    section.hidden = !on;
    document.title = on ? "FIA — race control" : publicTitle;
    if (on) {
      window.scrollTo({ top: 0 });
      const unlocked = sessionStorage.getItem(UNLOCK_KEY) === "1";
      $("fia-gate").hidden = unlocked;
      $("fia-body").hidden = !unlocked;
      if (unlocked) render();
      else $("fia-password").focus();
    } else {
      sessionStorage.removeItem(UNLOCK_KEY);
      $("fia-password").value = "";
      note("", false);
    }
  }

  async function fetchJson(url) {
    const response = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function people(list) {
    return (list ?? []).map((person) => `
      <span class="person" title="${esc(person.name)}">
        <span class="avatar">${esc(initials(person.name))}</span>${esc(person.name)}
        ${person.username && person.username !== person.name ? `<span class="handle">@${esc(person.username)}</span>` : ""}
      </span>`).join("") || '<span class="empty-line">Nobody assigned.</span>';
  }

  function roundsOf(division) {
    return (division?.rounds ?? []).filter((round) => round && (round.classification?.length || round.round));
  }

  function renderMeta(lineups, results) {
    const officials = lineups?.officials ?? [];
    const seated = officials.reduce((total, entry) => total + (entry.members?.length ?? 0), 0);
    const divisions = results?.divisions ?? [];
    const rounds = divisions.reduce((total, division) => total + roundsOf(division).length, 0);
    const published = lineups?.generated_at ? new Date(lineups.generated_at) : null;

    $("fia-meta").innerHTML = [
      ["Officials", `${seated} in ${officials.length} role(s)`],
      ["Rounds recorded", String(rounds)],
      ["Lineups published", published && !Number.isNaN(published.getTime())
        ? published.toLocaleString(LOCALE, { dateStyle: "medium", timeStyle: "short" })
        : "unknown"],
    ].map(([label, value]) => `<div class="fia-stat"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("");
  }

  function renderOfficials(lineups) {
    const officials = lineups?.officials ?? [];
    $("fia-officials").innerHTML = officials.length
      ? officials.map((entry) => `
        <article class="official">
          <h3>${esc(entry.role)}</h3>
          <div class="people">${people(entry.members)}</div>
        </article>`).join("")
      : '<p class="empty-line">No FIA roles are being published right now.</p>';
  }

  function renderSeason(results) {
    const divisions = results?.divisions ?? [];
    if (!divisions.length) {
      $("fia-season").innerHTML = '<p class="empty-line">No rounds recorded yet — results appear here after the first race.</p>';
      return;
    }

    $("fia-season").innerHTML = divisions.map((division) => {
      const rounds = roundsOf(division).sort((a, b) => (b.round ?? 0) - (a.round ?? 0));
      const latest = rounds[0];
      const title = latest
        ? `Round ${esc(latest.round)}${latest.circuit ? ` — ${esc(latest.circuit)}` : ""}`
        : "No rounds yet";
      const detail = latest
        ? `${latest.classification?.length ?? 0} classified${latest.fastest_lap ? ` · FL ${esc(latest.fastest_lap.name)}` : ""}`
        : "waiting on the first result";
      return `<article class="official">
        <h3>${esc(division.name)} <span class="fia-count">${rounds.length} round(s)</span></h3>
        <p class="fia-round">${title}</p>
        <p class="empty-line">${detail}</p>
      </article>`;
    }).join("");
  }

  async function render() {
    try {
      if (!body) {
        const [lineups, results] = await Promise.all([
          fetchJson(LINEUPS_URL),
          fetchJson(RESULTS_URL).catch(() => null),
        ]);
        body = { lineups, results };
      }
      renderMeta(body.lineups, body.results);
      renderOfficials(body.lineups);
      renderSeason(body.results);
    } catch (error) {
      $("fia-officials").innerHTML = `<p class="empty-line">Could not read the published data (${esc(error.message)}).</p>`;
    }
  }

  $("fia-gate").addEventListener("submit", async (event) => {
    event.preventDefault();
    const entered = $("fia-password").value;
    const matches = (await digest(entered)) === CODE_SHA256;
    if (!matches) {
      note("That code is not recognised.", true);
      $("fia-password").select();
      return;
    }
    note("", false);
    sessionStorage.setItem(UNLOCK_KEY, "1");
    $("fia-gate").hidden = true;
    $("fia-body").hidden = false;
    $("fia-password").value = "";
    render();
  });

  $("fia-lock").addEventListener("click", () => {
    sessionStorage.removeItem(UNLOCK_KEY);
    body = null;
    $("fia-body").hidden = true;
    $("fia-gate").hidden = false;
    $("fia-password").value = "";
    note("Locked.", false);
    $("fia-password").focus();
  });

  window.addEventListener("hashchange", () => setMode(isOpen()));
  setMode(isOpen());
})();
