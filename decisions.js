// Public Stewards tab: the decisions and clips the FIA desk publishes.
// Reads the same data/results.json as the standings, so there is one file to
// publish and nothing to keep in sync by hand.
(() => {
  "use strict";

  const CORE = window.AMSResults;
  const list = document.getElementById("decisions-list");
  const clips = document.getElementById("clips-list");
  if (!CORE || !list || !clips) return;

  const RESULTS_URL = "data/results.json";
  const LOCALE = "en-GB";
  const state = { data: null, division: null };

  const $ = (id) => document.getElementById(id);

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function date(iso) {
    const value = new Date(iso);
    if (Number.isNaN(value.getTime())) return "";
    return value.toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "numeric" });
  }

  function divisions() {
    return (state.data?.divisions ?? []).filter((entry) => {
      if (!entry?.name) return false;
      return (entry.rounds ?? []).some((round) => CORE.penaltiesOf(round).length);
    });
  }

  function currentDivision() {
    const rows = divisions();
    return rows.find((entry) => entry.name === state.division) ?? rows[0] ?? null;
  }

  function allClips() {
    return [...(state.data?.media ?? [])].sort((a, b) => (
      String(b.added_at ?? "").localeCompare(String(a.added_at ?? ""))
    ));
  }

  function renderNav() {
    const nav = $("stewards-nav");
    const rows = divisions();
    nav.innerHTML = rows.map((entry) => (
      `<button type="button" data-division="${esc(entry.name)}" aria-pressed="${entry.name === currentDivision()?.name}">${esc(entry.name)}</button>`
    )).join("");

    nav.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        state.division = button.dataset.division;
        renderNav();
        render();
      });
    });
  }

  function decisionRow(round, penalty) {
    return `<li class="decision">
      <div class="decision-main">
        <b>${esc(penalty.name || "—")}</b>
        <span class="decision-tag">${esc(CORE.penaltyLabel(penalty))}</span>
        <p>${esc(penalty.reason || "No reason published.")}</p>
      </div>
      <p class="decision-meta">Round ${esc(round.round)}${round.circuit ? ` — ${esc(round.circuit)}` : ""}${penalty.issued_at ? ` · ${esc(date(penalty.issued_at))}` : ""}</p>
    </li>`;
  }

  function renderDecisions() {
    const division = currentDivision();
    if (!division) {
      list.innerHTML = "";
      $("stewards-status").textContent = "No steward decisions have been published yet.";
      return;
    }

    const rounds = [...(division.rounds ?? [])]
      .filter((round) => CORE.penaltiesOf(round).length)
      .sort((a, b) => CORE.num(b.round, 0) - CORE.num(a.round, 0));

    list.innerHTML = rounds.map((round) => {
      const heading = `Round ${esc(round.round)}${round.circuit ? ` — ${esc(round.circuit)}` : ""}`;
      return `<section class="decision-round">
        <h4>${heading}</h4>
        <ul>${CORE.penaltiesOf(round).map((penalty) => decisionRow(round, penalty)).join("")}</ul>
      </section>`;
    }).join("");
  }

  function clipCard(clip) {
    const media = CORE.parseMedia(clip.url);
    const embed = CORE.embedUrl(clip.url, location.hostname);
    let body = "";
    if (media.kind === "video") {
      body = `<video class="clip-video" controls preload="metadata" src="${esc(clip.url)}"></video>`;
    } else if (embed) {
      body = `<div class="clip-frame"><iframe src="${esc(embed)}" loading="lazy" title="${esc(clip.title)}"
        allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>`;
    } else {
      body = `<a class="action" href="${esc(clip.url)}" target="_blank" rel="noopener noreferrer">Watch the clip ↗</a>`;
    }

    const meta = [media.label, clip.division || "All divisions", clip.round ? `Round ${clip.round}` : "", date(clip.added_at)]
      .filter(Boolean).join(" · ");

    return `<article class="clip">
      ${body}
      <h4>${esc(clip.title)}</h4>
      <p class="clip-meta">${esc(meta)}</p>
      ${clip.note ? `<p class="clip-note">${esc(clip.note)}</p>` : ""}
    </article>`;
  }

  function renderClips() {
    const division = currentDivision();
    const name = division?.name ?? null;
    const rows = allClips().filter((clip) => !clip.division || clip.division === name);

    clips.innerHTML = rows.length
      ? rows.map(clipCard).join("")
      : `<p class="empty-line">No clips published${name ? ` for ${esc(name)}` : ""} yet.</p>`;
  }

  function render() {
    const division = currentDivision();
    renderDecisions();
    renderClips();

    const total = divisions().reduce((sum, entry) => (
      sum + (entry.rounds ?? []).reduce((count, round) => count + CORE.penaltiesOf(round).length, 0)
    ), 0);
    const clipCount = allClips().length;
    $("stewards-status").textContent = total
      ? `${total} decision${total === 1 ? "" : "s"} on file · ${clipCount} clip${clipCount === 1 ? "" : "s"} published`
      : `No steward decisions yet${clipCount ? ` — ${clipCount} clip${clipCount === 1 ? "" : "s"} published` : ""}.`;
    $("stewards-updated").textContent = state.data?.updated_at
      ? `${state.data.season ?? "Season"} · updated ${date(state.data.updated_at)}`
      : "";
    void division;
  }

  async function refresh() {
    try {
      const response = await fetch(`${RESULTS_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (response.status === 404) {
        state.data = { divisions: [], media: [] };
        renderNav();
        render();
        renderClips();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.data = CORE.normalizeDocument(await response.json());
      if (state.division && !divisions().some((entry) => entry.name === state.division)) {
        state.division = null;
      }
      renderNav();
      render();
      if (!allClips().length && !divisions().length) {
        $("stewards-status").textContent = "No decisions or clips have been published yet.";
      }
    } catch (error) {
      console.warn("Stewards refresh failed:", error);
      $("stewards-status").textContent = "Decisions are not available right now.";
    }
  }

  refresh();
})();
