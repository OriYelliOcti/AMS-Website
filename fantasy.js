// Fantasy tab: build a team from the live lineups, get a lock-in code, and follow
// the leaderboard the bot publishes to data/fantasy.json.
//
// The code is "amsf." + base64url of ["amsf", 1, division, round, driver
// usernames, team short names]. bot.py decodes the same shape (decode_fantasy_code),
// so this file and the bot must change together.

(() => {
  "use strict";

  const LINEUPS_URL = "data/lineups.json";
  const RESULTS_URL = "data/results.json";
  const FANTASY_URL = "data/fantasy.json";
  const LOCALE = "en-GB";
  const STORAGE_KEY = "ams.fantasy.teams";
  const POLL_INTERVAL_MS = 5 * 60_000;

  const $ = (id) => document.getElementById(id);

  const state = {
    lineups: null,
    results: null,
    fantasy: null,
    division: null,
    drivers: [], // selected driver usernames
    teams: [],   // selected team short names
  };

  let saved = loadSaved(); // teams this browser has already locked in
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
    const status = $("fantasy-status");
    if (!status) return;
    status.textContent = text;
    status.classList.toggle("error", Boolean(isError));
  }

  // ---------- data ----------

  function divisions() {
    const names = (state.lineups?.divisions ?? []).map((division) => division.name).filter(Boolean);
    if (names.length) return names;
    return (state.fantasy?.divisions ?? []).map((division) => division.name).filter(Boolean);
  }

  function currentDivision() {
    const names = divisions();
    if (state.division && names.includes(state.division)) return state.division;
    return names[0] ?? null;
  }

  function divisionEntry() {
    return (state.lineups?.divisions ?? []).find((division) => division.name === currentDivision()) ?? null;
  }

  function picks() {
    const config = state.fantasy?.picks ?? {};
    return {
      drivers: Number.isInteger(config.drivers) && config.drivers > 0 ? config.drivers : 3,
      teams: Number.isInteger(config.teams) && config.teams > 0 ? config.teams : 1,
    };
  }

  function driverOptions() {
    const division = divisionEntry();
    const found = new Map();
    for (const team of division?.teams ?? []) {
      for (const slot of team.slots ?? []) {
        if (!["Driver", "Reserve", "Other"].includes(slot.slot)) continue;
        for (const person of slot.members ?? []) {
          if (person.bot || !person.username || found.has(person.username)) continue;
          found.set(person.username, {
            name: person.name,
            username: person.username,
            team: team.short || team.name,
            color: team.color || null,
          });
        }
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, LOCALE));
  }

  function teamOptions() {
    const teams = new Map();
    for (const driver of driverOptions()) {
      if (!teams.has(driver.team)) teams.set(driver.team, { name: driver.team, color: driver.color });
    }
    return [...teams.values()].sort((a, b) => a.name.localeCompare(b.name, LOCALE));
  }

  function recordedRounds() {
    const division = (state.results?.divisions ?? []).find((entry) => entry.name === currentDivision());
    return (division?.rounds ?? [])
      .map((round) => Number(round.round))
      .filter((round) => Number.isInteger(round) && round > 0);
  }

  function nextRound() {
    const rounds = recordedRounds();
    return rounds.length ? Math.max(...rounds) + 1 : 1;
  }

  // ---------- lock-in code ----------

  function encodeTeam(division, round, drivers, teams) {
    const payload = ["amsf", 1, division, round, drivers, teams];
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `amsf.${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  }

  function loadSaved() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      if (!Array.isArray(raw)) return [];
      return raw.filter((team) => team && typeof team === "object" && typeof team.code === "string");
    } catch (error) {
      return []; // private mode, or an older shape
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch (error) {
      /* storage is optional: the code is still shown on screen */
    }
  }

  function saveTeam(team) {
    saved = saved.filter((item) => !(item.division === team.division && Number(item.round) === Number(team.round)));
    saved = [...saved, team].slice(-20);
    persist();
  }

  function forgetTeam(division, round) {
    saved = saved.filter((item) => !(item.division === division && Number(item.round) === Number(round)));
    persist();
  }

  // A saved team belongs to one division and round. Once that round is recorded,
  // it is history, so it silently stops being "your team" for the next pick.
  function currentSaved() {
    return saved.find(
      (team) => team.division === currentDivision() && Number(team.round) === nextRound(),
    ) ?? null;
  }

  function samePicks(left = [], right = []) {
    const a = [...left].sort();
    const b = [...right].sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }

  // ---------- rendering ----------

  function chip(label, selected, href, color) {
    return `<button type="button" class="chip" data-value="${esc(href)}" aria-pressed="${selected}"
      ${color ? `style="--chip-color:${esc(color)}"` : ""}>${esc(label)}</button>`;
  }

  function renderNav() {
    const nav = $("fantasy-nav");
    if (!nav) return;
    const names = divisions();
    nav.innerHTML = names.map((name) =>
      `<button type="button" data-division="${esc(name)}" aria-pressed="${name === currentDivision()}">${esc(name)}</button>`
    ).join("");
    nav.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        state.division = button.dataset.division;
        state.drivers = [];
        state.teams = [];
        render();
      });
    });
  }

  function renderPicker() {
    const config = picks();
    const drivers = driverOptions();
    const teams = teamOptions();
    const driverBox = $("fantasy-drivers");
    const teamBox = $("fantasy-teams");
    const lock = $("fantasy-lock");
    const hint = $("fantasy-hint");

    $("fantasy-round").textContent = currentDivision()
      ? `${currentDivision()} · picking for round ${nextRound()}`
      : "";

    $("fantasy-driver-label").textContent = `Drivers (${state.drivers.length}/${config.drivers})`;
    $("fantasy-team-label").textContent = `Team (${state.teams.length}/${config.teams})`;

    driverBox.innerHTML = drivers.length
      ? drivers.map((driver) => chip(
        `${driver.name} · ${driver.team}`,
        state.drivers.includes(driver.username),
        driver.username,
        driver.color,
      )).join("")
      : '<p class="empty-line">No drivers are published for this division yet.</p>';

    teamBox.innerHTML = config.teams === 0
      ? ""
      : teams.map((team) => chip(team.name, state.teams.includes(team.name), team.name, team.color)).join("");

    driverBox.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => toggle(state.drivers, button.dataset.value, config.drivers));
    });
    teamBox.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => toggle(state.teams, button.dataset.value, config.teams));
    });

    const complete = state.drivers.length === config.drivers && state.teams.length === config.teams;
    lock.disabled = !complete || !drivers.length;
    delete hint.dataset.locked;
    if (!complete) {
      const missing = [];
      if (state.drivers.length < config.drivers) missing.push(`${config.drivers - state.drivers.length} more driver(s)`);
      if (state.teams.length < config.teams) missing.push(`${config.teams - state.teams.length} more team`);
      hint.textContent = `Pick ${missing.join(" and ")}.`;
    } else {
      hint.textContent = "Ready — lock it in to get your code.";
    }
  }

  function toggle(list, value, limit) {
    const index = list.indexOf(value);
    if (index >= 0) list.splice(index, 1);
    else if (list.length < limit) list.push(value);
    renderPicker();
    renderCode();
  }

  function renderCode() {
    const box = $("fantasy-code");
    const value = $("fantasy-code-value");
    const hint = $("fantasy-hint");
    const team = currentSaved();

    if (!team) {
      box.hidden = true;
      value.textContent = "";
      delete hint.dataset.locked;
      return;
    }
    box.hidden = false;
    value.textContent = team.code;
    hint.dataset.locked = "1";
    hint.textContent = samePicks(team.drivers, state.drivers) && samePicks(team.teams, state.teams)
      ? `Round ${team.round} locked in on this browser — paste the code into Discord to submit it.`
      : "Picks changed since you locked in — lock in again for a new code.";
  }

  function renderBoard() {
    const division = (state.fantasy?.divisions ?? []).find((entry) => entry.name === currentDivision());
    const rows = division?.entries ?? [];

    $("fantasy-standings").innerHTML = rows.length
      ? rows.map((row) => {
        const handle = row.username && row.username !== row.name
          ? ` <span class="handle">@${esc(row.username)}</span>` : "";
        return `<tr>
          <td class="num">${esc(row.position)}</td>
          <td><b>${esc(row.name)}</b>${handle}</td>
          <td class="num"><b>${esc(row.points ?? 0)}</b></td>
          <td class="num">${esc(row.rounds ?? 0)}</td>
          <td class="num">${esc(row.best ?? 0)}</td>
        </tr>`;
      }).join("")
      : '<tr><td colspan="5" class="empty-line">No fantasy teams locked in yet.</td></tr>';

    renderLatest(division);

    $("fantasy-updated").textContent = state.fantasy?.updated_at
      ? `${state.fantasy.season ?? "Season"} · updated ${relative(state.fantasy.updated_at)}`
      : "";
  }

  function renderLatest(division) {
    const block = $("fantasy-latest");
    const latest = division?.latest;
    if (!latest || !(latest.entries ?? []).length) {
      block.hidden = true;
      block.innerHTML = "";
      return;
    }

    const places = latest.entries.map((entry) => {
      const picks = [...(entry.drivers ?? []), ...(entry.teams ?? [])].join(", ");
      return `<li><span class="pos">${esc(entry.points)} pts</span><b>${esc(entry.name)}</b>
        <span class="team-note">${esc(picks)}</span></li>`;
    }).join("");

    block.hidden = false;
    block.innerHTML = `
      <div class="last-round-head">
        <h3>Latest round</h3>
        <p class="last-round-title">Round ${esc(latest.round)}</p>
      </div>
      <ol class="last-round-list">${places}</ol>`;
  }

  function render() {
    if (!$("fantasy-standings")) return;
    if (!divisions().length) {
      $("fantasy-drivers").innerHTML = "";
      $("fantasy-teams").innerHTML = "";
      $("fantasy-lock").disabled = true;
      return;
    }
    renderNav();
    renderPicker();
    renderCode();
    renderBoard();

    const rounds = recordedRounds().length;
    const count = ((state.fantasy?.divisions ?? []).find((entry) => entry.name === currentDivision())?.entries ?? []).length;
    setStatus(
      `${currentDivision()} · ${count} player${count === 1 ? "" : "s"} · ` +
      `${rounds} round${rounds === 1 ? "" : "s"} scored · picking for round ${nextRound()}`,
      false,
    );
  }

  // ---------- wire up ----------

  $("fantasy-lock")?.addEventListener("click", () => {
    const config = picks();
    if (state.drivers.length !== config.drivers || state.teams.length !== config.teams) return;
    const division = currentDivision();
    const round = nextRound();
    saveTeam({
      division,
      round,
      drivers: [...state.drivers],
      teams: [...state.teams],
      code: encodeTeam(division, round, state.drivers, state.teams),
    });
    renderCode();
  });

  $("fantasy-reset")?.addEventListener("click", () => {
    forgetTeam(currentDivision(), nextRound());
    state.drivers = [];
    state.teams = [];
    renderPicker();
    renderCode();
  });

  $("fantasy-copy")?.addEventListener("click", async () => {
    const team = currentSaved();
    if (!team) return;
    const button = $("fantasy-copy");
    try {
      await navigator.clipboard.writeText(team.code);
      button.textContent = "Copied";
    } catch (error) {
      // Clipboard access can be blocked; the code is selectable either way.
      const range = document.createRange();
      range.selectNodeContents($("fantasy-code-value"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = "Select and copy";
    }
    setTimeout(() => { button.textContent = "Copy code"; }, 2000);
  });

  async function fetchJson(url) {
    try {
      const response = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      console.warn(`Could not load ${url}:`, error);
      return null;
    }
  }

  async function refresh() {
    const [lineups, results, fantasy] = await Promise.all([
      fetchJson(LINEUPS_URL),
      fetchJson(RESULTS_URL),
      fetchJson(FANTASY_URL),
    ]);
    state.lineups = lineups;
    state.results = results;
    state.fantasy = fantasy;
    lastCheckedAt = Date.now();

    if (!lineups) {
      $("fantasy-drivers").innerHTML = "";
      $("fantasy-teams").innerHTML = "";
      $("fantasy-standings").innerHTML = "";
      $("fantasy-lock").disabled = true;
      $("fantasy-latest").hidden = true;
      setStatus("The lineups are not published yet — there is nobody to pick.", true);
      return;
    }
    render();
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastCheckedAt >= POLL_INTERVAL_MS) refresh();
  });

  if ($("fantasy-standings")) refresh();
})();
