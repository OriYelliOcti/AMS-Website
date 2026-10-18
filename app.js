// Renders data/lineups.json, which the Discord bot publishes on every role change.
// No framework, no build step: this file is served straight by GitHub Pages.

const state = { data: null, query: "", division: "All" };

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (chr) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[chr]
  ));
}

function highlight(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const needle = escapeHtml(query);
  const at = safe.toLowerCase().indexOf(needle.toLowerCase());
  if (at === -1) return safe;
  return `${safe.slice(0, at)}<mark>${safe.slice(at, at + needle.length)}</mark>${safe.slice(at + needle.length)}`;
}

function initials(name) {
  const cleaned = String(name).replace(/[^\p{L}\p{N} ]/gu, " ").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

function relativeTime(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "unknown";
  const seconds = Math.round((then.getTime() - Date.now()) / 1000);
  const units = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
        .format(Math.round(seconds / size), unit);
    }
  }
  return "just now";
}

function matches(person, query) {
  return [person.name, person.username].some((field) =>
    String(field ?? "").toLowerCase().includes(query));
}

function personChip(person, teamColor, query) {
  const label = highlight(person.name, query);
  const handle = person.username && person.username !== person.name
    ? `<span class="handle">@${highlight(person.username, query)}</span>` : "";
  return `<span class="person${person.bot ? " is-bot" : ""}" title="${escapeHtml(person.name)}">
    <span class="avatar">${escapeHtml(initials(person.name))}</span>${label}${handle}</span>`;
}

function teamCard(team, query) {
  const color = team.color || "var(--accent)";
  const all = team.slots ?? [];
  const matchingPeople = all.flatMap((slot) => slot.members ?? []).filter((p) => matches(p, query));
  // Narrow to matching people only when the query matched people; if it matched the
  // team name instead, show the whole roster so the card is not empty.
  const shown = query && matchingPeople.length
    ? all.map((slot) => ({ ...slot, members: (slot.members ?? []).filter((p) => matches(p, query)) }))
        .filter((slot) => slot.members.length)
    : all;

  const slots = shown.map((slot) => `
    <div class="slot">
      <span class="slot-name">${escapeHtml(slot.slot)}</span>
      <div class="people">${slot.members.map((p) => personChip(p, color, query)).join("")}</div>
    </div>`).join("");

  return `<article class="team" style="--team-color:${escapeHtml(color)}">
    <header class="team-head">
      <h3>${highlight(team.short || team.name, query)}</h3>
      <span class="badge">${team.member_count}</span>
    </header>
    ${slots || '<p class="empty-line">No members yet.</p>'}
  </article>`;
}

function render() {
  const data = state.data;
  if (!data) return;
  const query = state.query.trim().toLowerCase();

  let teamCount = 0;
  let personCount = 0;
  const blocks = [];

  for (const division of data.divisions ?? []) {
    if (state.division !== "All" && division.name !== state.division) continue;

    const cards = [];
    for (const team of division.teams ?? []) {
      const teamMatches = !query || (team.short || team.name).toLowerCase().includes(query);
      const people = (team.slots ?? []).flatMap((slot) => slot.members ?? []);
      const peopleMatches = !query || people.some((p) => matches(p, query));
      if (!teamMatches && !peopleMatches) continue;

      teamCount += 1;
      personCount += people.length;
      cards.push(teamCard(team, query));
    }
    if (!cards.length) continue;

    blocks.push(`<section class="division">
      <h2>${escapeHtml(division.name)} <span class="count">${cards.length} team(s)</span></h2>
      <div class="teams">${cards.join("")}</div>
    </section>`);
  }

  $("lineups").innerHTML = blocks.join("");
  if (blocks.length) {
    $("status").textContent =
      `${teamCount} team(s) · ${personCount} roster entr${personCount === 1 ? "y" : "ies"}` +
      (query ? ` matching “${state.query.trim()}”` : "");
  } else if (query && state.division !== "All") {
    $("status").textContent =
      `Nothing matches “${state.query.trim()}” in ${state.division} — switch to All to search every division.`;
  } else if (query || state.division !== "All") {
    $("status").textContent = "Nothing matches that filter.";
  } else {
    $("status").textContent = "No lineups published yet.";
  }
  $("status").classList.remove("error");

  const officials = data.officials ?? [];
  $("officials-section").hidden = officials.length === 0;
  $("officials").innerHTML = officials.map((entry) => `
    <article class="official">
      <h3>${escapeHtml(entry.role)}</h3>
      <div class="people">${(entry.members ?? []).map((p) => personChip(p, "#6b7280", query)).join("")
        || '<span class="empty-line">Nobody assigned.</span>'}</div>
    </article>`).join("");
}

function renderHeader(data) {
  $("guild-name").textContent = data.guild?.name ?? "AMS";
  const totals = data.totals ?? {};
  $("totals").innerHTML = [
    ["Teams", totals.teams], ["Rostered", totals.rostered], ["Divisions", totals.divisions],
  ].map(([label, value]) => `<div class="stat"><b>${value ?? 0}</b><span>${label}</span></div>`).join("");

  const stamp = data.generated_at ? relativeTime(data.generated_at) : "unknown";
  const exact = data.generated_at ? new Date(data.generated_at).toLocaleString() : "";
  $("updated").textContent = `Updated ${stamp}`;
  $("updated").title = exact;
  $("footer-updated").textContent = exact ? `last updated ${exact}` : "";
}

function renderNav(data) {
  const names = ["All", ...(data.divisions ?? []).map((d) => d.name)];
  $("division-nav").innerHTML = names.map((name) =>
    `<button type="button" data-division="${escapeHtml(name)}" aria-pressed="${name === state.division}">${escapeHtml(name)}</button>`
  ).join("");

  $("division-nav").querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.division = button.dataset.division;
      $("division-nav").querySelectorAll("button").forEach((other) =>
        other.setAttribute("aria-pressed", String(other.dataset.division === state.division)));
      render();
    });
  });
}

async function load() {
  try {
    const response = await fetch(`data/lineups.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data || data.schema === undefined) throw new Error("unexpected payload");
    state.data = data;
    renderHeader(data);
    renderNav(data);
    render();
  } catch (error) {
    $("status").textContent =
      `Lineups are not available yet (${error.message}). The bot publishes them on the next role change.`;
    $("status").classList.add("error");
    $("guild-name").textContent = "AMS";
  }
}

$("search").addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});

load();
