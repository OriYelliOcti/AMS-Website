// Pure results/standings logic shared by the FIA desk, the public Stewards tab
// and the parity test. No DOM, no fetch: everything here takes a plain object
// and returns a plain object so the bot's Python can stay the reference.
//
// Loaded as a classic script in the browser (window.AMSResults) and required by
// node in tests, so the standings the panel writes match what bot.py computes.
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AMSResults = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SCHEMA = 2;
  const DIVISION_ORDER = ["F1", "F2", "F3", "GT3"];
  const DEFAULT_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
  const MAX_CLASSIFIED = 40;

  // Every decision the stewards can publish, in the order the panel lists them.
  // `standings` marks the two types that actually move a championship total.
  const PENALTY_TYPES = [
    { id: "points", label: "Points deduction", hasValue: true, unit: "pts", standings: true },
    { id: "grid", label: "Grid penalty", hasValue: true, unit: "places" },
    { id: "time", label: "Time penalty", hasValue: true, unit: "seconds" },
    { id: "dsq", label: "Disqualification", hasValue: false, standings: true },
    { id: "ban", label: "Suspension", hasValue: true, unit: "rounds" },
    { id: "warning", label: "Reprimand", hasValue: false },
  ];

  const MEDIA_KINDS = {
    youtube: "YouTube",
    twitch: "Twitch",
    streamable: "Streamable",
    medal: "Medal",
    video: "Video file",
    link: "Link",
  };

  function num(value, fallback = 0) {
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function text(value) {
    return String(value ?? "").trim();
  }

  // Same identity the bot uses: username when there is one, else the name.
  function keyOf(person) {
    if (person && typeof person === "object") {
      return text(person.username || person.name).toLowerCase();
    }
    return text(person).toLowerCase();
  }

  function divisionEntry(document, name) {
    const wanted = text(name).toUpperCase();
    return (document?.divisions ?? []).find(
      (entry) => entry && text(entry.name).toUpperCase() === wanted,
    ) ?? null;
  }

  function pointsTable(division) {
    const table = Array.isArray(division?.points) ? division.points : DEFAULT_POINTS;
    const clean = table.map((value) => Math.max(0, num(value, 0)));
    return clean.length ? clean : DEFAULT_POINTS.slice();
  }

  function pointsFor(table, position) {
    if (!Number.isInteger(position) || position < 1) return 0;
    return table[position - 1] ?? 0;
  }

  function penaltyType(id) {
    return PENALTY_TYPES.find((entry) => entry.id === id) ?? null;
  }

  function penaltyLabel(penalty) {
    const type = penaltyType(penalty?.type);
    if (!type) return text(penalty?.type) || "Decision";
    if (!type.hasValue) return type.label;
    const value = num(penalty.value, 0);
    if (type.unit === "pts") return `${value > 0 ? "−" : ""}${Math.abs(value)} pt deduction`;
    if (type.unit === "places") return `${Math.abs(value)}-place grid penalty`;
    if (type.unit === "seconds") return `${Math.abs(value)}s time penalty`;
    if (type.unit === "rounds") return `${Math.abs(value)}-round suspension`;
    return `${type.label} ${value}`;
  }

  function penaltiesOf(round) {
    return Array.isArray(round?.penalties) ? round.penalties.filter(Boolean) : [];
  }

  function blankTally() {
    return {
      name: "",
      username: "",
      team: "",
      points: 0,
      starts: 0,
      wins: 0,
      podiums: 0,
      poles: 0,
      fastest_laps: 0,
      best: null,
    };
  }

  // Standings for one division, mirroring bot.py::compute_standings including
  // disqualifications and points deductions, so the panel and the bot cannot
  // publish two different tables for the same rounds.
  function computeStandings(rounds) {
    const drivers = new Map();
    const teams = new Map();

    for (const round of rounds ?? []) {
      if (!round || typeof round !== "object") continue;

      const banned = new Set();
      const deductions = [];
      for (const penalty of penaltiesOf(round)) {
        const key = keyOf(penalty);
        if (!key) continue;
        if (penalty.type === "dsq") banned.add(key);
        else if (penalty.type === "points") deductions.push({ key, team: text(penalty.team), value: Math.abs(num(penalty.value, 0)) });
      }
      for (const entry of round.classification ?? []) {
        if (!entry || typeof entry !== "object") continue;
        const key = keyOf(entry);
        if (!key) continue;

        const tally = drivers.get(key) ?? blankTally();
        drivers.set(key, tally);
        tally.name = text(entry.name) || tally.name;
        tally.username = text(entry.username) || tally.username;
        tally.team = text(entry.short) || tally.team;
        tally.starts += 1;

        // A constructor is listed from the moment it entered the round, even if
        // its driver is disqualified and scores nothing.
        const teamName = text(entry.short) || text(entry.team);
        let team = null;
        if (teamName) {
          const teamKey = teamName.toLowerCase();
          team = teams.get(teamKey) ?? { name: teamName, points: 0, wins: 0, podiums: 0 };
          teams.set(teamKey, team);
        }

        if (banned.has(key)) continue; // a DSQ keeps the start, scores nothing

        tally.points += num(entry.points, 0);
        const position = Number.isInteger(entry.position) ? entry.position : null;
        if (position !== null) {
          if (position === 1) tally.wins += 1;
          if (position <= 3) tally.podiums += 1;
          tally.best = tally.best === null ? position : Math.min(tally.best, position);
        }

        if (team) {
          team.points += num(entry.points, 0);
          if (position !== null) {
            if (position === 1) team.wins += 1;
            if (position <= 3) team.podiums += 1;
          }
        }
      }

      for (const deduction of deductions) {
        const driver = drivers.get(deduction.key);
        if (driver) driver.points = Math.max(0, driver.points - deduction.value);
        const teamKey = deduction.team.toLowerCase();
        const team = teamKey ? teams.get(teamKey) : null;
        if (team) team.points = Math.max(0, team.points - deduction.value);
      }

      const poleKey = keyOf(round.pole);
      if (poleKey && drivers.has(poleKey)) drivers.get(poleKey).poles += 1;
      const lapKey = keyOf(round.fastest_lap);
      if (lapKey && drivers.has(lapKey)) drivers.get(lapKey).fastest_laps += 1;
    }

    function ordered(source) {
      const rows = [...source.values()].sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.wins !== a.wins) return b.wins - a.wins;
        if (b.podiums !== a.podiums) return b.podiums - a.podiums;
        const aBest = Number.isInteger(a.best) ? a.best : 99;
        const bBest = Number.isInteger(b.best) ? b.best : 99;
        if (aBest !== bBest) return aBest - bBest;
        const left = a.name.toLowerCase();
        const right = b.name.toLowerCase();
        return left < right ? -1 : left > right ? 1 : 0;
      });
      rows.forEach((row, index) => { row.position = index + 1; });
      return rows;
    }

    return { drivers: ordered(drivers), teams: ordered(teams) };
  }

  function ensureDivision(document, name) {
    const doc = document && typeof document === "object" ? document : {};
    if (!Array.isArray(doc.divisions)) doc.divisions = [];
    const exists = divisionEntry(doc, name);
    if (exists) {
      if (!Array.isArray(exists.rounds)) exists.rounds = [];
      if (!exists.standings || typeof exists.standings !== "object") {
        exists.standings = { drivers: [], teams: [] };
      }
      return exists;
    }

    const entry = {
      name: text(name).toUpperCase(),
      points: DEFAULT_POINTS.slice(),
      rounds: [],
      standings: { drivers: [], teams: [] },
    };
    doc.divisions.push(entry);
    doc.divisions.sort((a, b) => {
      const left = DIVISION_ORDER.indexOf(text(a.name).toUpperCase());
      const right = DIVISION_ORDER.indexOf(text(b.name).toUpperCase());
      const leftRank = left === -1 ? DIVISION_ORDER.length : left;
      const rightRank = right === -1 ? DIVISION_ORDER.length : right;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return text(a.name).toLowerCase() < text(b.name).toLowerCase() ? -1 : 1;
    });
    return entry;
  }

  function findRound(document, division, roundNumber) {
    const entry = divisionEntry(document, division);
    return (entry?.rounds ?? []).find((round) => num(round?.round, -1) === num(roundNumber, -2)) ?? null;
  }

  // Every division's standings, rebuilt from its rounds. Deduction and DSQ
  // decisions live on the round, so this is the one place they are applied.
  function refreshStandings(document) {
    for (const division of document?.divisions ?? []) {
      if (!division || typeof division !== "object") continue;
      if (!Array.isArray(division.rounds)) division.rounds = [];
      division.standings = computeStandings(division.rounds, division.points);
    }
    return document;
  }

  function roundSummary(round) {
    const decided = penaltiesOf(round).length;
    return {
      classified: (round?.classification ?? []).filter((entry) => entry && Number.isInteger(entry.position)).length,
      retired: (round?.classification ?? []).filter((entry) => entry && !Number.isInteger(entry.position)).length,
      decisions: decided,
    };
  }

  // Media ------------------------------------------------------------------ //

  function parseMedia(url) {
    const value = text(url);
    if (!value) return { kind: "link", embed: "", id: "", label: MEDIA_KINDS.link };
    let parsed = null;
    try {
      parsed = new URL(value);
    } catch (error) {
      return { kind: "link", embed: "", id: "", label: MEDIA_KINDS.link };
    }
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const path = parsed.pathname;

    if (host === "youtu.be") {
      const id = path.slice(1).split("/")[0];
      if (id) return { kind: "youtube", id, embed: `https://www.youtube-nocookie.com/embed/${id}`, label: MEDIA_KINDS.youtube };
    }
    if (host.endsWith("youtube.com")) {
      const fromQuery = parsed.searchParams.get("v");
      const shorts = path.match(/\/(?:shorts|embed|live)\/([\w-]{6,})/);
      const id = fromQuery || (shorts ? shorts[1] : "");
      if (id) return { kind: "youtube", id, embed: `https://www.youtube-nocookie.com/embed/${id}`, label: MEDIA_KINDS.youtube };
    }
    if (host.endsWith("twitch.tv")) {
      const clip = path.match(/\/clip\/([\w-]+)/)?.[1] ?? (host === "clips.twitch.tv" ? path.slice(1) : "");
      if (clip) return { kind: "twitch", id: clip, embed: "", label: MEDIA_KINDS.twitch };
    }
    if (host === "streamable.com") {
      const id = path.split("/").filter(Boolean)[0];
      if (id) return { kind: "streamable", id, embed: `https://streamable.com/e/${id}`, label: MEDIA_KINDS.streamable };
    }
    if (host.endsWith("medal.tv")) {
      return { kind: "medal", id: path, embed: "", label: MEDIA_KINDS.medal };
    }
    if (/\.(mp4|webm|ogv|ogg|mov|m4v)$/i.test(path)) {
      return { kind: "video", id: "", embed: value, label: MEDIA_KINDS.video };
    }
    return { kind: "link", id: "", embed: "", label: MEDIA_KINDS.link };
  }

  // Twitch needs the embedding page in the URL, so the host is passed at render
  // time rather than baked into the stored clip.
  function embedUrl(url, parentHost) {
    const media = parseMedia(url);
    if (media.kind === "twitch") {
      const parent = parentHost || "localhost";
      return `https://clips.twitch.tv/embed?clip=${encodeURIComponent(media.id)}&parent=${encodeURIComponent(parent)}`;
    }
    if (media.kind === "medal") {
      // Medal's clip pages are embeddable, but only through their own player URL.
      const direct = media.id.match(/\/clips\/([\w-]+)/) ?? media.id.match(/\/clip\/([\w-]+)/);
      if (direct) return `https://medal.tv/clip/${direct[1]}?invite=ams`;
    }
    return media.embed;
  }

  // Document ---------------------------------------------------------------- //

  function normalizeDocument(raw) {
    const doc = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    if (!Array.isArray(doc.divisions)) doc.divisions = [];
    if (doc.schema !== SCHEMA) doc.schema = SCHEMA;
    if (!Array.isArray(doc.media)) doc.media = [];
    if (!Array.isArray(doc.audit)) doc.audit = [];

    for (const division of doc.divisions) {
      if (!division || typeof division !== "object") continue;
      if (!Array.isArray(division.rounds)) division.rounds = [];
      if (!Array.isArray(division.points) || !division.points.length) {
        division.points = DEFAULT_POINTS.slice();
      }
      for (const round of division.rounds) {
        if (!round || typeof round !== "object") continue;
        if (!Array.isArray(round.classification)) round.classification = [];
        if (!Array.isArray(round.penalties)) round.penalties = [];
      }
    }
    return doc;
  }

  function emptyDocument(season) {
    return normalizeDocument({
      schema: SCHEMA,
      season: text(season) || "Season 1",
      updated_at: null,
      divisions: [],
      media: [],
      audit: [],
    });
  }

  function audit(document, { action, detail, by, at }) {
    const doc = document;
    if (!Array.isArray(doc.audit)) doc.audit = [];
    doc.audit.push({
      action: text(action),
      detail: text(detail),
      by: text(by) || "FIA",
      at: text(at) || new Date().toISOString(),
    });
    if (doc.audit.length > 200) doc.audit = doc.audit.slice(-200);
    return doc;
  }

  return {
    SCHEMA,
    DIVISION_ORDER,
    DEFAULT_POINTS,
    MAX_CLASSIFIED,
    PENALTY_TYPES,
    MEDIA_KINDS,
    num,
    keyOf,
    divisionEntry,
    pointsTable,
    pointsFor,
    penaltyType,
    penaltyLabel,
    penaltiesOf,
    computeStandings,
    ensureDivision,
    findRound,
    refreshStandings,
    roundSummary,
    parseMedia,
    embedUrl,
    normalizeDocument,
    emptyDocument,
    audit,
  };
});
