// FIA race-control desk — rebuilt.
//
// Three things changed from the old desk:
//
//  1. Every driver in the league is available, from every division. Rounds get
//     raced cross-division (an F2 driver can take an F1 seat for a night), so
//     the grid editor no longer hides anyone behind a division filter.
//  2. The finishing order is pasted the way the timing screen prints it —
//     "Jamie LEADER", "Jeffz + 4.283", "Yoke + 1 LAP" — and parsed here.
//  3. Publishing is laptop-local only. The bridge (desk_bridge.py) serves this
//     desk on 127.0.0.1, holds the GitHub credential server-side and commits the
//     document without asking the browser for a token or an access key.
//
// The access code below remains for the public copy of the desk. When the desk
// is opened from loopback it unlocks directly: the bridge is bound to the
// laptop and is the only thing that can publish.
(() => {
  "use strict";

  const CORE = window.AMSResults;
  const section = document.getElementById("fia");
  if (!section || !CORE) return;

  const HASH = "#ams-fia";
  const CODE_SHA256 = "387212a44247c12e2829f6f4c49c22c053ca58bba77bcd613d441bac4c716741";
  const UNLOCK_KEY = "ams-fia-unlocked";
  const AUTHOR_KEY = "ams-fia-author";
  const DRAFT_KEY = "ams-fia-local-draft-v2";
  const DEFAULT_BRIDGE = "http://127.0.0.1:8802";
  const RESULTS_PATH = "data/results.json";
  const LINEUPS_PATH = "data/lineups.json";
  const LOCALE = "en-GB";
  const HISTORY_LIMIT = 50;
  const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  // Matches FASTEST_LAP_POINT in the bot's .env (default 1).
  const FL_POINT = 1;

  const $ = (id) => document.getElementById(id);
  const publicTitle = document.title;

  function localDesk() {
    return ["http:", "https:"].includes(location.protocol) && LOCAL_HOSTS.has(location.hostname);
  }

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
    local: localDesk(),
    // Always the laptop bridge. The bridge also serves this page, so the call
    // is same-origin; a locally served copy on another port still reaches it.
    bridge: DEFAULT_BRIDGE,
    author: localStorage.getItem(AUTHOR_KEY) || "",
    lineups: null,
    drivers: [],
    history: [],
    future: [],
    recovery: null,
    autoSavedAt: null,
    validation: null,
    roundFilter: "",
    decisionQuery: "",
    decisionType: "all",
    decisionRound: "all",
    auditFilter: "",
    sortDrivers: "position",
    sortTeams: "position",
    sortDriversDir: 1,
    sortTeamsDir: 1,
    modal: "",
    paletteQuery: "",
    paletteIndex: 0,
    searchQuery: "",
    profileKey: null,
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

  const clone = (value) => JSON.parse(JSON.stringify(value));

  // Draft history + autosave ------------------------------------------------ //

  function persistDraft() {
    if (!state.doc) return;
    try {
      const payload = {
        version: 2,
        at: new Date().toISOString(),
        author: state.author,
        doc: state.doc,
      };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
      state.autoSavedAt = payload.at;
    } catch (error) {
      // Private mode or a full quota: the desk still works, just without recovery.
    }
  }

  function clearSavedDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (error) { /* ignore */ }
    state.autoSavedAt = null;
    state.recovery = null;
  }

  function readSavedDraft() {
    try {
      const payload = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
      if (!payload || typeof payload !== "object" || !payload.doc) return null;
      return payload;
    } catch (error) {
      return null;
    }
  }

  function markDirty(message) {
    state.dirty = true;
    state.preview = null;
    persistDraft();
    renderChrome();
    if (message) say(message);
  }

  function recordHistory(label) {
    if (!state.doc) return;
    state.history.push({ doc: clone(state.doc), label });
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
    state.future = [];
  }

  function undoDraft() {
    if (!state.history.length) {
      say("Nothing to undo.", true);
      return;
    }
    state.future.push({ doc: clone(state.doc), label: "redo" });
    const entry = state.history.pop();
    state.doc = entry.doc;
    state.dirty = true;
    state.preview = null;
    state.validation = null;
    CORE.refreshStandings(state.doc);
    buildDrivers();
    persistDraft();
    say(`Undid ${entry.label}.`);
    render();
  }

  function redoDraft() {
    if (!state.future.length) {
      say("Nothing to redo.", true);
      return;
    }
    state.history.push({ doc: clone(state.doc), label: "undo" });
    const entry = state.future.pop();
    state.doc = entry.doc;
    state.dirty = true;
    state.preview = null;
    state.validation = null;
    CORE.refreshStandings(state.doc);
    buildDrivers();
    persistDraft();
    say("Redid the last change.");
    render();
  }

  // Preflight --------------------------------------------------------------- //

  function validateDraft() {
    const errors = [];
    const warnings = [];
    const doc = state.doc;
    if (!doc || !Array.isArray(doc.divisions)) {
      return { errors: ["No season document is loaded."], warnings: [], checked: new Date().toISOString() };
    }

    const roundsSeen = new Set();
    for (const division of doc.divisions) {
      const divisionName = text(division.name).toUpperCase();
      const rounds = Array.isArray(division.rounds) ? division.rounds : [];
      if (!rounds.length) warnings.push(`${divisionName}: no rounds recorded yet.`);
      for (const round of rounds) {
        const key = `${divisionName} R${round.round}`;
        if (roundsSeen.has(key)) errors.push(`${key}: duplicate round number.`);
        roundsSeen.add(key);
        if (!text(round.circuit)) warnings.push(`${key}: no circuit name.`);

        const seen = new Map();
        let classified = 0;
        for (const entry of round.classification || []) {
          const name = text(entry.name);
          if (!name) {
            errors.push(`${key}: an entry has no driver name.`);
            continue;
          }
          const driverKey = CORE.keyOf(entry) || name.toLowerCase();
          if (seen.has(driverKey)) errors.push(`${key}: ${name} appears twice.`);
          seen.set(driverKey, true);
          const retired = entry.status === "retired" || entry.position === null;
          if (retired) {
            if (text(entry.gap)) warnings.push(`${key}: ${name} is DNF but still has a gap.`);
          } else {
            classified += 1;
            if (!text(entry.gap)) warnings.push(`${key}: ${name} has no gap.`);
          }
          if (!(state.drivers || []).some((driver) => CORE.keyOf(driver) === driverKey)) {
            warnings.push(`${key}: ${name} is not in the current lineups (result-only entry).`);
          }
        }
        if (!classified) errors.push(`${key}: no classified finisher.`);

        for (const [label, person] of [["Pole", round.pole], ["Fastest lap", round.fastest_lap]]) {
          const personKey = CORE.keyOf(person);
          if (personKey && !seen.has(personKey)) {
            warnings.push(`${key}: ${label} ${person.name || personKey} is not in the classification.`);
          }
        }
        for (const penalty of round.penalties || []) {
          const personKey = CORE.keyOf(penalty);
          if (personKey && !seen.has(personKey)) {
            warnings.push(`${key}: decision for ${penalty.name || personKey}, who is not in this round.`);
          }
          if (!text(penalty.reason)) warnings.push(`${key}: a decision has no reason.`);
        }
      }
    }
    if (!roundsSeen.size) errors.push("The season has no rounds.");
    return { errors, warnings, checked: new Date().toISOString() };
  }

  function validationBlock(result = state.validation) {
    if (!result) return "";
    const list = (items, cls) => items.length
      ? `<ul class="${cls}">${items.slice(0, 12).map((item) => `<li>${esc(item)}</li>`).join("")}${items.length > 12 ? `<li>+${items.length - 12} more</li>` : ""}</ul>`
      : '<p class="fia-note">None.</p>';
    return `<section class="fia-validation ${result.errors.length ? "has-errors" : "is-clear"}" aria-live="polite">
      <div class="fia-section-head">
        <h3>Preflight · ${result.errors.length} error${result.errors.length === 1 ? "" : "s"} · ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}</h3>
        <button type="button" class="action" data-action="clear-validation">Hide</button>
      </div>
      <div class="fia-validation-grid">
        <div><h4>Errors · publishing is blocked</h4>${list(result.errors, "fia-error-list")}</div>
        <div><h4>Warnings · review before publishing</h4>${list(result.warnings, "fia-warning-list")}</div>
      </div>
    </section>`;
  }

  // Small data tools -------------------------------------------------------- //

  function sortRows(rows, key, direction = 1) {
    return [...rows].sort((left, right) => {
      const a = left?.[key];
      const b = right?.[key];
      if (typeof a === "number" || typeof b === "number") {
        const diff = Number(a ?? 0) - Number(b ?? 0);
        if (diff) return diff * direction;
      } else {
        const diff = String(a ?? "").localeCompare(String(b ?? ""), LOCALE, { sensitivity: "base" });
        if (diff) return diff * direction;
      }
      return (left?.position ?? 99) - (right?.position ?? 99);
    });
  }

  function csvCells(line, delimiter) {
    const cells = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') {
        if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
        else quoted = !quoted;
      } else if (char === delimiter && !quoted) {
        cells.push(value.trim());
        value = "";
      } else {
        value += char;
      }
    }
    cells.push(value.trim());
    return cells;
  }

  function parseCsvGrid(source) {
    const lines = String(source || "").split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) return null;
    const delimiter = lines[0].includes("\t") ? "\t" : ",";
    if (!lines[0].includes(delimiter)) return null;
    const header = csvCells(lines[0], delimiter).map((cell) => cell.toLowerCase());
    const nameIndex = header.findIndex((cell) => /^(driver|name|rider)$/.test(cell));
    if (nameIndex < 0) return null;
    const gapIndex = header.findIndex((cell) => /^(gap|interval|time|behind)$/.test(cell));
    const statusIndex = header.findIndex((cell) => /^(status|result|dnf)$/.test(cell));
    const teamIndex = header.findIndex((cell) => /^(team|constructor|short)$/.test(cell));
    const rows = [];
    for (const line of lines.slice(1)) {
      const cells = csvCells(line, delimiter);
      const rawName = text(cells[nameIndex]);
      if (!rawName) continue;
      const parsed = parseLine(rawName);
      if (!parsed) continue;
      const driver = resolveDriver(parsed.name);
      const rawGap = text(cells[gapIndex]);
      const rawStatus = text(cells[statusIndex]);
      const dnf = parsed.dnf || /\b(dnf|dns|dsq|ret|retired)\b/i.test(rawStatus) || /\b(dnf|dns|dsq|ret|retired)\b/i.test(rawGap);
      rows.push({
        name: driver ? driver.name : parsed.name,
        username: driver ? driver.username : "",
        team: driver ? driver.team : text(cells[teamIndex]),
        division: driver ? driver.division : "",
        matched: !!driver,
        gap: dnf ? "" : (rawGap || parsed.gap),
        dnf,
      });
    }
    return rows.length ? rows : null;
  }

  async function copyText(value) {
    const content = String(value ?? "");
    try {
      await navigator.clipboard.writeText(content);
      return true;
    } catch (error) {
      const input = document.createElement("textarea");
      input.value = content;
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      return copied;
    }
  }

  function downloadJson(filename, value) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function readTextFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Could not read that file."));
      reader.readAsText(file);
    });
  }

  function roundText(grid = state.grid) {
    if (!grid) return "";
    const lines = [`${grid.division} R${grid.round}${grid.circuit ? ` · ${grid.circuit}` : ""}`];
    let position = 0;
    for (const entry of grid.entries || []) {
      if (!entry.dnf) position += 1;
      lines.push(`${entry.dnf ? "DNF" : position}. ${entry.name}${entry.team ? ` (${entry.team})` : ""}${entry.dnf ? "" : entry.gap ? ` ${entry.gap}` : ""}`);
    }
    const pole = state.drivers.find((driver) => (driver.username || driver.name) === grid.pole);
    const fastest = state.drivers.find((driver) => (driver.username || driver.name) === grid.fastest);
    if (pole) lines.push(`Pole: ${pole.name}`);
    if (fastest) lines.push(`Fastest lap: ${fastest.name}`);
    return lines.join("\n");
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
    const fromCsv = parseCsvGrid(source);
    if (fromCsv) return fromCsv;
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
      state.history = [];
      state.future = [];
      state.validation = null;
      if (!state.division) state.division = divisions()[0] || CORE.DIVISION_ORDER[0];
      buildDrivers();
      const saved = readSavedDraft();
      state.autoSavedAt = saved?.at || null;
      state.recovery = saved && JSON.stringify(saved.doc) !== JSON.stringify(state.published) ? saved : null;
      say(`Season loaded — ${state.drivers.length} drivers on file.`);
      if (state.recovery) say("A newer local draft is available — restore it or dismiss it below.");
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
    if (publishButton) {
      publishButton.disabled = state.busy || !state.dirty || !state.local;
      publishButton.title = state.local
        ? "Publish through the laptop bridge"
        : "Open the local desk on the laptop to publish";
    }
    const undo = $("fia-undo");
    if (undo) undo.disabled = !state.history.length || state.busy;
    const redo = $("fia-redo");
    if (redo) redo.disabled = !state.future.length || state.busy;
    const autosave = $("fia-autosave");
    if (autosave) autosave.textContent = state.dirty
      ? `Autosaved ${state.autoSavedAt ? stamp(state.autoSavedAt) : "locally"}`
      : "Autosave ready";
    const localPill = $("fia-local-pill");
    if (localPill) {
      localPill.textContent = state.local ? "Laptop desk" : "Open on laptop to publish";
      localPill.classList.toggle("is-public", !state.local);
    }
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

  function recoveryBlock() {
    if (!state.recovery) return "";
    return `<section class="fia-recovery" aria-live="polite">
      <div>
        <b>A local draft from ${esc(stamp(state.recovery.at))} is waiting.</b>
        <span>It is newer than the published season and was saved automatically on this laptop.</span>
      </div>
      <div class="fia-actions">
        <button type="button" class="action action-solid" data-action="restore-draft">Restore draft</button>
        <button type="button" class="action" data-action="dismiss-recovery">Dismiss</button>
      </div>
    </section>`;
  }

  function render() {
    renderChrome();
    const view = $("fia-view");
    if (!view) return;
    if (!state.loaded) {
      view.innerHTML = `${recoveryBlock()}<p class="fia-note">Nothing loaded yet.</p>`;
      return;
    }
    const builders = {
      rounds: roundsView,
      drivers: driversView,
      decisions: decisionsView,
      standings: standingsView,
      audit: auditView,
    };
    view.innerHTML = `${recoveryBlock()}${(builders[state.view] || roundsView)()}`;
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
    const needle = state.roundFilter.trim().toLowerCase();
    const visible = rounds.filter((round) => !needle
      || `r${round.round} ${round.circuit || ""}`.toLowerCase().includes(needle));
    const chips = visible.map((round) => (
      `<button type="button" data-action="open-round" data-round="${round.round}" aria-pressed="${Number(state.round) === Number(round.round)}">R${esc(round.round)}${round.circuit ? ` · ${esc(round.circuit)}` : ""}</button>`
    )).join("");
    const current = rounds.findIndex((round) => Number(round.round) === Number(state.round));
    const totalRounds = rounds.length;
    const classified = rounds.reduce((sum, round) => sum + (round.classification || []).filter((entry) => Number.isInteger(entry.position)).length, 0);
    const decisions = rounds.reduce((sum, round) => sum + (round.penalties || []).length, 0);

    return `
      <div class="fia-toolbar-row">
        ${divisionNav()}
        <div class="fia-round-tools">
          <button type="button" class="action" data-action="prev-round" title="Previous round"${current <= 0 ? " disabled" : ""}>← R${current > 0 ? esc(rounds[current - 1].round) : ""}</button>
          <button type="button" class="action" data-action="next-round" title="Next round"${current < 0 || current >= totalRounds - 1 ? " disabled" : ""}>R${current >= 0 && current < totalRounds - 1 ? esc(rounds[current + 1].round) : ""} →</button>
          <button type="button" class="action" data-action="new-round">New round</button>
          <button type="button" class="action" data-action="validate">Preflight</button>
          <button type="button" class="action" data-action="print">Print</button>
        </div>
      </div>
      <div class="fia-toolbar-row fia-round-filter-row">
        <input type="search" data-action="round-filter" value="${esc(state.roundFilter)}" placeholder="Filter rounds by number or circuit" spellcheck="false">
        <span class="fia-note">${visible.length} of ${totalRounds} round${totalRounds === 1 ? "" : "s"} · ${classified} classified · ${decisions} decision${decisions === 1 ? "" : "s"}</span>
      </div>
      <div class="fia-nav fia-nav-inline fia-roundnav">${chips || '<span class="fia-note">No round recorded in this division yet.</span>'}</div>
      ${validationBlock()}
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
          <label for="fia-paste-box">Paste the timing sheet or CSV/TSV</label>
          <textarea id="fia-paste-box" data-action="paste" rows="5" spellcheck="false" placeholder="1. Jamie LEADER&#10;2. Jeffz + 4.283&#10;3. Yoke + 1 LAP&#10;- Theo DNF&#10;&#10;driver,gap,status&#10;Jamie,LEADER,classified">${esc(state.gridPaste)}</textarea>
          <div class="fia-actions">
            <button type="button" class="action action-solid" data-action="parse-grid">Parse into the grid</button>
            <button type="button" class="action" data-action="import-grid">Open CSV/TSV file</button>
            <span class="fia-hint">Numbering, <code>LEADER</code>, <code>+ 4.283</code>, <code>+ 1 LAP</code>, <code>DNF</code> and header rows are understood.</span>
          </div>
        </div>

        <table class="fia-grid">
          <thead><tr><th>P</th><th>Driver</th><th>Gap</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="fia-note">No entries yet — parse a timing sheet or add a driver.</td></tr>'}</tbody>
        </table>

        <div class="fia-actions">
          <button type="button" class="action" data-action="add-entry">Add driver</button>
          <button type="button" class="action" data-action="auto-fill">Fill from lineups</button>
          <button type="button" class="action action-solid" data-action="save-grid">Save round to draft</button>
          <button type="button" class="action" data-action="duplicate-round">Duplicate to next round</button>
          <button type="button" class="action" data-action="copy-round">Copy summary</button>
          <button type="button" class="action" data-action="discard-grid">Close</button>
          ${roundOf(division, grid.round) ? '<button type="button" class="action fia-danger" data-action="delete-round">Delete round</button>' : ""}
        </div>
        <p class="fia-hint">Points: ${table.join(" · ")}. A DNF keeps the start but scores nothing. The summary is ready to paste into Discord.</p>
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
            <td><button type="button" class="fia-link" data-action="driver-profile" data-driver="${esc(driver.username || driver.name)}"><b>${esc(driver.name)}</b></button><br><span class="fia-sub">@${esc(driver.username || "—")}</span></td>
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

  const DECISION_PRESETS = [
    { id: "collision", label: "Collision · 5s", type: "time", value: 5, reason: "Causing a collision" },
    { id: "track-limits", label: "Track limits · reprimand", type: "warning", value: 0, reason: "Repeated track limits" },
    { id: "unsafe-release", label: "Unsafe release · 10s", type: "time", value: 10, reason: "Unsafe release from a pit stop" },
    { id: "impeding", label: "Impeding · 3-place grid", type: "grid", value: 3, reason: "Impeding another driver" },
    { id: "contact-points", label: "Contact · 5-point deduction", type: "points", value: 5, reason: "Contact causing a points loss" },
    { id: "technical", label: "Technical · disqualification", type: "dsq", value: 0, reason: "Technical infringement" },
  ];

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
    const filterTypes = [{ id: "all", label: "All decisions" }, ...types];
    const filterRounds = [{ id: "all", label: "All rounds" }, ...roundOptions];

    const allRows = rounds.flatMap((round) => (round.penalties || []).map((penalty) => ({ round, penalty })));
    const needle = state.decisionQuery.trim().toLowerCase();
    const filtered = allRows.filter(({ round, penalty }) => {
      if (state.decisionType !== "all" && penalty.type !== state.decisionType) return false;
      if (state.decisionRound !== "all" && String(round.round) !== String(state.decisionRound)) return false;
      if (!needle) return true;
      return `${round.round} ${penalty.name || ""} ${penalty.key || ""} ${CORE.penaltyLabel(penalty)} ${penalty.reason || ""}`.toLowerCase().includes(needle);
    });
    const list = filtered.map(({ round, penalty }) => `
      <tr>
        <td>R${esc(round.round)}</td>
        <td>${esc(penalty.name || penalty.key || "—")}</td>
        <td>${esc(CORE.penaltyLabel(penalty))}</td>
        <td>${esc(penalty.reason || "")}</td>
        <td class="fia-rowtools"><button type="button" data-action="remove-penalty" data-round="${round.round}" data-id="${esc(penalty.id)}" title="Remove">✕</button></td>
      </tr>`);

    return `
      <div class="fia-toolbar-row">${divisionNav()}</div>
      <div class="fia-filter-row">
        <input type="search" data-action="decision-search" value="${esc(state.decisionQuery)}" placeholder="Filter decisions by driver, round, reason" spellcheck="false">
        <select data-action="decision-type">${optionList(filterTypes, state.decisionType, "")}</select>
        <select data-action="decision-round">${optionList(filterRounds, state.decisionRound, "")}</select>
        <button type="button" class="action" data-action="clear-decisions">Clear</button>
      </div>
      <form class="fia-form" data-form="penalty">
        <div class="fia-form-grid">
          <label>Round<select name="round">${optionList(roundOptions, rounds[0]?.round, "—")}</select></label>
          <label>Driver<select name="driver">${optionList(driverOptions, "", "— pick a driver —")}</select></label>
          <label>Decision<select name="type">${optionList(types, "points", "—")}</select></label>
          <label>Value<input type="number" name="value" min="0" step="1" value="0"></label>
        </div>
        <div class="fia-form-grid">
          <label>Quick preset<select data-action="decision-preset">${optionList(DECISION_PRESETS, "", "— choose a template —")}</select></label>
          <label>Reason<input type="text" name="reason" placeholder="Causing a collision at turn 4" spellcheck="false"></label>
        </div>
        <div class="fia-actions"><button type="submit" class="action action-solid">Add decision to draft</button></div>
      </form>
      <p class="fia-note">${filtered.length} of ${allRows.length} decisions shown.</p>
      <table class="fia-grid">
        <thead><tr><th>Round</th><th>Driver</th><th>Decision</th><th>Reason</th><th></th></tr></thead>
        <tbody>${list.join("") || '<tr><td colspan="5" class="fia-note">No decisions match this filter.</td></tr>'}</tbody>
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
    const sortButton = (table, key, label) => {
      const active = state[table === "drivers" ? "sortDrivers" : "sortTeams"] === key;
      const direction = state[table === "drivers" ? "sortDriversDir" : "sortTeamsDir"];
      return `<button type="button" class="fia-sort${active ? " is-active" : ""}" data-action="sort-standings" data-table="${table}" data-key="${key}" title="Sort by ${esc(label)}">${esc(label)}${active ? (direction > 0 ? " ↑" : " ↓") : ""}</button>`;
    };
    return divisions().map((division) => {
      const after = standingsFor(state.doc)[division] || { drivers: [], teams: [] };
      const old = before[division] || { drivers: [], teams: [] };
      const oldRank = new Map(old.drivers.map((row, index) => [row.key, index]));
      const driverRows = sortRows(after.drivers, state.sortDrivers, state.sortDriversDir);
      const rows = driverRows.map((row, index) => {
        const was = oldRank.get(row.key);
        const official = Number.isInteger(row.position) ? row.position - 1 : index;
        const delta = was === undefined ? "new" : was - official;
        const chip = delta === "new"
          ? '<span class="fia-chip fia-chip-new">new</span>'
          : delta === 0 ? "" : `<span class="fia-chip ${delta > 0 ? "fia-chip-up" : "fia-chip-down"}">${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)}</span>`;
        return `<tr>
          <td class="fia-pos">${row.position ?? index + 1}</td>
          <td>${esc(row.name)} ${chip}</td>
          <td>${esc(row.team || "—")}</td>
          <td class="fia-num">${row.points}</td>
          <td class="fia-num">${row.starts}</td>
          <td class="fia-num">${row.wins}</td>
          <td class="fia-num">${row.poles}</td>
          <td class="fia-num">${row.fastest_laps}</td>
        </tr>`;
      }).join("");
      const teamRows = sortRows(after.teams, state.sortTeams, state.sortTeamsDir);
      return `
        <h3 class="fia-round">${esc(division)} — drivers</h3>
        <p class="fia-hint">Click a column to sort. Position stays the official championship position.</p>
        <table class="fia-grid">
          <thead><tr><th>P</th><th>${sortButton("drivers", "name", "Driver")}</th><th>${sortButton("drivers", "team", "Team")}</th><th>${sortButton("drivers", "points", "Pts")}</th><th>${sortButton("drivers", "starts", "Starts")}</th><th>${sortButton("drivers", "wins", "Wins")}</th><th>${sortButton("drivers", "poles", "Poles")}</th><th>${sortButton("drivers", "fastest_laps", "FL")}</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="8" class="fia-note">No classified driver yet.</td></tr>'}</tbody>
        </table>
        <h3 class="fia-round">${esc(division)} — constructors</h3>
        <table class="fia-grid">
          <thead><tr><th>P</th><th>${sortButton("teams", "name", "Team")}</th><th>${sortButton("teams", "points", "Pts")}</th><th>${sortButton("teams", "wins", "Wins")}</th><th>${sortButton("teams", "podiums", "Podiums")}</th></tr></thead>
          <tbody>${teamRows.map((row, index) => `<tr>
            <td class="fia-pos">${row.position ?? index + 1}</td><td>${esc(row.name)}</td>
            <td class="fia-num">${row.points}</td><td class="fia-num">${row.wins}</td><td class="fia-num">${row.podiums}</td>
          </tr>`).join("") || '<tr><td colspan="5" class="fia-note">No constructor points yet.</td></tr>'}</tbody>
        </table>`;
    }).join("");
  }

  // Audit view --------------------------------------------------------------- //

  function auditView() {
    const all = (state.doc?.audit || []).slice().reverse();
    const needle = state.auditFilter.trim().toLowerCase();
    const entries = all.filter((entry) => !needle
      || `${entry.by || ""} ${entry.action || ""} ${entry.detail || ""}`.toLowerCase().includes(needle));
    return `
      <div class="fia-filter-row">
        <input type="search" data-action="audit-filter" value="${esc(state.auditFilter)}" placeholder="Filter audit log by person, action or detail" spellcheck="false">
        <span class="fia-note">${entries.length} of ${all.length} entries</span>
        <button type="button" class="action" data-action="clear-audit">Clear</button>
      </div>
      <table class="fia-grid">
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
        <tbody>${entries.map((entry) => `<tr>
          <td>${esc(stamp(entry.at))}</td>
          <td>${esc(entry.by || "FIA")}</td>
          <td>${esc(entry.action)}</td>
          <td>${esc(entry.detail)}</td>
        </tr>`).join("") || '<tr><td colspan="4" class="fia-note">No audit entries match this filter.</td></tr>'}</tbody>
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
    if (grid.entries.some((row) => !text(row.name))) {
      say("Every row needs a driver before this round can be saved.", true);
      return;
    }
    const seen = new Set();
    for (const row of grid.entries) {
      const key = (row.username || row.name).toLowerCase();
      if (seen.has(key)) {
        say(`${row.name} is in the grid twice — remove the duplicate first.`, true);
        return;
      }
      seen.add(key);
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
    recordHistory(existing ? `replace ${grid.division} R${grid.round}` : `add ${grid.division} R${grid.round}`);
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
    state.round = Number(grid.round);
    buildDrivers();
    state.validation = validateDraft();
    markDirty(`${grid.division} R${grid.round} saved to the draft — publish to make it live.`);
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
    recordHistory(`decision for ${driver.name}`);
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
    state.validation = validateDraft();
    markDirty(`Decision added: ${driver.name} — ${CORE.penaltyLabel(penalty)}.`);
    render();
  }

  // Bridge ------------------------------------------------------------------- //

  async function bridgeCall(path, body) {
    if (!state.local) throw new Error("Open this desk on the laptop to publish.");
    const response = await fetch(`${state.bridge.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.problem || `Laptop bridge answered HTTP ${response.status}`);
    return data;
  }

  function bridgeHint(error) {
    const offline = /Failed to fetch|NetworkError|Load failed|NetworkError when/i.test(String(error?.message || ""));
    if (!offline) return error.message;
    if (!state.local) {
      return `This page cannot publish. Open http://127.0.0.1:8802/#ams-fia on the laptop.`;
    }
    return `Could not reach ${state.bridge}. Start the laptop bridge with ./run-desk.sh (or desk_bridge.py) first.`;
  }

  async function publish() {
    if (state.busy) return;
    if (!state.local) {
      say("Publishing is laptop-only. Open http://127.0.0.1:8802/#ams-fia on the laptop.", true);
      return;
    }
    const check = validateDraft();
    state.validation = check;
    if (check.errors.length) {
      say(`Publishing blocked by ${check.errors.length} preflight error${check.errors.length === 1 ? "" : "s"}.`, true);
      render();
      return;
    }
    state.busy = true;
    renderChrome();
    try {
      const document = clone(state.doc);
      CORE.audit(document, {
        action: "published",
        detail: `${(document.divisions || []).reduce((sum, division) => sum + (division.rounds || []).length, 0)} rounds · by ${state.author || "FIA"}`,
        by: state.author || "FIA",
      });
      document.updated_at = new Date().toISOString();
      say("Publishing straight to the laptop bridge…");
      const data = await bridgeCall("/publish", { document, author: state.author || "FIA" });
      state.published = clone(document);
      state.doc = clone(document);
      state.dirty = false;
      state.preview = null;
      state.validation = null;
      state.history = [];
      state.future = [];
      clearSavedDraft();
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
    if (!state.local) {
      note.textContent = "This is the public copy. Open the local desk on the laptop to publish.";
      return;
    }
    note.textContent = "Checking the laptop bridge…";
    try {
      const response = await fetch(`${state.bridge.replace(/\/$/, "")}/health`, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      note.textContent = response.ok && data?.ok
        ? "Laptop bridge is up — direct publishing is ready."
        : `Laptop bridge answered HTTP ${response.status}.`;
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

  // Desk tools: palette, search, profiles, help ------------------------------ //

  const PALETTE_ACTIONS = [
    { label: "New round", hint: "Start a round in the current division", run: () => newRound() },
    { label: "Run preflight", hint: "Validate the whole draft before publishing", run: () => { state.validation = validateDraft(); render(); } },
    { label: "Preview changes", hint: "Compare the draft with the published season", run: () => { state.preview = buildPreview(); render(); } },
    { label: "Publish", hint: "Push the draft through the laptop bridge", run: () => publish() },
    { label: "Undo", hint: "Ctrl/Cmd+Z", run: () => undoDraft() },
    { label: "Redo", hint: "Ctrl/Cmd+Shift+Z", run: () => redoDraft() },
    { label: "Find anything", hint: "Rounds, drivers, circuits and decisions", run: () => openModal("search") },
    { label: "Export draft", hint: "Download a JSON backup", run: () => exportDraft() },
    { label: "Import draft", hint: "Restore a JSON backup", run: () => importDraft() },
    { label: "Save locally now", hint: "Write the autosave point immediately", run: () => { persistDraft(); say("Draft saved on this laptop."); renderChrome(); } },
    { label: "Copy round summary", hint: "Discord-ready classification", run: () => copyRound() },
    { label: "Print this desk", hint: "Print the current view", run: () => window.print() },
    { label: "Rounds", hint: "Switch view", run: () => setView("rounds") },
    { label: "Drivers", hint: "Switch view", run: () => setView("drivers") },
    { label: "Decisions", hint: "Switch view", run: () => setView("decisions") },
    { label: "Standings", hint: "Switch view", run: () => setView("standings") },
    { label: "Audit log", hint: "Switch view", run: () => setView("audit") },
    { label: "Shortcuts & 20 tools", hint: "How the desk works", run: () => openModal("help") },
  ];

  function setView(view) {
    state.view = view;
    state.preview = null;
    render();
  }

  function openModal(kind, profileKey = null) {
    state.modal = kind;
    state.profileKey = profileKey;
    state.paletteQuery = "";
    state.paletteIndex = 0;
    if (kind === "search") state.searchQuery = "";
    const overlay = $("fia-overlay");
    if (!overlay) return;
    overlay.hidden = false;
    document.body.classList.add("fia-modal-open");
    renderModal();
    const focus = $("fia-modal-body")?.querySelector("input, select, button");
    if (focus) setTimeout(() => focus.focus(), 0);
  }

  function closeModal() {
    state.modal = "";
    state.profileKey = null;
    const overlay = $("fia-overlay");
    if (overlay) overlay.hidden = true;
    document.body.classList.remove("fia-modal-open");
  }

  function renderModal() {
    const title = $("fia-modal-title");
    const body = $("fia-modal-body");
    if (!title || !body) return;
    if (state.modal === "palette") {
      title.textContent = "Desk tools";
      body.innerHTML = paletteBody();
    } else if (state.modal === "search") {
      title.textContent = "Find anything";
      body.innerHTML = searchBody();
    } else if (state.modal === "profile") {
      title.textContent = "Driver profile";
      body.innerHTML = profileBody(state.profileKey);
    } else if (state.modal === "help") {
      title.textContent = "Shortcuts & 20 desk tools";
      body.innerHTML = helpBody();
    } else {
      body.innerHTML = "";
    }
  }

  function paletteActions() {
    const needle = state.paletteQuery.trim().toLowerCase();
    return PALETTE_ACTIONS.filter((action) => !needle
      || `${action.label} ${action.hint}`.toLowerCase().includes(needle));
  }

  function paletteBody() {
    const actions = paletteActions();
    return `<input class="fia-modal-search" id="fia-palette-input" data-action="palette-search" value="${esc(state.paletteQuery)}" placeholder="Type a command…" autocomplete="off" spellcheck="false">
      <div class="fia-command-list" role="listbox">
        ${actions.map((action, index) => `<button type="button" role="option" class="fia-command${index === state.paletteIndex ? " is-current" : ""}" data-action="palette-run" data-index="${index}"><b>${esc(action.label)}</b><span>${esc(action.hint)}</span></button>`).join("") || '<p class="fia-note">No command matches.</p>'}
      </div>
      <p class="fia-hint">↑↓ to move · Enter to run · Esc to close</p>`;
  }

  function runPalette(index) {
    const action = paletteActions()[index];
    if (!action) return;
    closeModal();
    action.run();
  }

  function searchResults() {
    const needle = state.searchQuery.trim().toLowerCase();
    if (!needle) return [];
    const results = [];
    for (const division of state.doc?.divisions || []) {
      const divisionName = String(division.name || "").toUpperCase();
      for (const round of division.rounds || []) {
        const label = `${divisionName} R${round.round}${round.circuit ? ` · ${round.circuit}` : ""}`;
        if (label.toLowerCase().includes(needle)) {
          results.push({ kind: "round", label, meta: "Open round", division: divisionName, round: round.round });
        }
        for (const penalty of round.penalties || []) {
          const textValue = `${penalty.name || ""} ${CORE.penaltyLabel(penalty)} ${penalty.reason || ""}`;
          if (textValue.toLowerCase().includes(needle)) {
            results.push({ kind: "decision", label: `${penalty.name || "Decision"} — ${CORE.penaltyLabel(penalty)}`, meta: `${divisionName} R${round.round}`, division: divisionName, round: round.round, query: penalty.name || "" });
          }
        }
      }
    }
    for (const driver of state.drivers) {
      if (`${driver.name} ${driver.username} ${driver.team} ${driver.division}`.toLowerCase().includes(needle)) {
        results.push({ kind: "driver", label: driver.name, meta: `${driver.division} · ${driver.team || "no team"}`, driver: driver.username || driver.name });
      }
    }
    return results.slice(0, 24);
  }

  function searchBody() {
    const results = searchResults();
    return `<input class="fia-modal-search" id="fia-find-input" data-action="modal-search" value="${esc(state.searchQuery)}" placeholder="Driver, round, circuit, decision…" autocomplete="off" spellcheck="false">
      <div class="fia-command-list">
        ${state.searchQuery.trim()
          ? (results.map((result) => `<button type="button" class="fia-command" data-action="search-result" data-kind="${esc(result.kind)}" data-division="${esc(result.division || "")}" data-round="${esc(result.round || "")}" data-driver="${esc(result.driver || "")}" data-query="${esc(result.query || "")}"><b>${esc(result.label)}</b><span>${esc(result.meta)}</span></button>`).join("") || '<p class="fia-note">Nothing matches that search.</p>')
          : '<p class="fia-note">Search every round, circuit, driver, team and steward decision.</p>'}
      </div>`;
  }

  function openProfile(key) {
    if (!key) return;
    openModal("profile", key);
  }

  function profileBody(key) {
    const driver = state.drivers.find((entry) => (entry.username || entry.name) === key);
    if (!driver) return '<p class="fia-note">That driver is no longer on file.</p>';
    const tables = [];
    const history = [];
    for (const division of state.doc?.divisions || []) {
      const divisionName = String(division.name || "").toUpperCase();
      const table = CORE.computeStandings(division.rounds || []);
      const row = table.drivers.find((entry) => CORE.keyOf(entry) === key.toLowerCase());
      if (row) tables.push({ division: divisionName, row });
      for (const round of division.rounds || []) {
        const entry = (round.classification || []).find((item) => CORE.keyOf(item) === key.toLowerCase());
        if (entry) history.push({ division: divisionName, round, entry });
      }
    }
    if (!tables.length && !history.length) return '<p class="fia-note">No championship data for this driver yet.</p>';
    const latest = history.sort((a, b) => (b.round.round ?? 0) - (a.round.round ?? 0)).slice(0, 8);
    const decisions = [];
    for (const division of state.doc?.divisions || []) {
      for (const round of division.rounds || []) {
        for (const penalty of round.penalties || []) {
          if (CORE.keyOf(penalty) === key.toLowerCase()) decisions.push({ division: division.name, round, penalty });
        }
      }
    }
    return `<div class="fia-profile-head"><div class="fia-avatar">${esc(initials(driver.name))}</div><div><h4>${esc(driver.name)}</h4><p>@${esc(driver.username || "—")} · ${esc(driver.team || "no team")} · ${esc(driver.division)}</p></div></div>
      <div class="fia-profile-grid">${tables.map(({ division, row }) => `<div class="fia-stat"><span>${esc(division)} championship</span><b>P${row.position ?? "—"} · ${row.points} pts</b><em>${row.starts} starts · ${row.wins} wins · ${row.podiums} podiums</em></div>`).join("") || '<p class="fia-note">No classified results yet.</p>'}</div>
      <h4>Recent rounds</h4>
      <table class="fia-grid"><thead><tr><th>Round</th><th>Result</th><th>Pts</th><th>Gap</th></tr></thead><tbody>${latest.map(({ division, round, entry }) => `<tr><td>${esc(division)} R${esc(round.round)}</td><td>${entry.position ? `P${esc(entry.position)}` : "DNF"}</td><td class="fia-num">${esc(entry.points ?? 0)}</td><td>${esc(entry.gap || "—")}</td></tr>`).join("") || '<tr><td colspan="4" class="fia-note">No results.</td></tr>'}</tbody></table>
      <h4>Steward decisions</h4>
      <p class="fia-hint">${decisions.length ? decisions.map(({ division, round, penalty }) => `${esc(division)} R${esc(round.round)} — ${esc(CORE.penaltyLabel(penalty))}${penalty.reason ? ` (${esc(penalty.reason)})` : ""}`).join("<br>") : "No decisions on file."}</p>
      <div class="fia-actions"><button type="button" class="action" data-action="close-modal">Close</button></div>`;
  }

  function helpBody() {
    const tools = [
      "Token-free laptop publishing — bridge on 127.0.0.1, no key in the browser",
      "Command palette with Ctrl/Cmd+K",
      "Undo and redo for every draft change",
      "Autosave plus crash recovery on this laptop",
      "Leave guard for unpublished changes",
      "Global find across rounds, circuits, drivers and decisions",
      "Round filter with previous/next round controls",
      "Duplicate a round into the next one",
      "CSV/TSV timing-sheet import",
      "Preflight validation before publishing",
      "Keyboard shortcuts and quick navigation",
      "Draft JSON export and import",
      "Print-ready desk view",
      "Decision filters by driver, type and round",
      "One-click steward decision presets",
      "Driver profile drawer with results and decisions",
      "Sortable championship tables",
      "Audit-log search",
      "Fill a grid from the current lineups",
      "Copy a Discord-ready round summary",
    ];
    return `<p class="fia-hint">This desk publishes only on the laptop. The public copy is read-only, and the bridge is loopback-only.</p>
      <div class="fia-shortcuts">
        <div><kbd>Ctrl/Cmd</kbd> + <kbd>K</kbd><span>Command palette</span></div>
        <div><kbd>Ctrl/Cmd</kbd> + <kbd>Shift</kbd> + <kbd>F</kbd><span>Find anything</span></div>
        <div><kbd>Ctrl/Cmd</kbd> + <kbd>Z</kbd><span>Undo</span></div>
        <div><kbd>Ctrl/Cmd</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd><span>Redo</span></div>
        <div><kbd>Ctrl/Cmd</kbd> + <kbd>S</kbd><span>Save the open round</span></div>
        <div><kbd>Ctrl/Cmd</kbd> + <kbd>Enter</kbd><span>Publish</span></div>
        <div><kbd>?</kbd><span>This help</span></div>
        <div><kbd>Esc</kbd><span>Close a dialog</span></div>
      </div>
      <h4>20 features on this desk</h4>
      <ol class="fia-feature-list">${tools.map((tool) => `<li>${esc(tool)}</li>`).join("")}</ol>
      <div class="fia-actions">
        <button type="button" class="action" data-action="save-local">Save draft now</button>
        <button type="button" class="action" data-action="export-draft">Export JSON</button>
        <button type="button" class="action" data-action="import-draft">Import JSON</button>
      </div>`;
  }

  function exportDraft() {
    saveAuthor();
    downloadJson(`ams-fia-draft-${new Date().toISOString().slice(0, 10)}.json`, state.doc);
    say("Draft exported as JSON.");
  }

  function importDraft() {
    closeModal();
    $("fia-import-draft")?.click();
  }

  function saveAuthor() {
    if (!state.doc) return;
    state.author = state.author || "FIA";
    localStorage.setItem(AUTHOR_KEY, state.author);
  }

  function duplicateRound() {
    if (!state.grid) return;
    const rounds = roundsOf(state.grid.division);
    if (!rounds.some((round) => Number(round.round) === Number(state.grid.round))) {
      say("Save this round first, then duplicate it.", true);
      return;
    }
    const next = Math.max(state.grid.round, ...rounds.map((round) => Number(round.round) || 0)) + 1;
    state.grid = {
      ...state.grid,
      round: next,
      circuit: "",
      entries: clone(state.grid.entries),
    };
    state.round = next;
    state.gridPaste = "";
    say(`Copied ${state.grid.division} R${next - 1} into R${next}. Save to keep it.`);
    render();
  }

  function autoFillGrid() {
    if (!state.grid) return;
    const keys = new Set(state.grid.entries.map((entry) => entry.username || entry.name));
    const missing = state.drivers.filter((driver) => driver.division === state.grid.division && !keys.has(driver.username || driver.name));
    if (!missing.length) {
      say("Every driver in this division is already in the grid.", true);
      return;
    }
    state.grid.entries.push(...missing.map((driver) => ({
      name: driver.name,
      username: driver.username,
      team: driver.team,
      division: driver.division,
      matched: true,
      gap: "",
      dnf: false,
    })));
    say(`Added ${missing.length} driver${missing.length === 1 ? "" : "s"} from the lineups.`);
    render();
  }

  async function copyRound() {
    if (!state.grid) return;
    const ok = await copyText(roundText());
    say(ok ? "Round summary copied." : "Could not copy — select and copy the summary manually.", !ok);
  }

  function moveRound(offset) {
    const rounds = roundsOf(state.division || divisions()[0]);
    const index = rounds.findIndex((round) => Number(round.round) === Number(state.round));
    const next = rounds[index + offset];
    if (next) openRound(state.division, next.round);
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

    if (action === "palette") {
      openModal("palette");
      return;
    }
    if (action === "help") {
      openModal("help");
      return;
    }
    if (action === "close-modal") {
      closeModal();
      return;
    }
    if (action === "copy-local-url") {
      copyText("http://127.0.0.1:8802/#ams-fia").then((ok) => say(ok ? "Local desk URL copied." : "Copy failed — open http://127.0.0.1:8802/#ams-fia directly.", !ok));
      return;
    }
    if (action === "undo") {
      undoDraft();
      return;
    }
    if (action === "redo") {
      redoDraft();
      return;
    }
    if (action === "find") {
      openModal("search");
      return;
    }
    if (action === "validate") {
      state.validation = validateDraft();
      say(state.validation.errors.length
        ? `Preflight found ${state.validation.errors.length} blocking error${state.validation.errors.length === 1 ? "" : "s"}.`
        : `Preflight clear — ${state.validation.warnings.length} warning${state.validation.warnings.length === 1 ? "" : "s"}.`);
      render();
      return;
    }
    if (action === "clear-validation") {
      state.validation = null;
      render();
      return;
    }
    if (action === "export-draft") {
      closeModal();
      exportDraft();
      return;
    }
    if (action === "import-draft") {
      importDraft();
      return;
    }
    if (action === "save-local") {
      persistDraft();
      say("Draft saved on this laptop.");
      renderChrome();
      return;
    }
    if (action === "print") {
      window.print();
      return;
    }
    if (action === "prev-round") {
      moveRound(-1);
      return;
    }
    if (action === "next-round") {
      moveRound(1);
      return;
    }
    if (action === "restore-draft") {
      if (state.recovery?.doc) {
        state.doc = clone(state.recovery.doc);
        state.history = [];
        state.future = [];
        state.recovery = null;
        state.dirty = true;
        state.preview = null;
        CORE.refreshStandings(state.doc);
        buildDrivers();
        state.validation = validateDraft();
        persistDraft();
        say("Local draft restored.");
        render();
      }
      return;
    }
    if (action === "dismiss-recovery") {
      clearSavedDraft();
      say("Local draft dismissed.");
      render();
      return;
    }
    if (action === "auto-fill") {
      autoFillGrid();
      return;
    }
    if (action === "duplicate-round") {
      duplicateRound();
      return;
    }
    if (action === "copy-round") {
      copyRound();
      return;
    }
    if (action === "import-grid") {
      $("fia-import-grid")?.click();
      return;
    }
    if (action === "driver-profile") {
      openProfile(button.dataset.driver);
      return;
    }
    if (action === "sort-standings") {
      const table = button.dataset.table;
      const key = button.dataset.key;
      if (table === "drivers") {
        state.sortDriversDir = state.sortDrivers === key ? state.sortDriversDir * -1 : (key === "name" || key === "team" ? 1 : -1);
        state.sortDrivers = key;
      } else {
        state.sortTeamsDir = state.sortTeams === key ? state.sortTeamsDir * -1 : (key === "name" ? 1 : -1);
        state.sortTeams = key;
      }
      render();
      return;
    }
    if (action === "clear-decisions") {
      state.decisionQuery = "";
      state.decisionType = "all";
      state.decisionRound = "all";
      render();
      return;
    }
    if (action === "clear-audit") {
      state.auditFilter = "";
      render();
      return;
    }
    if (action === "palette-run") {
      runPalette(Number(button.dataset.index));
      return;
    }
    if (action === "search-result") {
      const kind = button.dataset.kind;
      const division = button.dataset.division;
      const round = button.dataset.round;
      closeModal();
      if (kind === "driver") {
        openProfile(button.dataset.driver);
      } else if (kind === "decision") {
        state.division = division;
        state.view = "decisions";
        state.decisionQuery = button.dataset.query || "";
        render();
      } else if (division && round) {
        state.division = division;
        openRound(division, round);
      }
      return;
    }

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
      if (!window.confirm(`Delete ${state.grid.division} R${removed} from the draft?`)) return;
      recordHistory(`delete ${state.grid.division} R${removed}`);
      entry.rounds = (entry.rounds || []).filter((round) => Number(round.round) !== removed);
      CORE.refreshStandings(state.doc);
      CORE.audit(state.doc, {
        action: "round removed",
        detail: `${state.grid.division} R${removed}`,
        by: state.author || "FIA",
      });
      state.grid = null;
      state.round = null;
      state.validation = validateDraft();
      markDirty("Round removed from the draft.");
      render();
      return;
    }
    if (action === "remove-penalty") {
      const division = state.division || divisions()[0];
      const entry = divisionEntry(division);
      const round = (entry.rounds || []).find((item) => Number(item.round) === Number(button.dataset.round));
      if (!round) return;
      recordHistory(`remove decision from ${division} R${button.dataset.round}`);
      round.penalties = (round.penalties || []).filter((penalty) => penalty.id !== button.dataset.id);
      CORE.refreshStandings(state.doc);
      CORE.audit(state.doc, {
        action: "decision removed",
        detail: `${division} R${button.dataset.round}`,
        by: state.author || "FIA",
      });
      state.validation = validateDraft();
      markDirty("Decision removed from the draft.");
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
      if (!window.confirm("Discard all unpublished changes?")) return;
      state.doc = clone(state.published);
      state.dirty = false;
      state.grid = null;
      state.preview = null;
      state.history = [];
      state.future = [];
      state.validation = null;
      clearSavedDraft();
      buildDrivers();
      say("Draft discarded.");
      render();
      return;
    }
    if (action === "check-bridge") {
      checkBridge();
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
    if (!action) return;
    if (action === "decision-type") {
      state.decisionType = target.value;
      render();
      return;
    }
    if (action === "decision-round") {
      state.decisionRound = target.value;
      render();
      return;
    }
    if (action === "decision-preset") {
      const preset = DECISION_PRESETS.find((entry) => entry.id === target.value);
      const form = section.querySelector('form[data-form="penalty"]');
      if (preset && form) {
        form.elements.type.value = preset.type;
        form.elements.value.value = String(preset.value);
        form.elements.reason.value = preset.reason;
        say(`Preset loaded: ${preset.label}. Pick a driver and round, then add it.`);
      }
      return;
    }
    if (!state.grid) return;
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
    if (action === "round-filter") {
      state.roundFilter = target.value;
      render();
      const next = $("fia-view").querySelector('[data-action="round-filter"]');
      if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
      return;
    }
    if (action === "decision-search") {
      state.decisionQuery = target.value;
      render();
      const next = $("fia-view").querySelector('[data-action="decision-search"]');
      if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
      return;
    }
    if (action === "audit-filter") {
      state.auditFilter = target.value;
      render();
      const next = $("fia-view").querySelector('[data-action="audit-filter"]');
      if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
      return;
    }
    if (action === "modal-search") {
      state.searchQuery = target.value;
      renderModal();
      const next = $("fia-find-input");
      if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
      return;
    }
    if (action === "palette-search") {
      state.paletteQuery = target.value;
      state.paletteIndex = 0;
      renderModal();
      const next = $("fia-palette-input");
      if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
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

  $("fia-import-draft")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const raw = JSON.parse(await readTextFile(file));
      const imported = CORE.normalizeDocument(raw?.doc || raw);
      if (!Array.isArray(imported.divisions) || !imported.divisions.length) throw new Error("that file has no divisions");
      recordHistory("import draft");
      state.doc = imported;
      CORE.refreshStandings(state.doc);
      buildDrivers();
      state.validation = validateDraft();
      markDirty(`Imported ${file.name}.`);
      render();
    } catch (error) {
      say(`Import failed: ${error.message}`, true);
    }
  });

  $("fia-import-grid")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !state.grid) return;
    try {
      const source = await readTextFile(file);
      const rows = parseGrid(source);
      if (!rows.length) throw new Error("no drivers found in that file");
      state.gridPaste = source;
      state.grid.entries = rows;
      say(`Imported ${rows.length} drivers from ${file.name} — save the round to keep them.`);
      render();
    } catch (error) {
      say(`Grid import failed: ${error.message}`, true);
    }
  });

  $("fia-overlay")?.addEventListener("click", (event) => {
    if (event.target === $("fia-overlay")) closeModal();
  });

  document.addEventListener("keydown", (event) => {
    if (!document.body.dataset.fia) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (state.modal) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
        return;
      }
      if (state.modal === "palette") {
        const actions = paletteActions();
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          state.paletteIndex = Math.max(0, Math.min(actions.length - 1, state.paletteIndex + direction));
          renderModal();
          const next = $("fia-palette-input");
          if (next) next.focus();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          runPalette(state.paletteIndex);
          return;
        }
      }
      return;
    }

    if (ctrl && key === "k") {
      event.preventDefault();
      openModal("palette");
      return;
    }
    if (ctrl && event.shiftKey && key === "f") {
      event.preventDefault();
      openModal("search");
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
    if (ctrl && key === "z" && !typing) {
      event.preventDefault();
      if (event.shiftKey) redoDraft(); else undoDraft();
      return;
    }
    if (ctrl && key === "y" && !typing) {
      event.preventDefault();
      redoDraft();
      return;
    }
    if (ctrl && key === "s") {
      event.preventDefault();
      if (state.grid) gridSave();
      return;
    }
    if (ctrl && event.key === "Enter" && !typing) {
      event.preventDefault();
      publish();
      return;
    }
    if (!typing && event.key === "?") {
      event.preventDefault();
      openModal("help");
      return;
    }
    if (!typing && event.key === "/") {
      event.preventDefault();
      openModal("search");
      return;
    }
    if (event.key === "Escape") {
      if (state.grid) {
        state.grid = null;
        state.round = null;
        render();
      }
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  // Boot --------------------------------------------------------------------- //

  const authorInput = $("fia-author");
  if (authorInput) {
    authorInput.value = state.author;
    authorInput.addEventListener("input", () => {
      state.author = authorInput.value.trim();
      localStorage.setItem(AUTHOR_KEY, state.author);
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
    // The local bridge only listens on loopback, so possession of the desk is
    // the credential. No code, no bridge token: open it and work.
    if (state.local || isOpen()) {
      setMode(true);
      if (!state.loaded) load().then(() => { if (state.local) checkBridge(); });
      else if (state.local) checkBridge();
    } else {
      setMode(false);
      const input = $("fia-password");
      if (input) input.focus();
    }
  }

  window.addEventListener("hashchange", syncFromHash);
  if (location.hash.toLowerCase() === HASH) syncFromHash();
})();
