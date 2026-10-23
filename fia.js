// FIA race-control desk. Reached only at #ams-FIA, never linked from the page.
//
// This is the write side of the site: rounds, steward decisions, clips and the
// published championship tables. Everything is edited in the browser as a draft
// and committed to the site repo through the GitHub Contents API with a token
// the steward pastes in once per tab — no server, no shared secret in the page.
//
// The access code is held as a SHA-256 digest, not as text. That is concealment,
// not security: anyone reading this file sees how the check works. What protects
// the league is that publishing needs a GitHub token that never lives here.
(() => {
  "use strict";

  const CORE = window.AMSResults;
  const section = document.getElementById("fia");
  if (!section || !CORE) return;

  const HASH = "#ams-fia";
  const CODE_SHA256 = "387212a44247c12e2829f6f4c49c22c053ca58bba77bcd613d441bac4c716741";
  const UNLOCK_KEY = "ams-fia-unlocked";
  const TOKEN_KEY = "ams-fia-token";
  const API = "https://api.github.com";
  const RESULTS_PATH = "data/results.json";
  const LINEUPS_URL = "data/lineups.json";
  const DEFAULT_REPO = "OriYelliOcti/AMS-Website";
  const DEFAULT_BRANCH = "main";
  const LOCALE = "en-GB";
  const ROSTER_SLOTS = ["Driver", "Reserve", "Other"];

  const $ = (id) => document.getElementById(id);
  const publicTitle = document.title;

  const state = {
    loaded: false,
    doc: null,
    publishedText: "",
    dirty: false,
    busy: false,
    view: "rounds",
    division: null,
    standingsDivision: null,
    edit: null,
    penalty: null,
    clip: null,
    confirm: null,
    token: sessionStorage.getItem(TOKEN_KEY) || "",
    repo: localStorage.getItem("ams-fia-repo") || DEFAULT_REPO,
    branch: localStorage.getItem("ams-fia-branch") || DEFAULT_BRANCH,
    author: localStorage.getItem("ams-fia-author") || "",
    lineups: null,
  };

  // Helpers ----------------------------------------------------------------- //

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

  function stamp(iso) {
    if (!iso) return "never";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "unknown";
    return date.toLocaleString(LOCALE, { dateStyle: "medium", timeStyle: "short" });
  }

  function say(text, isError) {
    const note = $("fia-status");
    note.textContent = text;
    note.classList.toggle("error", Boolean(isError));
  }

  function serialize(doc) {
    return `${JSON.stringify(doc, null, 1)}\n`;
  }

  function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }

  function slug(value) {
    return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function author() {
    return state.author.trim() || "FIA desk";
  }

  // Data -------------------------------------------------------------------- //

  async function fetchJson(url) {
    const response = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function load(force) {
    if (state.loaded && !force) return;
    const [lineups, results] = await Promise.all([
      fetchJson(LINEUPS_URL).catch(() => null),
      fetchJson(RESULTS_PATH).catch(() => null),
    ]);
    state.lineups = lineups;
    state.doc = CORE.normalizeDocument(results ?? CORE.emptyDocument("Season 1"));
    state.publishedText = serialize(state.doc);
    state.loaded = true;
    state.dirty = false;
    if (!results) say("No results are published yet — this desk will create the first one.", false);
  }

  function markDirty() {
    state.dirty = serialize(state.doc) !== state.publishedText;
    renderChrome();
  }

  function divisions() {
    return state.doc?.divisions ?? [];
  }

  function divisionNames() {
    const names = divisions().map((division) => division.name).filter(Boolean);
    for (const name of CORE.DIVISION_ORDER) if (!names.includes(name)) names.push(name);
    return names;
  }

  function roster(division) {
    const entry = (state.lineups?.divisions ?? []).find(
      (item) => String(item?.name ?? "").toUpperCase() === String(division ?? "").toUpperCase(),
    );
    const people = new Map();
    for (const team of entry?.teams ?? []) {
      for (const slot of team.slots ?? []) {
        if (!ROSTER_SLOTS.includes(slot.slot)) continue;
        for (const person of slot.members ?? []) {
          if (!person?.username || person.bot || people.has(person.username)) continue;
          people.set(person.username, {
            name: person.name,
            username: person.username,
            team: team.short || team.name,
          });
        }
      }
    }
    return people;
  }

  function personOf(entry) {
    if (!entry) return null;
    return {
      name: entry.name,
      username: entry.username,
      team: entry.short || entry.team || "",
    };
  }

  function roundsOf(division) {
    return [...(division?.rounds ?? [])].sort((a, b) => CORE.num(b.round, 0) - CORE.num(a.round, 0));
  }

  function allRounds() {
    const rows = [];
    for (const division of divisions()) {
      for (const round of roundsOf(division)) rows.push({ division: division.name, round });
    }
    return rows;
  }

  function decisionsOf(division) {
    const rows = [];
    for (const round of roundsOf(division)) {
      for (const penalty of CORE.penaltiesOf(round)) {
        rows.push({ division: division.name, round: round.round, circuit: round.circuit, penalty });
      }
    }
    return rows;
  }

  function clips() {
    return [...(state.doc?.media ?? [])].sort((a, b) => (
      String(b.added_at ?? "").localeCompare(String(a.added_at ?? ""))
    ));
  }

  // Chrome ------------------------------------------------------------------ //

  function renderChrome() {
    const totalRounds = allRounds().length;
    const totalDecisions = divisions().reduce((sum, division) => sum + decisionsOf(division).length, 0);
    const totalClips = clips().length;
    const updated = state.doc?.updated_at ? stamp(state.doc.updated_at) : "never";

    $("fia-meta").innerHTML = [
      ["Rounds", String(totalRounds)],
      ["Decisions", String(totalDecisions)],
      ["Clips", String(totalClips)],
      ["Last published", updated],
    ].map(([label, value]) => `<div class="fia-stat"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("");

    const dirty = $("fia-dirty");
    dirty.hidden = !state.dirty;
    $("fia-discard").hidden = !state.dirty;
    $("fia-publish").disabled = state.busy;

    for (const button of document.querySelectorAll("#fia-nav button")) {
      button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
    }
  }

  function options(values, selected, placeholder) {
    const head = placeholder === undefined ? "" : `<option value="">${esc(placeholder)}</option>`;
    return head + values.map(([value, label]) => (
      `<option value="${esc(value)}"${String(value) === String(selected ?? "") ? " selected" : ""}>${esc(label)}</option>`
    )).join("");
  }

  function divisionNav(current, action) {
    return divisionNames().map((name) => (
      `<button type="button" data-action="${action}" data-division="${esc(name)}" aria-pressed="${name === current}">${esc(name)}</button>`
    )).join("");
  }

  // Views ------------------------------------------------------------------- //

  function render() {
    if (!state.doc) return;
    renderChrome();
    const view = $("fia-view");
    if (state.view === "rounds") view.innerHTML = roundsView();
    else if (state.view === "decisions") view.innerHTML = decisionsView();
    else if (state.view === "clips") view.innerHTML = clipsView();
    else if (state.view === "standings") view.innerHTML = standingsView();
    else if (state.view === "squad") view.innerHTML = squadView();
    else view.innerHTML = activityView();
  }

  function roundsView() {
    if (state.edit) return roundForm();
    const current = state.division ?? divisions()[0]?.name ?? CORE.DIVISION_ORDER[0];
    state.division = current;
    const division = CORE.divisionEntry(state.doc, current);
    const rounds = division ? roundsOf(division) : [];

    const cards = rounds.length ? rounds.map((round) => {
      const summary = CORE.roundSummary(round);
      const key = `${current}:${round.round}`;
      const confirming = state.confirm === key;
      return `<article class="fia-card">
        <header>
          <h4>Round ${esc(round.round)}${round.circuit ? ` — ${esc(round.circuit)}` : ""}</h4>
          <p>${esc(current)} · ${summary.classified} classified${summary.retired ? ` · ${summary.retired} retired` : ""} · ${summary.decisions} decision${summary.decisions === 1 ? "" : "s"}</p>
        </header>
        <div class="fia-actions">
          <button type="button" class="action" data-action="edit-round" data-division="${esc(current)}" data-round="${esc(round.round)}">Edit</button>
          ${confirming
            ? `<button type="button" class="action fia-danger" data-action="confirm-delete" data-division="${esc(current)}" data-round="${esc(round.round)}">Delete round</button>
               <button type="button" class="action" data-action="cancel-delete">Keep</button>`
            : `<button type="button" class="action" data-action="delete-round" data-division="${esc(current)}" data-round="${esc(round.round)}">Delete</button>`}
        </div>
      </article>`;
    }).join("") : `<p class="empty-line">No ${esc(current)} rounds yet — start with a new round.</p>`;

    return `<div class="fia-section-head">
        <h3>Rounds</h3>
        <button type="button" class="action action-solid" data-action="new-round">New round</button>
      </div>
      <div class="fia-filters" role="group" aria-label="Division">${divisionNav(current, "show-division")}</div>
      <div class="fia-cards">${cards}</div>`;
  }

  function roundForm() {
    const edit = state.edit;
    const table = CORE.pointsTable(CORE.divisionEntry(state.doc, edit.division) ?? {});
    const people = roster(edit.division);
    const used = new Set(edit.entries.map((entry) => entry.username));
    const available = [...people.values()]
      .filter((person) => !used.has(person.username))
      .sort((a, b) => a.name.localeCompare(b.name, LOCALE));

    let position = 0;
    const rows = edit.entries.map((entry, index) => {
      const retired = entry.status === "retired";
      if (!retired) position += 1;
      const scored = retired ? 0 : CORE.pointsFor(table, position);
      const driverOptions = options(
        [...people.values()].map((person) => [person.username, `${person.name} (${person.team})`]),
        entry.username,
        "— driver —",
      );
      const extra = people.has(entry.username)
        ? ""
        : `<option value="${esc(entry.username)}" selected>${esc(entry.name)} (not on the roster)</option>`;
      return `<li class="fia-order-row">
        <span class="fia-pos">${retired ? "DNF" : `P${position}`}</span>
        <select data-entry-driver data-index="${index}" aria-label="Driver in position ${index + 1}">${driverOptions}${extra}</select>
        <span class="fia-team">${esc(entry.team)}</span>
        <select data-entry-status data-index="${index}" aria-label="Status for ${esc(entry.name)}" class="fia-status-select">
          <option value="classified"${retired ? "" : " selected"}>Classified</option>
          <option value="retired"${retired ? " selected" : ""}>Retired</option>
        </select>
        <span class="fia-pts">${scored} pts</span>
        <span class="fia-order-actions">
          <button type="button" data-action="entry-up" data-index="${index}" aria-label="Move up"${index === 0 ? " disabled" : ""}>↑</button>
          <button type="button" data-action="entry-down" data-index="${index}" aria-label="Move down"${index === edit.entries.length - 1 ? " disabled" : ""}>↓</button>
          <button type="button" data-action="entry-remove" data-index="${index}" aria-label="Remove">×</button>
        </span>
      </li>`;
    }).join("");

    const finishers = edit.entries
      .filter((entry) => entry.status !== "retired")
      .map((entry) => [entry.username, entry.name]);
    const addOptions = available.map((person) => [person.username, `${person.name} (${person.team})`]);

    return `<div class="fia-section-head">
        <h3>${edit.mode === "new" ? "New round" : "Edit round"}</h3>
        <button type="button" class="action" data-action="cancel-edit">Back</button>
      </div>
      <form class="fia-form" id="fia-round-form">
        <div class="fia-form-grid">
          <label>Division<select data-edit="division"${edit.mode === "new" ? "" : " disabled"}>
            ${options(divisionNames().map((name) => [name, name]), edit.division)}
          </select></label>
          <label>Round<input type="number" min="1" max="99" data-edit="round" value="${esc(edit.round)}"></label>
          <label>Circuit<input type="text" data-edit="circuit" value="${esc(edit.circuit)}" placeholder="Monza"></label>
        </div>

        <h4>Classification</h4>
        <ol class="fia-order">${rows || '<li class="empty-line">Nobody yet — add the first driver below.</li>'}</ol>
        <div class="fia-actions">
          <select id="fia-add-driver" aria-label="Driver to add">${options(addOptions, "", "— add a driver —")}</select>
          <button type="button" class="action" data-action="entry-add">Add driver</button>
        </div>

        <div class="fia-form-grid">
          <label>Pole<select data-edit="pole">${options(finishers, edit.pole, "— none —")}</select></label>
          <label>Fastest lap<select data-edit="fastest">${options(finishers, edit.fastest, "— none —")}</select></label>
        </div>

        <p class="fia-hint">Positions are numbered from this order, skipping retirements. Points come from the division table; fastest lap is already included by the bot when it records a round — add it here with the position that was scored.</p>
        <div class="fia-actions">
          <button type="submit" class="action action-solid">Save round</button>
          <button type="button" class="action" data-action="cancel-edit">Cancel</button>
        </div>
      </form>`;
  }

  function decisionsView() {
    const editing = state.penalty;
    const divisionName = editing?.division ?? state.division ?? divisions()[0]?.name ?? CORE.DIVISION_ORDER[0];
    const division = CORE.divisionEntry(state.doc, divisionName);
    const rounds = division ? roundsOf(division) : [];
    const roundNumber = editing?.round ?? rounds[0]?.round ?? "";
    const round = rounds.find((item) => CORE.num(item.round, -1) === CORE.num(roundNumber, -2));
    const type = CORE.penaltyType(editing?.type ?? "points");
    const people = round ? roster(divisionName) : new Map();
    for (const entry of round?.classification ?? []) {
      if (entry?.username && !people.has(entry.username)) {
        people.set(entry.username, { name: entry.name, username: entry.username, team: entry.short || entry.team || "" });
      }
    }
    // Drivers who actually raced this round come first: the steward's usual job
    // is one of the people already in that classification.
    const raced = new Set((round?.classification ?? []).map((entry) => entry?.username).filter(Boolean));
    const drivers = [...people.values()].sort((a, b) => {
      const first = raced.has(a.username) ? 0 : 1;
      const second = raced.has(b.username) ? 0 : 1;
      if (first !== second) return first - second;
      return a.name.localeCompare(b.name, LOCALE);
    });
    const driver = editing?.driver ?? drivers[0]?.username ?? "";

    const form = rounds.length ? `<form class="fia-form" id="fia-penalty-form">
        <div class="fia-form-grid">
          <label>Division<select data-penalty="division">${options(divisionNames().map((name) => [name, name]), divisionName)}</select></label>
          <label>Round<select data-penalty="round">${options(rounds.map((item) => [item.round, `Round ${item.round}${item.circuit ? ` — ${item.circuit}` : ""}`]), roundNumber)}</select></label>
          <label>Driver<select data-penalty="driver">${options(drivers.map((person) => [person.username, `${person.name} (${person.team})`]), driver, "— none —")}</select></label>
          <label>Decision<select data-penalty="type">${options(CORE.PENALTY_TYPES.map((item) => [item.id, item.label]), type?.id ?? "points")}</select></label>
          ${type?.hasValue ? `<label>${esc(type.unit)}<input type="number" min="0" step="1" data-penalty="value" value="${esc(editing?.value ?? "")}" placeholder="0"></label>` : ""}
        </div>
        <label class="fia-wide">Reason<textarea data-penalty="reason" rows="2" placeholder="What the stewards found, in one line.">${esc(editing?.reason ?? "")}</textarea></label>
        <p class="fia-hint">A <b>points deduction</b> comes off the driver and their constructor's championship total. A <b>disqualification</b> keeps the start but scores nothing for that round. Everything else is published as a note and does not move points.</p>
        <div class="fia-actions">
          <button type="submit" class="action action-solid">${editing ? "Save decision" : "Add decision"}</button>
          ${editing ? '<button type="button" class="action" data-action="cancel-penalty">Cancel</button>' : ""}
        </div>
      </form>` : '<p class="empty-line">Record a round first — decisions are attached to one.</p>';

    const list = divisions().map((divisionEntry) => {
      const rows = decisionsOf(divisionEntry);
      if (!rows.length) return "";
      return `<section class="fia-card">
        <header><h4>${esc(divisionEntry.name)}</h4><p>${rows.length} decision${rows.length === 1 ? "" : "s"}</p></header>
        <ul class="fia-decisions">
          ${rows.map(({ round, penalty }) => `
            <li>
              <div>
                <b>${esc(penalty.name || "—")}</b>
                <span class="fia-tag">${esc(CORE.penaltyLabel(penalty))}</span>
                <p>${esc(penalty.reason || "No reason given.")}</p>
                <p class="fia-meta-line">Round ${esc(round)}${penalty.issued_at ? ` · ${esc(stamp(penalty.issued_at))}` : ""}${penalty.issued_by ? ` · ${esc(penalty.issued_by)}` : ""}</p>
              </div>
              <div class="fia-actions">
                <button type="button" class="action" data-action="edit-penalty" data-division="${esc(divisionEntry.name)}" data-round="${esc(round)}" data-id="${esc(penalty.id ?? "")}">Edit</button>
                <button type="button" class="action" data-action="remove-penalty" data-division="${esc(divisionEntry.name)}" data-round="${esc(round)}" data-id="${esc(penalty.id ?? "")}">Remove</button>
              </div>
            </li>`).join("")}
        </ul>
      </section>`;
    }).join("");

    return `<h3>Decisions</h3>${form}
      <div class="fia-cards">${list || '<p class="empty-line">No decisions published yet.</p>'}</div>`;
  }

  function clipsView() {
    const clip = state.clip;
    const media = clips();
    const form = `<form class="fia-form" id="fia-clip-form">
        <div class="fia-form-grid">
          <label>Title<input type="text" data-clip="title" value="${esc(clip?.title ?? "")}" placeholder="Last-lap pass for the win"></label>
          <label>Video link<input type="url" data-clip="url" value="${esc(clip?.url ?? "")}" placeholder="https://youtu.be/… or https://clips.twitch.tv/…"></label>
          <label>Division<select data-clip="division">${options(divisionNames().map((name) => [name, name]), clip?.division ?? "", "All divisions")}</select></label>
          <label>Round<input type="number" min="1" max="99" data-clip="round" value="${esc(clip?.round ?? "")}" placeholder="optional"></label>
        </div>
        <p class="fia-hint" id="fia-clip-kind">${clip?.url ? `${esc(CORE.parseMedia(clip.url).label)} detected.` : "YouTube, Twitch clips, Streamable, Medal and direct video files all play inline; anything else is published as a link."}</p>
        <div class="fia-actions">
          <button type="submit" class="action action-solid">${clip ? "Save clip" : "Add clip"}</button>
          ${clip ? '<button type="button" class="action" data-action="cancel-clip">Cancel</button>' : ""}
        </div>
      </form>`;

    const list = media.length ? media.map((item) => {
      const meta = CORE.parseMedia(item.url);
      return `<article class="fia-card">
        <header>
          <h4>${esc(item.title)}</h4>
          <p>${esc(meta.label)}${item.division ? ` · ${esc(item.division)}` : " · all divisions"}${item.round ? ` · round ${esc(item.round)}` : ""}</p>
        </header>
        <p class="fia-clip-url">${esc(item.url)}</p>
        ${item.note ? `<p>${esc(item.note)}</p>` : ""}
        <div class="fia-actions">
          <button type="button" class="action" data-action="edit-clip" data-id="${esc(item.id)}">Edit</button>
          <button type="button" class="action" data-action="remove-clip" data-id="${esc(item.id)}">Remove</button>
        </div>
      </article>`;
    }).join("") : '<p class="empty-line">No clips yet — add the first highlight.</p>';

    return `<h3>Clips</h3>${form}<div class="fia-cards">${list}</div>`;
  }

  function standingsView() {
    const current = state.standingsDivision ?? divisions()[0]?.name ?? CORE.DIVISION_ORDER[0];
    state.standingsDivision = current;
    const division = CORE.divisionEntry(state.doc, current);
    if (!division) {
      return `<div class="fia-section-head"><h3>Standings</h3>
        <button type="button" class="action action-solid" data-action="recompute">Recompute</button></div>
        <div class="fia-filters">${divisionNav(current, "show-standings")}</div>
        <p class="empty-line">No ${esc(current)} rounds recorded yet.</p>`;
    }

    const computed = CORE.computeStandings(division.rounds);
    const stale = JSON.stringify(computed) !== JSON.stringify(division.standings ?? {});
    const deducted = new Map();
    const disqualified = new Set();
    for (const round of division.rounds ?? []) {
      for (const penalty of CORE.penaltiesOf(round)) {
        const key = CORE.keyOf(penalty);
        if (!key) continue;
        if (penalty.type === "points") {
          deducted.set(key, (deducted.get(key) ?? 0) + Math.abs(CORE.num(penalty.value, 0)));
        }
        if (penalty.type === "dsq") disqualified.add(key);
      }
    }

    const held = division.standings ?? { drivers: [], teams: [] };
    const drivers = held.drivers ?? [];
    const teams = held.teams ?? [];

    return `<div class="fia-section-head">
        <h3>Standings</h3>
        <button type="button" class="action" data-action="recompute">Recompute</button>
      </div>
      <div class="fia-filters">${divisionNav(current, "show-standings")}</div>
      ${stale ? '<p class="fia-note error">The stored tables are out of date — press Recompute before publishing.</p>' : ""}
      <div class="table-wrap"><table class="sheet"><thead><tr>
          <th class="right">Pos</th><th>Driver</th><th>Team</th><th class="right">Pts</th><th class="right">Starts</th><th class="right">Wins</th><th class="right">Podiums</th>
        </tr></thead><tbody>
        ${drivers.length ? drivers.map((row) => {
          const key = CORE.keyOf(row);
          const tags = [
            disqualified.has(key) ? "DSQ" : "",
            deducted.has(key) ? `−${deducted.get(key)} pts` : "",
          ].filter(Boolean).map((label) => `<span class="fia-tag">${label}</span>`).join("");
          return `<tr><td class="num">${esc(row.position)}</td>
            <td><b>${esc(row.name)}</b>${tags ? ` ${tags}` : ""}</td>
            <td>${esc(row.team ?? "")}</td><td class="num"><b>${esc(row.points ?? 0)}</b></td>
            <td class="num">${esc(row.starts ?? 0)}</td><td class="num">${esc(row.wins ?? 0)}</td><td class="num">${esc(row.podiums ?? 0)}</td></tr>`;
        }).join("") : '<tr><td colspan="7" class="empty-line">No rounds recorded yet.</td></tr>'}
      </tbody></table></div>
      <div class="table-wrap"><table class="sheet"><thead><tr>
          <th class="right">Pos</th><th>Constructor</th><th class="right">Pts</th><th class="right">Wins</th><th class="right">Podiums</th>
        </tr></thead><tbody>
        ${teams.length ? teams.map((row) => `<tr><td class="num">${esc(row.position)}</td><td><b>${esc(row.name)}</b></td>
            <td class="num"><b>${esc(row.points ?? 0)}</b></td><td class="num">${esc(row.wins ?? 0)}</td><td class="num">${esc(row.podiums ?? 0)}</td></tr>`).join("")
          : '<tr><td colspan="5" class="empty-line">No rounds recorded yet.</td></tr>'}
      </tbody></table></div>`;
  }

  function squadView() {
    const officials = state.lineups?.officials ?? [];
    const seated = officials.reduce((total, entry) => total + (entry.members?.length ?? 0), 0);
    return `<h3>Squad</h3>
      <p class="fia-hint">${seated} official${seated === 1 ? "" : "s"} across ${officials.length} role${officials.length === 1 ? "" : "s"}, read from Discord. ${state.lineups?.generated_at ? `Lineups published ${esc(stamp(state.lineups.generated_at))}.` : ""}</p>
      <div class="officials-grid">${officials.length ? officials.map((entry) => `
        <article class="official"><h3>${esc(entry.role)}</h3>
          <div class="people">${(entry.members ?? []).map((person) => `
            <span class="person" title="${esc(person.name)}"><span class="avatar">${esc(initials(person.name))}</span>${esc(person.name)}</span>`).join("") || '<span class="empty-line">Nobody assigned.</span>'}
          </div>
        </article>`).join("") : '<p class="empty-line">No FIA roles are being published right now.</p>'}
      </div>`;
  }

  function activityView() {
    const entries = [...(state.doc?.audit ?? [])].reverse();
    return `<div class="fia-section-head">
        <h3>Activity</h3>
        <button type="button" class="action" data-action="reload">Reload published</button>
        <button type="button" class="action" data-action="export">Export JSON</button>
      </div>
      <p class="fia-hint">Every edit is recorded locally and published with the results file, so the season carries its own history.</p>
      ${entries.length ? `<ul class="fia-activity">${entries.map((entry) => `
        <li><b>${esc(entry.action)}</b> — ${esc(entry.detail)}<br>
        <span class="fia-meta-line">${esc(stamp(entry.at))} · ${esc(entry.by)}</span></li>`).join("")}</ul>`
        : '<p class="empty-line">No changes yet in this session.</p>'}`;
  }

  // Round editing ------------------------------------------------------------ //

  function openRound(division, roundNumber) {
    const divisionEntry = CORE.divisionEntry(state.doc, division);
    const round = divisionEntry?.rounds.find((item) => CORE.num(item.round, -1) === CORE.num(roundNumber, -2));
    if (!round) return;
    state.edit = {
      mode: "edit",
      division: divisionEntry.name,
      round: round.round,
      circuit: round.circuit ?? "",
      pole: round.pole?.username ?? "",
      fastest: round.fastest_lap?.username ?? "",
      entries: (round.classification ?? []).map((entry) => ({
        username: entry.username ?? "",
        name: entry.name ?? "",
        team: entry.short || entry.team || "",
        status: entry.status === "retired" ? "retired" : "classified",
        points: CORE.num(entry.points, 0),
      })),
    };
    state.confirm = null;
    render();
  }

  function newRound() {
    const division = state.division ?? divisions()[0]?.name ?? "F1";
    const existing = CORE.divisionEntry(state.doc, division);
    const next = (existing?.rounds ?? []).reduce((max, round) => Math.max(max, CORE.num(round.round, 0)), 0) + 1;
    state.edit = {
      mode: "new",
      division,
      round: next,
      circuit: "",
      pole: "",
      fastest: "",
      entries: [],
    };
    render();
  }

  function addEntry(username) {
    const edit = state.edit;
    if (!username) return;
    if (edit.entries.some((entry) => entry.username === username)) {
      return say("That driver is already in the classification.", true);
    }
    const person = roster(edit.division).get(username);
    if (!person) return;
    edit.entries.push({ username, name: person.name, team: person.team, status: "classified", points: 0 });
    render();
  }

  function moveEntry(index, offset) {
    const entries = state.edit?.entries;
    if (!entries) return;
    const target = index + offset;
    if (target < 0 || target >= entries.length) return;
    const [entry] = entries.splice(index, 1);
    entries.splice(target, 0, entry);
    render();
  }

  function saveRound(event) {
    event.preventDefault();
    if (!state.edit) return;
    const edit = {
      ...state.edit,
      ...formValues(event.target, "edit", ["division", "round", "circuit", "pole", "fastest"]),
    };
    const division = String(edit.division ?? "").toUpperCase();
    const roundNumber = Number(edit.round);
    const circuit = String(edit.circuit ?? "").trim();

    if (!division) return say("Pick a division for this round.", true);
    if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > 99) {
      return say("The round must be a whole number from 1 to 99.", true);
    }
    if (!circuit) return say("Add the circuit name.", true);
    if (!edit.entries.length) return say("Add at least one driver to the classification.", true);
    if (edit.entries.length > CORE.MAX_CLASSIFIED) {
      return say(`A result can list at most ${CORE.MAX_CLASSIFIED} drivers.`, true);
    }
    const usernames = edit.entries.map((entry) => entry.username);
    if (new Set(usernames).size !== usernames.length) return say("A driver appears twice.", true);
    if (!edit.entries.some((entry) => entry.status !== "retired")) {
      return say("Every driver is retired — at least one has to be classified.", true);
    }
    for (const [label, value] of [["pole", edit.pole], ["fastest lap", edit.fastest]]) {
      if (value && !usernames.includes(value)) {
        return say(`The ${label} has to be in the classification.`, true);
      }
    }

    const table = CORE.pointsTable(CORE.divisionEntry(state.doc, division) ?? {});
    let position = 0;
    const classification = edit.entries.map((entry) => {
      const retired = entry.status === "retired";
      if (!retired) position += 1;
      return {
        position: retired ? null : position,
        name: entry.name,
        username: entry.username,
        team: entry.team,
        short: entry.team,
        status: retired ? "retired" : "classified",
        points: retired ? 0 : CORE.pointsFor(table, position),
      };
    });

    const target = CORE.ensureDivision(state.doc, division);
    const existing = target.rounds.find((item) => CORE.num(item.round, -1) === roundNumber);
    const personFor = (value) => {
      if (!value) return null;
      const entry = classification.find((item) => item.username === value);
      return entry ? { name: entry.name, username: entry.username, team: entry.short } : null;
    };

    const record = {
      round: roundNumber,
      circuit,
      pole: personFor(edit.pole),
      fastest_lap: personFor(edit.fastest),
      recorded_at: existing?.recorded_at ?? new Date().toISOString(),
      recorded_by: existing?.recorded_by ?? author(),
      classification,
      penalties: existing?.penalties ?? [],
    };

    target.rounds = [
      ...target.rounds.filter((item) => CORE.num(item.round, -1) !== roundNumber),
      record,
    ].sort((a, b) => CORE.num(a.round, 0) - CORE.num(b.round, 0));

    CORE.refreshStandings(state.doc);
    CORE.audit(state.doc, {
      action: existing ? "Edit round" : "Add round",
      detail: `${division} round ${roundNumber}${circuit ? ` — ${circuit}` : ""}`,
      by: author(),
    });

    state.edit = null;
    state.confirm = null;
    markDirty();
    say(`${existing ? "Updated" : "Added"} ${division} round ${roundNumber}. Publish to put it live.`, false);
    render();
  }

  function deleteRound(division, roundNumber) {
    const target = CORE.divisionEntry(state.doc, division);
    if (!target) return;
    const before = target.rounds.length;
    target.rounds = target.rounds.filter((item) => CORE.num(item.round, -1) !== CORE.num(roundNumber, -2));
    if (target.rounds.length === before) return;
    CORE.refreshStandings(state.doc);
    CORE.audit(state.doc, {
      action: "Delete round",
      detail: `${division} round ${roundNumber}`,
      by: author(),
    });
    state.confirm = null;
    markDirty();
    say(`Removed ${division} round ${roundNumber} and rebuilt the table.`, false);
    render();
  }

  // Decisions --------------------------------------------------------------- //

  function penaltyTarget(divisionName, roundNumber, id) {
    const division = CORE.divisionEntry(state.doc, divisionName);
    const round = division?.rounds.find((item) => CORE.num(item.round, -1) === CORE.num(roundNumber, -2));
    if (!round) return null;
    const index = (round.penalties ?? []).findIndex((item) => String(item.id ?? "") === String(id ?? ""));
    return { division, round, index };
  }

  // Form fields are read from the document at submit time as well as being kept
  // in state, so a field the steward never touched still counts.
  function formValues(form, attribute, fields) {
    const values = {};
    for (const field of fields) {
      const element = form?.querySelector(`[data-${attribute}="${field}"]`);
      if (element) values[field] = element.value;
    }
    return values;
  }

  function savePenalty(event) {
    event.preventDefault();
    const form = event.target;
    const draft = {
      ...(state.penalty ?? {}),
      ...formValues(form, "penalty", ["division", "round", "driver", "type", "value", "reason"]),
    };
    const divisionName = draft.division ?? state.division ?? divisions()[0]?.name;
    const division = CORE.divisionEntry(state.doc, divisionName);
    const round = division?.rounds.find((item) => CORE.num(item.round, -1) === CORE.num(draft.round, -2));
    if (!round) return say("Pick a round with a recorded result.", true);

    const type = CORE.penaltyType(draft.type ?? "points");
    if (!type) return say("Pick a decision type.", true);
    const value = type.hasValue ? Math.abs(Number(draft.value) || 0) : 0;
    if (type.hasValue && !value) return say(`Add a ${type.unit} value for this decision.`, true);

    const people = new Map();
    for (const entry of round.classification ?? []) {
      if (entry?.username) people.set(entry.username, entry);
    }
    const driverKey = draft.driver ?? "";
    const driver = people.get(driverKey);
    if (!driver) return say("Pick the driver this decision is about.", true);
    if (!String(draft.reason ?? "").trim()) return say("Write a short reason — it is published.", true);

    const record = {
      id: draft.id ?? `dec-${Date.now().toString(36)}`,
      type: type.id,
      value,
      name: driver.name,
      username: driver.username,
      team: driver.short || driver.team || "",
      reason: String(draft.reason).trim(),
      division: division.name,
      round: round.round,
      issued_at: draft.issued_at ?? new Date().toISOString(),
      issued_by: draft.issued_by ?? author(),
    };

    round.penalties = Array.isArray(round.penalties) ? round.penalties : [];
    if (Number.isInteger(draft.index) && draft.index >= 0) round.penalties[draft.index] = record;
    else round.penalties.push(record);

    CORE.refreshStandings(state.doc);
    CORE.audit(state.doc, {
      action: Number.isInteger(draft.index) ? "Edit decision" : "Add decision",
      detail: `${division.name} round ${round.round} · ${record.name} · ${CORE.penaltyLabel(record)}`,
      by: author(),
    });

    state.penalty = null;
    markDirty();
    say("Decision saved as a draft. Publish to put it live.", false);
    render();
  }

  function removePenalty(divisionName, roundNumber, id) {
    const found = penaltyTarget(divisionName, roundNumber, id);
    if (!found || found.index < 0) return;
    const [removed] = found.round.penalties.splice(found.index, 1);
    CORE.refreshStandings(state.doc);
    CORE.audit(state.doc, {
      action: "Withdraw decision",
      detail: `${divisionName} round ${roundNumber} · ${removed?.name ?? "driver"} · ${CORE.penaltyLabel(removed)}`,
      by: author(),
    });
    markDirty();
    say("Decision withdrawn and the table rebuilt.", false);
    render();
  }

  // Clips ------------------------------------------------------------------- //

  function saveClip(event) {
    event.preventDefault();
    const draft = {
      ...(state.clip ?? {}),
      ...formValues(event.target, "clip", ["title", "url", "division", "round"]),
    };
    const title = String(draft.title ?? "").trim();
    const url = String(draft.url ?? "").trim();
    if (!title) return say("Give the clip a title.", true);
    if (!/^https:\/\/|^http:\/\//i.test(url)) return say("The link needs to start with http:// or https://", true);
    try {
      new URL(url);
    } catch (error) {
      return say("That link is not a valid URL.", true);
    }

    const record = {
      id: draft.id ?? `clip-${Date.now().toString(36)}`,
      title,
      url,
      kind: CORE.parseMedia(url).kind,
      division: String(draft.division ?? "").toUpperCase(),
      round: draft.round === "" || draft.round === undefined || draft.round === null
        ? null : Number(draft.round),
      note: String(draft.note ?? "").trim(),
      added_at: draft.added_at ?? new Date().toISOString(),
      added_by: draft.added_by ?? author(),
    };

    if (record.round !== null && (!Number.isInteger(record.round) || record.round < 1 || record.round > 99)) {
      return say("The round has to be a whole number from 1 to 99.", true);
    }

    if (!Array.isArray(state.doc.media)) state.doc.media = [];
    const index = state.doc.media.findIndex((item) => item.id === record.id);
    if (index >= 0) state.doc.media[index] = record;
    else state.doc.media.push(record);

    CORE.audit(state.doc, {
      action: index >= 0 ? "Edit clip" : "Add clip",
      detail: title,
      by: author(),
    });

    state.clip = null;
    markDirty();
    say("Clip saved as a draft. Publish to put it live.", false);
    render();
  }

  function removeClip(id) {
    const before = state.doc.media?.length ?? 0;
    state.doc.media = (state.doc.media ?? []).filter((item) => item.id !== id);
    if ((state.doc.media?.length ?? 0) === before) return;
    CORE.audit(state.doc, { action: "Remove clip", detail: id, by: author() });
    markDirty();
    say("Clip removed from the draft.", false);
    render();
  }

  // Publishing -------------------------------------------------------------- //

  async function gh(path, options = {}) {
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${state.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    };
    const response = await fetch(`${API}${path}`, { ...options, headers });
    const body = await response.text();
    let data = null;
    try {
      data = body ? JSON.parse(body) : null;
    } catch (error) {
      data = null;
    }
    return { status: response.status, ok: response.ok, data, body };
  }

  function explain(status, data) {
    const message = String(data?.message ?? "").trim();
    if (status === 401) return "GitHub rejected the token (401). Paste a fresh fine-grained token.";
    if (status === 403) return `GitHub refused the write (403).${message ? ` ${message}` : ""} The token needs Contents: read and write.`;
    if (status === 404) return `GitHub can't see ${state.repo} (404). Check the repository name and that the token can reach it.`;
    if (status === 409 || status === 422) return "Someone published while you were editing, so the file moved. Reload and reapply before publishing.";
    return `GitHub answered ${status}${message ? `: ${message}` : ""}.`;
  }

  async function checkAccess() {
    if (!state.token) return say("Paste a token first.", true);
    const note = $("fia-settings-note");
    note.textContent = "Checking…";
    note.classList.remove("error");
    try {
      const repo = await gh(`/repos/${state.repo}`);
      if (!repo.ok) {
        note.textContent = explain(repo.status, repo.data);
        note.classList.add("error");
        return;
      }
      const push = repo.data?.permissions?.push;
      const file = await gh(`/repos/${state.repo}/contents/${RESULTS_PATH}?ref=${encodeURIComponent(state.branch)}`);
      note.textContent = `${repo.data.full_name} · default branch ${repo.data.default_branch} · ${push ? "write access" : "read only"} · ${RESULTS_PATH} ${file.status === 200 ? "exists" : "will be created"}`;
      note.classList.toggle("error", !push);
    } catch (error) {
      note.textContent = `Could not reach GitHub (${error.message}).`;
      note.classList.add("error");
    }
  }

  async function publish() {
    if (state.busy) return;
    if (!state.token) {
      $("fia-settings").hidden = false;
      $("fia-settings-toggle").setAttribute("aria-expanded", "true");
      $("fia-token").focus();
      return say("Add a GitHub token in Publish settings before publishing.", true);
    }
    if (!state.dirty) return say("Nothing to publish — the repo already has this.", false);

    state.busy = true;
    renderChrome();
    say("Publishing…", false);

    const next = JSON.parse(JSON.stringify(state.doc));
    const totalDecisions = divisions().reduce((sum, division) => sum + decisionsOf(division).length, 0);
    // Never publish a table that disagrees with the rounds: a clip or a decision
    // edit can leave the stored standings behind if this is skipped.
    CORE.refreshStandings(next);
    next.updated_at = new Date().toISOString();
    CORE.audit(next, {
      action: "Publish",
      detail: `${allRounds().length} round(s), ${totalDecisions} decision(s), ${clips().length} clip(s)`,
      by: author(),
    });
    const text = serialize(next);
    const url = `${API}/repos/${state.repo}/contents/${RESULTS_PATH}`;

    try {
      let commit = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const existing = await gh(`/repos/${state.repo}/contents/${RESULTS_PATH}?ref=${encodeURIComponent(state.branch)}`);
        let sha = null;
        if (existing.status === 200) sha = existing.data?.sha ?? null;
        else if (existing.status !== 404) {
          say(explain(existing.status, existing.data), true);
          return;
        }

        const body = {
          message: `FIA desk: ${allRounds().length} round(s), ${totalDecisions} decision(s)`,
          content: toBase64(text),
          branch: state.branch,
        };
        if (sha) body.sha = sha;

        const result = await gh(`/repos/${state.repo}/contents/${RESULTS_PATH}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });

        if (result.ok) {
          commit = result.data?.commit?.sha ?? "";
          break;
        }
        const retryable = result.status === 409 || result.status === 422;
        if (!retryable || attempt === 1) {
          say(explain(result.status, result.data), true);
          return;
        }
        say("The file moved under us — retrying with the new version…", false);
        await new Promise((resolve) => setTimeout(resolve, 800));
      }

      state.doc = next;
      state.publishedText = serialize(next);
      state.dirty = false;
      commit = commit || "";
      if (commit) {
        say(`Published — commit ${commit.slice(0, 7)}. GitHub Pages takes about 40 seconds to rebuild.`, false);
      } else {
        say("Published. GitHub Pages takes about 40 seconds to rebuild.", false);
      }
      render();
    } catch (error) {
      say(`Publish failed: ${error.message}`, true);
    } finally {
      state.busy = false;
      renderChrome();
    }
  }

  // Loading + wiring -------------------------------------------------------- //

  function exportJson() {
    const blob = new Blob([serialize(state.doc)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "results.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    say("Exported results.json.", false);
  }

  async function reloadPublished() {
    if (state.dirty && !window.confirm("Discard your unpublished changes and reload what is live?")) return;
    state.loaded = false;
    state.edit = null;
    state.penalty = null;
    state.clip = null;
    state.confirm = null;
    try {
      await load(true);
      render();
      say("Reloaded the published results.", false);
    } catch (error) {
      say(`Could not reload: ${error.message}`, true);
    }
  }

  function onClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const index = Number(button.dataset.index);

    if (action === "new-round") newRound();
    else if (action === "edit-round") openRound(button.dataset.division, button.dataset.round);
    else if (action === "delete-round") {
      state.confirm = `${button.dataset.division}:${button.dataset.round}`;
      render();
    } else if (action === "confirm-delete") deleteRound(button.dataset.division, button.dataset.round);
    else if (action === "cancel-delete") {
      state.confirm = null;
      render();
    } else if (action === "show-division") {
      state.division = button.dataset.division;
      render();
    } else if (action === "show-standings") {
      state.standingsDivision = button.dataset.division;
      render();
    } else if (action === "cancel-edit") {
      state.edit = null;
      render();
    } else if (action === "entry-up") moveEntry(index, -1);
    else if (action === "entry-down") moveEntry(index, 1);
    else if (action === "entry-remove") {
      state.edit?.entries.splice(index, 1);
      render();
    } else if (action === "entry-add") addEntry($("fia-add-driver")?.value ?? "");
    else if (action === "edit-penalty") {
      const found = penaltyTarget(button.dataset.division, button.dataset.round, button.dataset.id);
      if (!found || found.index < 0) return;
      const penalty = found.round.penalties[found.index];
      state.penalty = {
        ...penalty,
        division: button.dataset.division,
        round: found.round.round,
        index: found.index,
      };
      render();
    } else if (action === "cancel-penalty") {
      state.penalty = null;
      render();
    } else if (action === "remove-penalty") {
      removePenalty(button.dataset.division, button.dataset.round, button.dataset.id);
    } else if (action === "edit-clip") {
      const item = (state.doc.media ?? []).find((clip) => clip.id === button.dataset.id);
      if (!item) return;
      state.clip = { ...item };
      render();
    } else if (action === "cancel-clip") {
      state.clip = null;
      render();
    } else if (action === "remove-clip") removeClip(button.dataset.id);
    else if (action === "recompute") {
      CORE.refreshStandings(state.doc);
      CORE.audit(state.doc, { action: "Recompute", detail: "Rebuilt every championship table", by: author() });
      markDirty();
      say("Tables rebuilt from the recorded rounds.", false);
      render();
    } else if (action === "export") exportJson();
    else if (action === "reload") reloadPublished();
  }

  function onChange(event) {
    const select = event.target;

    if (select.matches("[data-entry-driver]")) {
      const index = Number(select.dataset.index);
      const person = roster(state.edit.division).get(select.value);
      const entry = state.edit.entries[index];
      if (!entry) return;
      entry.username = select.value;
      entry.name = person?.name ?? entry.name;
      entry.team = person?.team ?? entry.team;
      render();
    } else if (select.matches("[data-entry-status]")) {
      const entry = state.edit.entries[Number(select.dataset.index)];
      if (!entry) return;
      entry.status = select.value;
      render();
    } else if (select.matches("[data-edit]")) {
      const field = select.dataset.edit;
      state.edit[field] = select.value;
      if (field === "division") render();
    } else if (select.matches("[data-penalty]")) {
      const field = select.dataset.penalty;
      state.penalty = state.penalty ?? {};
      state.penalty[field] = select.value;
      if (["division", "round", "type"].includes(field)) {
        if (field !== "type") delete state.penalty.driver;
        render();
      }
    } else if (select.matches("[data-clip]")) {
      state.clip = state.clip ?? {};
      state.clip[select.dataset.clip] = select.value;
    }
  }

  function onInput(event) {
    const field = event.target;
    if (field.matches("[data-edit]")) {
      state.edit[field.dataset.edit] = field.value;
    } else if (field.matches("[data-penalty]")) {
      state.penalty = state.penalty ?? {};
      state.penalty[field.dataset.penalty] = field.value;
    } else if (field.matches("[data-clip]")) {
      state.clip = state.clip ?? {};
      state.clip[field.dataset.clip] = field.value;
      if (field.dataset.clip === "url") {
        const hint = $("fia-clip-kind");
        if (hint) hint.textContent = field.value ? `${CORE.parseMedia(field.value).label} detected.` : "Paste a video link.";
      }
    }
  }

  function onSubmit(event) {
    if (event.target.id === "fia-round-form") saveRound(event);
    else if (event.target.id === "fia-penalty-form") savePenalty(event);
    else if (event.target.id === "fia-clip-form") saveClip(event);
  }

  // Gate -------------------------------------------------------------------- //

  function isOpen() {
    return location.hash.toLowerCase() === HASH;
  }

  function showBody(unlocked) {
    $("fia-gate").hidden = unlocked;
    $("fia-body").hidden = !unlocked;
    if (unlocked) {
      load()
        .then(() => render())
        .catch((error) => say(`Could not read the published data (${error.message}).`, true));
    } else {
      $("fia-password").focus();
    }
  }

  function setMode(on) {
    document.body.dataset.fia = on ? "on" : "";
    section.hidden = !on;
    document.title = on ? "FIA — race control" : publicTitle;
    if (on) {
      window.scrollTo({ top: 0 });
      const unlocked = sessionStorage.getItem(UNLOCK_KEY) === "1";
      if (unlocked) {
        $("fia-repo").value = state.repo;
        $("fia-branch").value = state.branch;
        $("fia-author").value = state.author;
        $("fia-token").value = state.token;
      }
      showBody(unlocked);
    } else {
      // The unlock lives for the tab, not for the hash: leaving the desk hides
      // it, and coming back does not ask again. Only Lock forgets the session.
      $("fia-password").value = "";
      $("fia-gate-note").textContent = "";
      $("fia-gate-note").classList.remove("error");
    }
  }

  $("fia-gate").addEventListener("submit", async (event) => {
    event.preventDefault();
    const note = $("fia-gate-note");
    const entered = $("fia-password").value;
    if ((await digest(entered)) !== CODE_SHA256) {
      note.textContent = "That code is not recognised.";
      note.classList.add("error");
      $("fia-password").select();
      return;
    }
    note.textContent = "";
    note.classList.remove("error");
    sessionStorage.setItem(UNLOCK_KEY, "1");
    $("fia-password").value = "";
    $("fia-repo").value = state.repo;
    $("fia-branch").value = state.branch;
    $("fia-author").value = state.author;
    $("fia-token").value = state.token;
    showBody(true);
  });

  $("fia-lock").addEventListener("click", () => {
    sessionStorage.removeItem(UNLOCK_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    state.token = "";
    state.edit = null;
    state.penalty = null;
    state.clip = null;
    state.confirm = null;
    if (state.doc) {
      state.doc = null;
      state.loaded = false;
    }
    $("fia-token").value = "";
    $("fia-body").hidden = true;
    $("fia-gate").hidden = false;
    $("fia-password").value = "";
    $("fia-status").textContent = "";
    $("fia-gate-note").textContent = "Locked — the token was forgotten.";
    $("fia-gate-note").classList.remove("error");
    $("fia-password").focus();
  });

  $("fia-nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button) return;
    state.view = button.dataset.view;
    state.edit = null;
    state.penalty = null;
    state.clip = null;
    state.confirm = null;
    render();
  });

  $("fia-view").addEventListener("click", onClick);
  $("fia-view").addEventListener("change", onChange);
  $("fia-view").addEventListener("input", onInput);
  $("fia-view").addEventListener("submit", onSubmit);

  $("fia-publish").addEventListener("click", publish);
  $("fia-discard").addEventListener("click", async () => {
    if (!state.dirty) return;
    if (!window.confirm("Discard every unpublished change?")) return;
    state.doc = CORE.normalizeDocument(JSON.parse(state.publishedText));
    state.dirty = false;
    state.edit = null;
    state.penalty = null;
    state.clip = null;
    state.confirm = null;
    say("Draft discarded.", false);
    render();
  });

  $("fia-settings-toggle").addEventListener("click", () => {
    const panel = $("fia-settings");
    panel.hidden = !panel.hidden;
    $("fia-settings-toggle").setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) {
      $("fia-repo").value = state.repo;
      $("fia-branch").value = state.branch;
      $("fia-author").value = state.author;
      $("fia-token").value = state.token;
    }
  });

  $("fia-repo").addEventListener("input", (event) => {
    state.repo = event.target.value.trim() || DEFAULT_REPO;
    localStorage.setItem("ams-fia-repo", state.repo);
  });
  $("fia-branch").addEventListener("input", (event) => {
    state.branch = event.target.value.trim() || DEFAULT_BRANCH;
    localStorage.setItem("ams-fia-branch", state.branch);
  });
  $("fia-author").addEventListener("input", (event) => {
    state.author = event.target.value.trim();
    localStorage.setItem("ams-fia-author", state.author);
  });
  $("fia-token").addEventListener("input", (event) => {
    state.token = event.target.value.trim();
    if (state.token) sessionStorage.setItem(TOKEN_KEY, state.token);
    else sessionStorage.removeItem(TOKEN_KEY);
  });

  $("fia-check").addEventListener("click", checkAccess);
  $("fia-forget").addEventListener("click", () => {
    state.token = "";
    sessionStorage.removeItem(TOKEN_KEY);
    $("fia-token").value = "";
    $("fia-settings-note").textContent = "Token forgotten. Paste a new one to publish again.";
  });

  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  window.addEventListener("hashchange", () => setMode(isOpen()));
  // A reload can apply the fragment after this script runs, so re-check once the
  // document has finished loading as well.
  window.addEventListener("load", () => setMode(isOpen()));
  setMode(isOpen());
})();
