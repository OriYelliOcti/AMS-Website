// FIA race-control desk — rebuilt.
//
// Three things changed from the old desk:
//
//  1. Every driver in the league is available, from every division. Rounds get
//     raced cross-division (an F2 driver can take an F1 seat for a night), so
//     the grid editor no longer hides anyone behind a division filter.
//  2. The finishing order is pasted the way the timing screen prints it —
//     "Jamie LEADER", "Jeffz + 4.283", "Yoke + 1 LAP" — and parsed here.
//  3. Publishing no longer needs a GitHub token in the browser. It posts the
//     document to a small bridge on the laptop (desk_bridge.py), which holds
//     the token and commits through the site repo's own path.
//
// The access code is still a SHA-256 digest: concealment, not security. What
// protects the league is that publishing needs the bridge token, which lives
// on the laptop and never in this file.
(() => {
  "use strict";

  const CORE = window.AMSResults;
  const section = document.getElementById("fia");
  if (!section || !CORE) return;

  const HASH = "#ams-fia";
  const CODE_SHA256 = "387212a44247c12e2829f6f4c49c22c053ca58bba77bcd613d441bac4c716741";
  const UNLOCK_KEY = "ams-fia-unlocked";
  const BRIDGE_KEY = "ams-fia-bridge";
  const BRIDGE_TOKEN_KEY = "ams-fia-bridge-token";
  const AUTHOR_KEY = "ams-fia-author";
  const DEFAULT_BRIDGE = "http://127.0.0.1:8802";
  const RESULTS_PATH = "data/results.json";
  const LINEUPS_PATH = "data/lineups.json";
  const LOCALE = "en-GB";
  // Matches FASTEST_LAP_POINT in the bot's .env (default 1).
  const FL_POINT = 1;

  const $ = (id) => document.getElementById(id);
  const publicTitle = document.title;

  const state = {
    loaded: false,
    published: null,
    doc: null,
    dirty: false,
    busy: false,
    view: "rounds",
    division: null,
    round: null,
    grid: null,
    gridPaste: "",
    search: "",
    preview: null,
    bridge: sessionStorage.getItem(BRIDGE_KEY) || DEFAULT_BRIDGE,
    bridgeToken: sessionStorage.getItem(BRIDGE_TOKEN_KEY) || "",
    author: localStorage.getItem(AUTHOR_KEY) || "",
    lineups: null,
    drivers: [],
  };

  // Helpers ----------------------------------------------------------------- //

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  const text = (value) => String(value ?? "").trim();

  function initials(name) {
    const parts = String(name || "?").replace(/[^\p{L}\p{N}\s|]/gu, " ").split(/[\s|]+/).filter(Boolean);
    const picks = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
    return picks.map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
  }

  async function digest(value) {
    const bytes = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function stamp(iso) {
    if (!iso) return "never";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso);
    return date.toLocaleString(LOCALE, {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  }

  function say(message, isError = false) {
    const node = $("fia-status");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("error", !!isError);
  }

  // Drivers ----------------------------------------------------------------- //

  // "ASTO | Jamie" -> asto, jamie; "Jeffz | TGR | 99" -> jeffz, tgr, 99.
  // Every segment is a handle a steward might type, which is how a pasted
  // timing sheet resolves without anyone being renamed first.
  function keysFor(driver) {
    const keys = new Set();
    const add = (value) => {
      const clean = String(value || "").trim().toLowerCase();
      if (clean) keys.add(clean);
    };
    add(driver.username);
    add(driver.name);
    for (const segment of String(driver.name || "").split("|")) {
      add(segment.replace(/^[#\s]+/, ""));
      add(segment.replace(/[^\p{L}\p{N}]/gu, ""));
    }
    if (driver.username) add(String(driver.username).replace(/[^\p{L}\p{N}]/gu, ""));
    return Array.from(keys).filter((key) => key.length > 1);
  }


  function buildDrivers() {
    const byKey = new Map();
    for (const division of state.lineups?.divisions || []) {
      const divisionName = String(division.name || "").toUpperCase();
      for (const team of division.teams || []) {
        for (const slot of team.slots || []) {
          for (const member of slot.members || []) {
            if (member.bot) continue;
            const slotName = String(slot.slot || "Other").trim();
            const seat = slotName.toLowerCase();
            // Race seats only: drivers and the reserves who stand in for them.
            // No team bosses, principals, pit crew or other officials.
            if (seat !== "driver" && seat !== "reserve") continue;
            const entry = {
              name: text(member.name),
              username: text(member.username),
              team: text(team.short || team.name),
              teamFull: text(team.name),
              division: divisionName,
              slot: slotName,
              source: "lineup",
            };
            const key = (entry.username || entry.name).toLowerCase();
            const seen = byKey.get(key);
            // Someone listed as a reserve in one team and a driver in another
            // keeps the driver seat.
            if (!seen || (seen.slot.toLowerCase() === "reserve" && seat === "driver")) {
              byKey.set(key, entry);
            }
          }
        }
      }
    }

    // Anyone in a recorded result but not in the lineups (a guest, a driver
    // whose role was removed) stays visible — that is exactly the gap that
    // made three of seven drivers unfindable in the old grid.
    for (const division of state.doc?.divisions || []) {
      for (const round of division.rounds || []) {
        for (const entry of round.classification || []) {
          const key = (entry.username || entry.name || "").toLowerCase();
          if (!key || byKey.has(key)) continue;
          byKey.set(key, {
            name: text(entry.name),
            username: text(entry.username),
            team: text(entry.short || entry.team),
            teamFull: text(entry.team),
            division: String(division.name || "").toUpperCase(),
            slot: "Result only",
            source: "result",
          });
        }
      }
    }

    state.drivers = Array.from(byKey.values()).sort((a, b) => {
      const div = CORE.DIVISION_ORDER.indexOf(a.division) - CORE.DIVISION_ORDER.indexOf(b.division);
      if (div) return div;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return state.drivers;
  }

  function resolveDriver(value) {
    const needle = text(value).toLowerCase();
    if (!needle) return null;
    let best = null;
    let bestScore = 0;
    for (const driver of state.drivers) {
      for (const key of keysFor(driver)) {
        let score = 0;
        if (key === needle) score = 4;
        else if (key.startsWith(needle)) score = 3;
        else if (needle.includes(key) && key.length > 2) score = 2;
        else if (key.includes(needle)) score = 1;
        if (score > bestScore) {
          bestScore = score;
          best = driver;
        }
      }
    }
    return bestScore ? best : null;
  }

  // Finishing order parsing -------------------------------------------------- //

  // "1. Jamie LEADER" -> { name: "Jamie", gap: "LEADER", dnf: false }
  // A trailing number only counts as a gap when it looks like one: a leading
  // "+", a colon or a decimal, or the words LEADER / LAP. That stops
  // "Jeffz | TGR | 99" from being read as a 99-second gap.
  function parseLine(raw) {
    let line = String(raw || "").trim();
    if (!line || line.startsWith("#")) return null;

    line = line.replace(/^(?:p|pos(?:ition)?\.?\s*)?\d{1,2}\s*[.)\-–—]\s*/i, "").trim();

    let dnf = false;
    const dnfMatch = line.match(/[\s\-–—(]*\b(DNF|DNS|DSQ|RET|RETIRED)\b\)?\s*$/i);
    if (dnfMatch) {
      dnf = true;
      line = line.slice(0, dnfMatch.index).trim();
    }

    let gap = "";
    const leader = line.match(/\s+\b(LEADER|WINNER)\b\s*$/i);
    if (leader) {
      gap = "LEADER";
      line = line.slice(0, leader.index).trim();
    } else {
      const numeric = line.match(/\s+\+?\s*((?:\d+:)?\d+(?:[.,]\d+)?(?:\s*laps?)?|\d*\s*laps?)\s*$/i);
      if (numeric) {
        const captured = numeric[1].trim();
        const looksLikeGap = /\+/.test(line.slice(numeric.index))
          || /[:.,]/.test(captured)
          || /lap/i.test(captured);
        if (looksLikeGap) {
          gap = `+${captured.replace(/\s+/g, " ").replace(/^\+/, "")}`;
          line = line.slice(0, numeric.index).trim();
        }
      }
    }

    if (!line) return null;
    return { name: line, gap, dnf };
  }

  function parseGrid(source) {
    const rows = [];
    for (const raw of String(source || "").split(/\r?\n/)) {
      const parsed = parseLine(raw);
      if (!parsed) continue;
      const driver = resolveDriver(parsed.name);
      rows.push({
        name: driver ? driver.name : parsed.name,
        username: driver ? driver.username : "",
        team: driver ? driver.team : "",
        division: driver ? driver.division : "",
        matched: !!driver,
        gap: parsed.gap,
        dnf: parsed.dnf,
      });
    }
    return rows;
  }

  // Document access ---------------------------------------------------------- //

  function divisions() {
    return (state.doc?.divisions || []).map((division) => String(division.name || "").toUpperCase());
  }

  function divisionEntry(name) {
    return CORE.ensureDivision(state.doc, String(name || "").toUpperCase());
  }

  function roundsOf(name) {
    const entry = (state.doc?.divisions || []).find(
      (division) => String(division.name || "").toUpperCase() === String(name || "").toUpperCase()
    );
    return entry ? entry.rounds || [] : [];
  }

  function roundOf(divisionName, number) {
    return roundsOf(divisionName).find((round) => Number(round.round) === Number(number)) || null;
  }

  function slug(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  // Load --------------------------------------------------------------------- //

  async function fetchJson(path) {
    const response = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  }

  async function load(force = false) {
    if (state.loaded && !force) return;
    say("Loading the published season…");
    try {
      const [results, lineups] = await Promise.all([
        fetchJson(RESULTS_PATH),
        fetchJson(LINEUPS_PATH),
      ]);
      state.lineups = lineups || { divisions: [] };
      state.published = CORE.normalizeDocument(results || CORE.emptyDocument("Season 1"));
      state.doc = JSON.parse(JSON.stringify(state.published));
      state.loaded = true;
      state.dirty = false;
      state.preview = null;
      if (!state.division) state.division = divisions()[0] || CORE.DIVISION_ORDER[0];
      buildDrivers();
      say(`Season loaded — ${state.drivers.length} drivers on file.`);
    } catch (error) {
      say(`Could not load the season: ${error.message}`, true);
    }
    render();
  }

  // Rendering ---------------------------------------------------------------- //

  function renderChrome() {
    const dirty = $("fia-dirty");
    if (dirty) dirty.hidden = !state.dirty;
    const discard = $("fia-discard");
    if (discard) discard.hidden = !state.dirty;
    const publishButton = $("fia-publish");
    if (publishButton) publishButton.disabled = state.busy || !state.dirty;
    for (const button of section.querySelectorAll("[data-view]")) {
      button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
    }
    const meta = $("fia-meta");
    if (!meta) return;
    const rounds = (state.doc?.divisions || []).reduce((sum, division) => sum + (division.rounds || []).length, 0);
    const decisions = (state.doc?.divisions || []).reduce(
      (sum, division) => sum + (division.rounds || []).reduce(
        (inner, round) => inner + (round.penalties || []).length, 0
      ), 0
    );
    meta.innerHTML = [
      ["Season", esc(state.doc?.season || "—")],
      ["Rounds", String(rounds)],
      ["Decisions", String(decisions)],
      ["Drivers", String(state.drivers.length)],
      ["Published", esc(stamp(state.published?.updated_at))],
    ].map(([label, value]) => `<div class="fia-stat"><span>${label}</span><b>${value}</b></div>`).join("");
  }

  function render() {
    renderChrome();
    const view = $("fia-view");
    if (!view) return;
    if (!state.loaded) {
      view.innerHTML = '<p class="fia-note">Nothing loaded yet.</p>';
      return;
    }
    const builders = {
      rounds: roundsView,
      drivers: driversView,
      decisions: decisionsView,
      standings: standingsView,
      audit: auditView,
    };
    view.innerHTML = (builders[state.view] || roundsView)();
  }

  function divisionNav() {
    const names = divisions();
    if (!names.length) return '<p class="fia-note">No division has a round yet.</p>';
    return `<div class="fia-nav fia-nav-inline">${names.map((name) => (
      `<button type="button" data-action="division" data-division="${esc(name)}" aria-pressed="${name === state.division}">${esc(name)}</button>`
    )).join("")}</div>`;
  }

  function optionList(entries, selected, placeholder) {
    const head = placeholder ? `<option value="">${esc(placeholder)}</option>` : "";
    return head + entries.map((entry) => (
      `<option value="${esc(entry.id)}"${String(entry.id) === String(selected) ? " selected" : ""}>${esc(entry.label)}</option>`
    )).join("");
  }

  // Rounds view -------------------------------------------------------------- //

  function roundsView() {
    const division = state.division || divisions()[0];
    const rounds = roundsOf(division);
    const chips = rounds.map((round) => (
      `<button type="button" data-action="open-round" data-round="${round.round}" aria-pressed="${Number(state.round) === Number(round.round)}">R${esc(round.round)}${round.circuit ? ` · ${esc(round.circuit)}` : ""}</button>`
    )).join("");

    return `
      <div class="fia-toolbar-row">
        ${divisionNav()}
        <button type="button" class="action" data-action="new-round">New round</button>
      </div>
      <div class="fia-nav fia-nav-inline fia-roundnav">${chips || '<span class="fia-note">No round recorded in this division yet.</span>'}</div>
      ${state.grid ? gridEditor(division) : '<p class="fia-note">Pick a round above, or start a new one.</p>'}
      ${state.preview ? previewBlock() : ""}
    `;
  }

  function gridEditor(division) {
    const grid = state.grid;
    const driverOptions = state.drivers.map((driver) => ({
      id: driver.username || driver.name,
      label: `${driver.name} · ${driver.division} · ${driver.team || "no team"}`,
    }));

    const rows = grid.entries.map((entry, index) => {
      const key = entry.username || "";
      const known = state.drivers.some((driver) => (driver.username || driver.name) === key);
      const selected = known ? key : "";
      const extra = known ? "" : `<option value="" selected>${esc(entry.name || "— pick a driver —")}${entry.name ? " (not in lineups)" : ""}</option>`;
      return `
        <tr class="${entry.dnf ? "is-dnf" : ""} ${entry.matched === false ? "is-unknown" : ""}">
          <td class="fia-pos">${entry.dnf ? "—" : index + 1}</td>
          <td><select data-action="driver" data-index="${index}">${extra}${optionList(driverOptions, selected, "— pick a driver —")}</select></td>
          <td><input type="text" data-action="gap" data-index="${index}" value="${esc(entry.gap)}" placeholder="+0.000" spellcheck="false"></td>
          <td class="fia-toggle"><label><input type="checkbox" data-action="dnf" data-index="${index}"${entry.dnf ? " checked" : ""}> DNF</label></td>
          <td class="fia-rowtools">
            <button type="button" data-action="move" data-index="${index}" data-direction="-1" title="Move up"${index === 0 ? " disabled" : ""}>↑</button>
            <button type="button" data-action="move" data-index="${index}" data-direction="1" title="Move down"${index === grid.entries.length - 1 ? " disabled" : ""}>↓</button>
            <button type="button" data-action="remove-entry" data-index="${index}" title="Remove">✕</button>
          </td>
        </tr>`;
    }).join("");

    const inGrid = grid.entries
      .filter((entry) => entry.name)
      .map((entry) => ({ id: entry.username || entry.name, label: entry.name }));
    const table = CORE.pointsTable(divisionEntry(division));

    return `
      <div class="fia-roundedit">
        <div class="fia-form-grid">
          <label>Division<input type="text" value="${esc(grid.division)}" readonly></label>
          <label>Round<input type="number" min="1" max="99" data-action="round-number" value="${esc(grid.round)}"></label>
          <label>Circuit<input type="text" data-action="circuit" value="${esc(grid.circuit)}" placeholder="Bahrain International Circuit" spellcheck="false"></label>
          <label>Pole sitter<select data-action="pole">${optionList(inGrid, grid.pole, "— none —")}</select></label>
          <label>Fastest lap<select data-action="fastest">${optionList(inGrid, grid.fastest, "— none —")}</select></label>
        </div>

        <div class="fia-paste">
          <label for="fia-paste-box">Paste the timing sheet</label>
          <textarea id="fia-paste-box" data-action="paste" rows="5" spellcheck="false" placeholder="1. Jamie LEADER&#10;2. Jeffz + 4.283&#10;3. Yoke + 1 LAP&#10;- Theo DNF">${esc(state.gridPaste)}</textarea>
          <div class="fia-actions">
            <button type="button" class="action action-solid" data-action="parse-grid">Parse into the grid</button>
            <span class="fia-hint">Numbering, <code>LEADER</code>, <code>+ 4.283</code>, <code>+ 1 LAP</code> and <code>DNF</code> are all understood.</span>
          </div>
        </div>

        <table class="fia-grid">
          <thead><tr><th>P</th><th>Driver</th><th>Gap</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="fia-note">No entries yet — parse a timing sheet or add a driver.</td></tr>'}</tbody>
        </table>

        <div class="fia-actions">
          <button type="button" class="action" data-action="add-entry">Add driver</button>
          <button type="button" class="action action-solid" data-action="save-grid">Save round to draft</button>
          <button type="button" class="action" data-action="discard-grid">Close</button>
          ${roundOf(division, grid.round) ? '<button type="button" class="action fia-danger" data-action="delete-round">Delete round</button>' : ""}
        </div>
        <p class="fia-hint">Points: ${table.join(" · ")}. A DNF keeps the start but scores nothing.</p>
      </div>
    `;
  }

  // Drivers view ------------------------------------------------------------- //

  function driversView() {
    const needle = state.search.trim().toLowerCase();
    const rows = state.drivers.filter((driver) => {
      if (!needle) return true;
      return `${driver.name} ${driver.username} ${driver.team} ${driver.division}`.toLowerCase().includes(needle);
    });
    const counts = CORE.DIVISION_ORDER.map((name) => (
      `<span class="fia-chip">${esc(name)} ${state.drivers.filter((driver) => driver.division === name).length}</span>`
    )).join(" ");

    return `
      <div class="fia-toolbar-row">
        <input type="search" data-action="search" value="${esc(state.search)}" placeholder="Search every driver, any division" spellcheck="false">
        <div class="fia-chips">${counts}</div>
      </div>
      <p class="fia-hint">Race drivers and reserves — team bosses, principals, pit crew and other officials are not listed. Anyone who only exists in a recorded result is kept.</p>
      <table class="fia-grid">
        <thead><tr><th></th><th>Driver</th><th>Division</th><th>Team</th><th>Seat</th></tr></thead>
        <tbody>${rows.map((driver) => `
          <tr>
            <td class="fia-avatar">${esc(initials(driver.name))}</td>
            <td><b>${esc(driver.name)}</b><br><span class="fia-sub">@${esc(driver.username || "—")}</span></td>
            <td>${esc(driver.division)}</td>
            <td>${esc(driver.team || "—")}</td>
            <td>${driver.source === "result"
              ? '<span class="fia-chip fia-chip-warn">result only</span>'
              : driver.slot.toLowerCase() === "reserve"
                ? '<span class="fia-chip">reserve</span>'
                : esc(driver.slot)}</td>
          </tr>`).join("") || '<tr><td colspan="5" class="fia-note">Nobody matches that search.</td></tr>'}</tbody>
      </table>
      <p class="fia-note">${rows.length} of ${state.drivers.length} drivers shown.</p>
    `;
  }

  // Decisions view ----------------------------------------------------------- //

  function decisionsView() {
    const division = state.division || divisions()[0];
    const rounds = roundsOf(division);
    const roundOptions = rounds.map((round) => ({
      id: round.round,
      label: `R${round.round}${round.circuit ? ` · ${round.circuit}` : ""}`,
    }));
    const driverOptions = state.drivers.map((driver) => ({
      id: driver.username || driver.name,
      label: `${driver.name} · ${driver.division}`,
    }));
    const types = CORE.PENALTY_TYPES.map((type) => ({ id: type.id, label: type.label }));

    const list = rounds.flatMap((round) => (round.penalties || []).map((penalty) => `
      <tr>
        <td>R${esc(round.round)}</td>
        <td>${esc(penalty.name || penalty.key || "—")}</td>
        <td>${esc(CORE.penaltyLabel(penalty))}</td>
        <td>${esc(penalty.reason || "")}</td>
        <td class="fia-rowtools"><button type="button" data-action="remove-penalty" data-round="${round.round}" data-id="${esc(penalty.id)}" title="Remove">✕</button></td>
      </tr>`));

    return `
      <div class="fia-toolbar-row">${divisionNav()}</div>
      <form class="fia-form" data-form="penalty">
        <div class="fia-form-grid">
          <label>Round<select name="round">${optionList(roundOptions, rounds[0]?.round, "—")}</select></label>
          <label>Driver<select name="driver">${optionList(driverOptions, "", "— pick a driver —")}</select></label>
          <label>Decision<select name="type">${optionList(types, "points", "—")}</select></label>
          <label>Value<input type="number" name="value" min="0" step="1" value="0"></label>
        </div>
        <label>Reason<input type="text" name="reason" placeholder="Causing a collision at turn 4" spellcheck="false"></label>
        <div class="fia-actions"><button type="submit" class="action action-solid">Add decision to draft</button></div>
      </form>
      <table class="fia-grid">
        <thead><tr><th>Round</th><th>Driver</th><th>Decision</th><th>Reason</th><th></th></tr></thead>
        <tbody>${list.join("") || '<tr><td colspan="5" class="fia-note">No decisions recorded in this division.</td></tr>'}</tbody>
      </table>
      <p class="fia-hint">Only <b>points deductions</b> and <b>disqualifications</b> move a table. Everything else is published as a decision only.</p>
    `;
  }

  // Standings view ----------------------------------------------------------- //

  function standingsFor(doc) {
    const out = {};
    for (const division of doc?.divisions || []) {
      const name = String(division.name || "").toUpperCase();
      const computed = CORE.computeStandings(division.rounds || []);
      out[name] = {
        drivers: (computed.drivers || []).map((row) => ({
          ...row,
          key: String(row.username || row.name || "").toLowerCase(),
        })),
        teams: computed.teams || [],
      };
    }
    return out;
  }

  function standingsView() {
    const before = standingsFor(state.published);
    return divisions().map((division) => {
      const after = standingsFor(state.doc)[division] || { drivers: [], teams: [] };
      const old = before[division] || { drivers: [], teams: [] };
      const oldRank = new Map(old.drivers.map((row, index) => [row.key, index]));
      const rows = after.drivers.map((row, index) => {
        const was = oldRank.get(row.key);
        const delta = was === undefined ? "new" : was - index;
        const chip = delta === "new"
          ? '<span class="fia-chip fia-chip-new">new</span>'
          : delta === 0 ? "" : `<span class="fia-chip ${delta > 0 ? "fia-chip-up" : "fia-chip-down"}">${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)}</span>`;
        return `<tr>
          <td class="fia-pos">${index + 1}</td>
          <td>${esc(row.name)} ${chip}</td>
          <td>${esc(row.team || "—")}</td>
          <td class="fia-num">${row.points}</td>
          <td class="fia-num">${row.starts}</td>
          <td class="fia-num">${row.wins}</td>
          <td class="fia-num">${row.poles}</td>
          <td class="fia-num">${row.fastest_laps}</td>
        </tr>`;
      }).join("");
      return `
        <h3 class="fia-round">${esc(division)} — drivers</h3>
        <table class="fia-grid">
          <thead><tr><th>P</th><th>Driver</th><th>Team</th><th>Pts</th><th>Starts</th><th>Wins</th><th>Poles</th><th>FL</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="8" class="fia-note">No classified driver yet.</td></tr>'}</tbody>
        </table>
        <h3 class="fia-round">${esc(division)} — constructors</h3>
        <table class="fia-grid">
          <thead><tr><th>P</th><th>Team</th><th>Pts</th><th>Wins</th><th>Podiums</th></tr></thead>
          <tbody>${after.teams.map((row, index) => `<tr>
            <td class="fia-pos">${index + 1}</td><td>${esc(row.name)}</td>
            <td class="fia-num">${row.points}</td><td class="fia-num">${row.wins}</td><td class="fia-num">${row.podiums}</td>
          </tr>`).join("") || '<tr><td colspan="5" class="fia-note">No constructor points yet.</td></tr>'}</tbody>
        </table>`;
    }).join("");
  }

  // Audit view --------------------------------------------------------------- //

  function auditView() {
    const entries = (state.doc?.audit || []).slice().reverse();
    return `
      <table class="fia-grid">
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
        <tbody>${entries.map((entry) => `<tr>
          <td>${esc(stamp(entry.at))}</td>
          <td>${esc(entry.by || "FIA")}</td>
          <td>${esc(entry.action)}</td>
          <td>${esc(entry.detail)}</td>
        </tr>`).join("") || '<tr><td colspan="4" class="fia-note">Nothing has been changed yet.</td></tr>'}</tbody>
      </table>`;
  }

  // Preview ------------------------------------------------------------------ //

  function buildPreview() {
    const before = state.published;
    const after = state.doc;
    const changes = [];
    for (const division of after.divisions || []) {
      const name = String(division.name || "").toUpperCase();
      const oldRounds = (before.divisions || []).find((d) => String(d.name).toUpperCase() === name)?.rounds || [];
      for (const round of division.rounds || []) {
        const old = oldRounds.find((r) => Number(r.round) === Number(round.round));
        const oldText = old ? JSON.stringify({ c: old.classification, p: old.penalties }) : "";
        const newText = JSON.stringify({ c: round.classification, p: round.penalties });
        if (oldText !== newText) {
          changes.push({
            label: `${name} R${round.round}${round.circuit ? ` · ${round.circuit}` : ""}`,
            detail: old ? "changed" : "new round",
          });
        }
      }
      for (const round of oldRounds) {
        if (!(division.rounds || []).some((r) => Number(r.round) === Number(round.round))) {
          changes.push({ label: `${name} R${round.round}`, detail: "removed" });
        }
      }
    }

    const beforeTables = standingsFor(before);
    const afterTables = standingsFor(after);
    const deltas = [];
    for (const [division, table] of Object.entries(afterTables)) {
      const oldRows = new Map((beforeTables[division]?.drivers || []).map((row) => [row.key, row]));
      for (const row of table.drivers) {
        const old = oldRows.get(row.key);
        const diff = row.points - (old?.points ?? 0);
        if (diff !== 0) deltas.push({ name: row.name, division, diff });
      }
      for (const row of beforeTables[division]?.drivers || []) {
        if (!table.drivers.some((entry) => entry.key === row.key)) {
          deltas.push({ name: row.name, division, diff: -row.points });
        }
      }
    }
    return { changes, deltas };
  }

  function previewBlock() {
    const preview = state.preview;
    if (!preview) return "";
    const changes = preview.changes.length
      ? preview.changes.map((change) => `<li><b>${esc(change.label)}</b> — ${esc(change.detail)}</li>`).join("")
      : "<li>No round changes.</li>";
    const deltas = preview.deltas.length
      ? preview.deltas.map((delta) => `<li>${esc(delta.name)} <span class="${delta.diff > 0 ? "up" : "down"}">${delta.diff > 0 ? "+" : ""}${delta.diff} pts</span> <span class="fia-sub">${esc(delta.division)}</span></li>`).join("")
      : "<li>No championship totals change.</li>";
    return `
      <div class="fia-preview">
        <h3>Before you publish</h3>
        <div class="fia-preview-grid">
          <div><h4>Rounds</h4><ul>${changes}</ul></div>
          <div><h4>Championship</h4><ul>${deltas}</ul></div>
        </div>
        <p class="fia-hint">Publishing commits <code>${RESULTS_PATH}</code> in the site repo. Nothing is written until the bridge accepts it.</p>
      </div>`;
  }

  // Editing ------------------------------------------------------------------ //

  function openRound(division, number) {
    const existing = roundOf(division, number);
    state.division = division;
    state.round = Number(number);
    state.grid = {
      division,
      round: Number(number),
      circuit: existing?.circuit || "",
      pole: existing?.pole?.username || "",
      fastest: existing?.fastest_lap?.username || "",
      entries: (existing?.classification || []).map((entry) => ({
        name: entry.name,
        username: entry.username,
        team: entry.short || entry.team || "",
        matched: true,
        gap: entry.gap || "",
        dnf: entry.status === "retired" || entry.position === null,
      })),
    };
    state.preview = null;
    render();
  }

  function newRound() {
    const division = state.division || divisions()[0];
    const numbers = roundsOf(division).map((round) => Number(round.round) || 0);
    const next = numbers.length ? Math.max(...numbers) + 1 : 1;
    state.grid = { division, round: next, circuit: "", pole: "", fastest: "", entries: [] };
    state.round = next;
    state.preview = null;
    render();
  }

  function personFromKey(key) {
    if (!key) return null;
    const driver = state.drivers.find((entry) => (entry.username || entry.name) === key);
    if (!driver) return null;
    return { name: driver.name, username: driver.username, team: driver.team };
  }

  function gridSave() {
    const grid = state.grid;
    if (!grid) return;
    if (!grid.entries.length) {
      say("The grid is empty — nothing to save.", true);
      return;
    }
    const entry = divisionEntry(grid.division);
    const table = CORE.pointsTable(entry);
    let position = 0;
    const classification = grid.entries.map((row) => {
      if (!row.dnf) position += 1;
      return {
        position: row.dnf ? null : position,
        name: row.name,
        username: row.username || "",
        team: row.team || "",
        short: row.team || "",
        status: row.dnf ? "retired" : "classified",
        points: row.dnf ? 0 : CORE.pointsFor(table, position),
        gap: row.gap || "",
      };
    });

    // The fastest-lap point is stored on the classification, not derived at
    // render time, because it only counts for a driver who finished in the
    // points. This mirrors build_classification() in the bot.
    if (grid.fastest && FL_POINT) {
      const scorer = classification.find(
        (row) => (row.username || row.name) === grid.fastest && row.position !== null && row.points > 0
      );
      if (scorer) scorer.points += FL_POINT;
    }

    const existing = (entry.rounds || []).find((round) => Number(round.round) === Number(grid.round));
    const round = {
      round: Number(grid.round),
      circuit: grid.circuit,
      pole: personFromKey(grid.pole),
      fastest_lap: personFromKey(grid.fastest),
      recorded_at: new Date().toISOString(),
      recorded_by: state.author || "FIA",
      classification,
      penalties: existing?.penalties || [],
    };
    entry.rounds = (entry.rounds || []).filter((item) => Number(item.round) !== Number(grid.round));
    entry.rounds.push(round);
    entry.rounds.sort((a, b) => Number(a.round) - Number(b.round));
    CORE.refreshStandings(state.doc);
    CORE.audit(state.doc, {
      action: existing ? "round replaced" : "round recorded",
      detail: `${grid.division} R${grid.round} · ${classification.length} classified · by ${state.author || "FIA"}`,
      by: state.author || "FIA",
    });
    state.dirty = true;
    state.preview = null;
    state.round = Number(grid.round);
    buildDrivers();
    say(`${grid.division} R${grid.round} saved to the draft — publish to make it live.`);
    render();
  }

  function addPenalty(form) {
    const data = new FormData(form);
    const division = state.division || divisions()[0];
    const entry = divisionEntry(division);
    const number = Number(data.get("round"));
    const round = (entry.rounds || []).find((item) => Number(item.round) === number);
    if (!round) {
      say("That round is not in the draft yet.", true);
      return;
    }
    const key = String(data.get("driver") || "");
    const driver = state.drivers.find((item) => (item.username || item.name) === key);
    if (!driver) {
      say("Pick a driver first.", true);
      return;
    }
    const type = String(data.get("type") || "points");
    const value = Math.max(0, Number(data.get("value") || 0));
    const penalty = {
      id: slug(`${Date.now()}-${key}-${type}`),
      key: (driver.username || driver.name).toLowerCase(),
      name: driver.name,
      username: driver.username,
      team: driver.team,
      type,
      value,
      reason: String(data.get("reason") || ""),
      by: state.author || "FIA",
      at: new Date().toISOString(),
    };
    round.penalties = round.penalties || [];
    round.penalties.push(penalty);
    CORE.refreshStandings(state.doc);
    CORE.audit(state.doc, {
      action: "decision",
      detail: `${division} R${number} · ${driver.name} · ${CORE.penaltyLabel(penalty)}${penalty.reason ? ` — ${penalty.reason}` : ""}`,
      by: state.author || "FIA",
    });
    state.dirty = true;
    state.preview = null;
    say(`Decision added: ${driver.name} — ${CORE.penaltyLabel(penalty)}.`);
    render();
  }

  // Bridge ------------------------------------------------------------------- //

  async function bridgeCall(path, body) {
    if (!state.bridgeToken) throw new Error("No bridge token yet — open Publish settings and paste it.");
    const response = await fetch(`${state.bridge.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.bridgeToken}` },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.problem || `Bridge answered HTTP ${response.status}`);
    return data;
  }

  function bridgeHint(error) {
    const offline = /Failed to fetch|NetworkError|Load failed|NetworkError when/i.test(String(error?.message || ""));
    if (!offline) return error.message;
    if (location.protocol === "https:") {
      return `Could not reach ${state.bridge}. Browsers block plain http from an https page — open the desk locally (python -m http.server 8080 in the site folder) or run the bridge on this machine.`;
    }
    return `Could not reach ${state.bridge}. Is desk_bridge.py running on the laptop?`;
  }

  async function publish() {
    if (state.busy) return;
    state.busy = true;
    renderChrome();
    try {
      const document = JSON.parse(JSON.stringify(state.doc));
      CORE.audit(document, {
        action: "published",
        detail: `${(document.divisions || []).reduce((sum, division) => sum + (division.rounds || []).length, 0)} rounds · by ${state.author || "FIA"}`,
        by: state.author || "FIA",
      });
      document.updated_at = new Date().toISOString();
      say("Publishing through the bridge…");
      const data = await bridgeCall("/publish", { document, author: state.author || "FIA" });
      state.published = JSON.parse(JSON.stringify(document));
      state.doc = JSON.parse(JSON.stringify(document));
      state.dirty = false;
      state.preview = null;
      say(data?.message || "Published.");
      buildDrivers();
    } catch (error) {
      say(`Publish failed: ${bridgeHint(error)}`, true);
    } finally {
      state.busy = false;
      render();
    }
  }

  async function checkBridge() {
    const note = $("fia-settings-note");
    try {
      const response = await fetch(`${state.bridge.replace(/\/$/, "")}/health`, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      // The bridge's /health is public through the tunnel, so it must not
      // expose the machine name — and neither should this line.
      note.textContent = response.ok
        ? "Bridge is up — publishing is ready."
        : `Bridge answered HTTP ${response.status}.`;
    } catch (error) {
      note.textContent = bridgeHint(error);
    }
  }

  // Gate --------------------------------------------------------------------- //

  async function checkAccess(event) {
    event.preventDefault();
    const input = $("fia-password");
    const note = $("fia-gate-note");
    const value = String(input.value || "");
    if (!value) return;
    const hashed = await digest(value);
    if (hashed === CODE_SHA256) {
      sessionStorage.setItem(UNLOCK_KEY, "1");
      note.textContent = "";
      note.classList.remove("error");
      setMode(true);
      await load();
      return;
    }
    note.textContent = "That code is not right.";
    note.classList.add("error");
    input.value = "";
  }

  function setMode(unlocked) {
    $("fia-body").hidden = !unlocked;
    $("fia-gate").hidden = unlocked;
    section.classList.toggle("is-unlocked", unlocked);
    document.title = unlocked ? `FIA · ${publicTitle}` : publicTitle;
    if (!unlocked) sessionStorage.removeItem(UNLOCK_KEY);
  }

  function isOpen() {
    return sessionStorage.getItem(UNLOCK_KEY) === "1";
  }

  // Events ------------------------------------------------------------------- //

  section.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    const lock = event.target.closest("#fia-lock");
    if (lock) {
      setMode(false);
      return;
    }
    if (!button) return;
    const action = button.dataset.action;

    if (action === "division") {
      state.division = button.dataset.division;
      state.grid = null;
      state.round = null;
      state.preview = null;
      render();
      return;
    }
    if (action === "open-round") {
      openRound(state.division, button.dataset.round);
      return;
    }
    if (action === "new-round") {
      newRound();
      return;
    }
    if (action === "parse-grid") {
      const rows = parseGrid(state.gridPaste);
      if (!rows.length) {
        say("Nothing parsed — paste one driver per line.", true);
        return;
      }
      state.grid.entries = rows;
      const unknown = rows.filter((row) => !row.matched).map((row) => row.name);
      say(unknown.length
        ? `${rows.length} parsed. Not in the lineups: ${unknown.join(", ")} — kept as typed.`
        : `${rows.length} drivers parsed.`);
      render();
      return;
    }
    if (action === "add-entry") {
      state.grid.entries.push({ name: "", username: "", team: "", matched: true, gap: "", dnf: false });
      render();
      return;
    }
    if (action === "move") {
      const index = Number(button.dataset.index);
      const offset = Number(button.dataset.direction);
      const list = state.grid.entries;
      const next = index + offset;
      if (next < 0 || next >= list.length) return;
      const moved = list[index];
      list[index] = list[next];
      list[next] = moved;
      render();
      return;
    }
    if (action === "remove-entry") {
      state.grid.entries.splice(Number(button.dataset.index), 1);
      render();
      return;
    }
    if (action === "save-grid") {
      gridSave();
      return;
    }
    if (action === "discard-grid") {
      state.grid = null;
      state.round = null;
      render();
      return;
    }
    if (action === "delete-round") {
      const entry = divisionEntry(state.grid.division);
      const removed = Number(state.grid.round);
      entry.rounds = (entry.rounds || []).filter((round) => Number(round.round) !== removed);
      CORE.refreshStandings(state.doc);
      CORE.audit(state.doc, {
        action: "round removed",
        detail: `${state.grid.division} R${removed}`,
        by: state.author || "FIA",
      });
      state.dirty = true;
      state.grid = null;
      state.round = null;
      state.preview = null;
      say("Round removed from the draft.");
      render();
      return;
    }
    if (action === "remove-penalty") {
      const division = state.division || divisions()[0];
      const entry = divisionEntry(division);
      const round = (entry.rounds || []).find((item) => Number(item.round) === Number(button.dataset.round));
      if (!round) return;
      round.penalties = (round.penalties || []).filter((penalty) => penalty.id !== button.dataset.id);
      CORE.refreshStandings(state.doc);
      CORE.audit(state.doc, {
        action: "decision removed",
        detail: `${division} R${button.dataset.round}`,
        by: state.author || "FIA",
      });
      state.dirty = true;
      say("Decision removed from the draft.");
      render();
      return;
    }
    if (action === "preview") {
      state.preview = buildPreview();
      render();
      return;
    }
    if (action === "publish") {
      publish();
      return;
    }
    if (action === "discard") {
      state.doc = JSON.parse(JSON.stringify(state.published));
      state.dirty = false;
      state.grid = null;
      state.preview = null;
      buildDrivers();
      say("Draft discarded.");
      render();
      return;
    }
    if (action === "check-bridge") {
      checkBridge();
      return;
    }
    if (action === "forget") {
      sessionStorage.removeItem(BRIDGE_TOKEN_KEY);
      state.bridgeToken = "";
      $("fia-bridge-token").value = "";
      $("fia-settings-note").textContent = "Bridge token forgotten.";
      return;
    }
    if (action === "settings") {
      const panel = $("fia-settings");
      panel.hidden = !panel.hidden;
      button.setAttribute("aria-expanded", String(!panel.hidden));
      return;
    }
    if (action === "view") {
      state.view = button.dataset.view;
      state.preview = null;
      render();
    }
  });

  section.addEventListener("change", (event) => {
    const target = event.target;
    const action = target.dataset.action;
    if (!action || !state.grid) return;
    if (action === "driver") {
      const index = Number(target.dataset.index);
      const driver = state.drivers.find((entry) => (entry.username || entry.name) === target.value);
      state.grid.entries[index] = {
        ...state.grid.entries[index],
        name: driver ? driver.name : "",
        username: driver ? driver.username : "",
        team: driver ? driver.team : "",
        matched: !!driver,
      };
      render();
      return;
    }
    if (action === "dnf") {
      state.grid.entries[Number(target.dataset.index)].dnf = target.checked;
      render();
      return;
    }
    if (action === "pole") {
      state.grid.pole = target.value;
      return;
    }
    if (action === "fastest") {
      state.grid.fastest = target.value;
      return;
    }
    if (action === "round-number") {
      state.grid.round = Math.max(1, Number(target.value || 1));
      return;
    }
    if (action === "circuit") {
      state.grid.circuit = target.value;
    }
  });

  section.addEventListener("input", (event) => {
    const target = event.target;
    const action = target.dataset.action;
    if (!action) return;
    if (action === "gap" && state.grid) {
      state.grid.entries[Number(target.dataset.index)].gap = target.value;
      return;
    }
    if (action === "paste") {
      state.gridPaste = target.value;
      return;
    }
    if (action === "search") {
      state.search = target.value;
      render();
      const next = $("fia-view").querySelector('[data-action="search"]');
      if (next) {
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
      }
      return;
    }
    if (action === "circuit" && state.grid) state.grid.circuit = target.value;
  });

  section.addEventListener("submit", (event) => {
    const form = event.target;
    if (form.id === "fia-gate") {
      checkAccess(event);
      return;
    }
    if (form.dataset.form === "penalty") {
      event.preventDefault();
      addPenalty(form);
    }
  });

  // Boot --------------------------------------------------------------------- //

  const bridgeInput = $("fia-bridge");
  const tokenInput = $("fia-bridge-token");
  const authorInput = $("fia-author");
  if (bridgeInput) bridgeInput.value = state.bridge;
  if (tokenInput) tokenInput.value = state.bridgeToken;
  if (authorInput) authorInput.value = state.author;

  for (const input of [bridgeInput, tokenInput, authorInput]) {
    if (!input) continue;
    input.addEventListener("input", () => {
      if (input === bridgeInput) {
        state.bridge = input.value.trim() || DEFAULT_BRIDGE;
        sessionStorage.setItem(BRIDGE_KEY, state.bridge);
      } else if (input === tokenInput) {
        state.bridgeToken = input.value.trim();
        sessionStorage.setItem(BRIDGE_TOKEN_KEY, state.bridgeToken);
      } else {
        state.author = input.value.trim();
        localStorage.setItem(AUTHOR_KEY, state.author);
      }
    });
  }

  // The desk is not a section of the page, it replaces it. body[data-fia="on"]
  // is what hides everything else (see the "desk replaces the page" rule in
  // style.css); without it the panel renders far down the normal site and
  // looks like it never opened.
  function syncFromHash() {
    const on = location.hash.toLowerCase() === HASH;
    document.body.dataset.fia = on ? "on" : "";
    section.hidden = !on;
    if (!on) return;
    window.scrollTo({ top: 0 });
    if (isOpen()) {
      setMode(true);
      if (!state.loaded) load();
    } else {
      setMode(false);
      const input = $("fia-password");
      if (input) input.focus();
    }
  }

  window.addEventListener("hashchange", syncFromHash);
  if (location.hash.toLowerCase() === HASH) syncFromHash();
})();
