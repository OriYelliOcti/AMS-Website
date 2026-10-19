(() => {
"use strict";

// Homepage rendering + the concealed content console.
//
// The admin console is deliberately not linked from anywhere: it opens only via
// Ctrl+Shift+A or the #ams-admin hash. That is concealment, not security — what
// actually protects publishing is the GitHub token you paste in, which is verified
// against GitHub and lives in sessionStorage only (never in this file, never on disk).

const CONTENT_URL = "data/content.json";
const REPO = "OriYelliOcti/AMS-Website";
const BRANCH = "main";
const TOKEN_KEY = "ams.console.token";

const $id = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

let content = null;
let contentPromise = null;
let contentLoaded = false;

/* ------------------------------------------------------------------ render */

function renderHero(hero) {
  if (!hero) return;
  const eyebrow = $id("hero-eyebrow");
  const headline = $id("hero-headline");
  const sub = $id("hero-sub");
  if (eyebrow) eyebrow.textContent = hero.eyebrow ?? "";
  if (headline) headline.textContent = hero.headline ?? "";
  if (sub) sub.textContent = hero.subhead ?? "";
  for (const [buttonId, cta] of [["hero-primary", hero.primary], ["hero-secondary", hero.secondary]]) {
    const button = $id(buttonId);
    if (!button || !cta) continue;
    button.textContent = cta.label ?? button.textContent;
    if (cta.href) button.setAttribute("href", cta.href);
  }
}

function renderAbout(about) {
  if (!about) return;
  const title = $id("about-title");
  if (title) title.textContent = about.title ?? title.textContent;
  const body = $id("about-body");
  if (body) body.innerHTML = (about.paragraphs ?? []).map((p) => `<p>${esc(p)}</p>`).join("");
  const stats = $id("hero-stats");
  if (stats) {
    stats.innerHTML = (about.stats ?? []).map((s) => (
      `<div class="board-row"><span>${esc(s.label)}</span><b>${esc(s.value)}</b></div>`
    )).join("");
  }
}

function renderFeatures(features) {
  if (!features) return;
  const title = $id("features-title");
  const intro = $id("features-intro");
  const list = $id("features-list");
  if (title) title.textContent = features.title ?? title.textContent;
  if (intro) intro.textContent = features.intro ?? "";
  if (list) {
    list.innerHTML = (features.items ?? []).map((item, i) => `
      <li>
        <span class="n">${String(i + 1).padStart(2, "0")}</span>
        <h3>${esc(item.title)}</h3>
        <p>${esc(item.text)}</p>
      </li>`).join("");
  }
}

function renderGrid(divisions) {
  if (!divisions) return;
  const title = $id("grid-title");
  const intro = $id("grid-intro");
  const note = $id("grid-note");
  const rows = $id("grid-rows");
  if (title) title.textContent = divisions.title ?? title.textContent;
  if (intro) intro.textContent = divisions.intro ?? "";
  if (note) note.textContent = divisions.note ?? "";
  if (rows) {
    rows.innerHTML = (divisions.items ?? []).map((d) => `
      <tr>
        <td><b>${esc(d.name)}</b></td>
        <td class="num right">${d.teams ? esc(d.teams) : "—"}</td>
        <td class="num right">${d.slots ? esc(d.slots) : "—"}</td>
        <td>${esc(d.note ?? "")}</td>
      </tr>`).join("");
  }
}

function renderCalendar(calendar) {
  if (!calendar) return;
  const title = $id("calendar-title");
  const intro = $id("calendar-intro");
  const rows = $id("calendar-rows");
  if (title) title.textContent = calendar.title ?? title.textContent;
  if (intro) intro.textContent = calendar.intro ?? "";
  if (rows) {
    rows.innerHTML = (calendar.rounds ?? []).map((r) => `
      <tr>
        <td class="num right">${esc(r.round)}</td>
        <td><b>${esc(r.circuit)}</b></td>
        <td class="code">${esc(r.country ?? "")}</td>
        <td class="num right">${esc(r.laps)}</td>
        <td class="num right">${esc(r.window)}</td>
      </tr>`).join("");
  }
}

function renderRules(rules) {
  if (!rules) return;
  const title = $id("rules-title");
  const intro = $id("rules-intro");
  const list = $id("rules-list");
  if (title) title.textContent = rules.title ?? title.textContent;
  if (intro) intro.textContent = rules.intro ?? "";
  if (list) list.innerHTML = (rules.items ?? []).map((r) => `<li>${esc(r)}</li>`).join("");
}

function renderJoin(join) {
  if (!join) return;
  const title = $id("join-title");
  const steps = $id("join-steps");
  const invite = $id("join-invite");
  if (title) title.textContent = join.title ?? title.textContent;
  if (steps) {
    steps.innerHTML = (join.steps ?? []).map((s) => (
      `<li><b>${esc(s.title)}</b><span>${esc(s.text)}</span></li>`
    )).join("");
  }
  if (invite) {
    invite.innerHTML = join.invite
      ? `<a class="btn btn-primary" href="${esc(join.invite)}" rel="noopener">Join the Discord</a>`
      : esc(join.inviteNote ?? "");
  }
}

function renderFaq(faq) {
  if (!faq) return;
  const title = $id("faq-title");
  const list = $id("faq-list");
  if (title) title.textContent = faq.title ?? title.textContent;
  if (list) {
    list.innerHTML = (faq.items ?? []).map((item) => `
      <details>
        <summary>${esc(item.q)}</summary>
        <p>${esc(item.a)}</p>
      </details>`).join("");
  }
}

function renderFooter(footer) {
  const text = $id("site-footer-text");
  if (text && footer?.text) text.textContent = footer.text;
}

function render(data) {
  content = data;
  renderHero(data.hero);
  renderAbout(data.about);
  renderFeatures(data.features);
  renderGrid(data.divisions);
  renderCalendar(data.calendar);
  renderRules(data.rules);
  renderJoin(data.join);
  renderFaq(data.faq);
  renderFooter(data.footer);
}

function loadContent() {
  contentPromise = (async () => {
    try {
      const response = await fetch(`${CONTENT_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      render(await response.json());
      contentLoaded = true;
    } catch (error) {
      console.warn("Homepage content could not be loaded:", error);
      const note = $id("about-body");
      if (note) {
        note.innerHTML = '<p>The homepage copy could not be loaded. The live lineups below are unaffected.</p>';
      }
      contentLoaded = false;
    }
    return contentLoaded;
  })();
  return contentPromise;
}

/* ------------------------------------------------------------- admin console */

const ADMIN_HASH = "#ams-admin";
const DRAFT_KEY = "ams.console.draft";

let panel = null;
let token = readStoredToken();
let verifiedAs = "";
let draft = null;        // what the form is editing
let published = null;    // the last copy we know is on GitHub
let view = "hero";
let publishing = false;
let draftTimer = 0;
const openItems = new Set(); // list entries the editor has expanded, keyed by path.index

function readStoredToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || "";
  } catch (error) {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value ?? {}));

function getPath(object, path) {
  return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), object);
}

function setPath(object, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  let node = object;
  for (const key of keys) {
    if (node[key] == null || typeof node[key] !== "object") node[key] = /^\d+$/.test(key) ? [] : {};
    node = node[key];
  }
  node[last] = value;
}

// Every editable part of content.json, in the order the page presents it.
// `path` is dot-separated; list paths address arrays, item fields are appended.
const SECTIONS = [
  {
    id: "hero",
    label: "Header",
    blurb: "The first screen: eyebrow, headline, deck and the two buttons.",
    fields: [
      { path: "hero.eyebrow", label: "Eyebrow" },
      { path: "hero.headline", label: "Headline" },
      { path: "hero.subhead", label: "Deck", type: "area", rows: 3 },
      { path: "hero.primary.label", label: "Primary button label" },
      { path: "hero.primary.href", label: "Primary button link", hint: "An in-page anchor such as #roster, or a full URL." },
      { path: "hero.secondary.label", label: "Secondary button label" },
      { path: "hero.secondary.href", label: "Secondary button link" },
    ],
  },
  {
    id: "about",
    label: "About",
    blurb: "The identity section and the four figures in the “At a glance” board.",
    fields: [{ path: "about.title", label: "Heading" }],
    lists: [
      {
        path: "about.paragraphs",
        label: "Paragraphs",
        add: "Add paragraph",
        fallback: "Paragraph",
        empty: () => "",
        emptyText: "No paragraphs yet.",
        fields: [{ key: "", label: "Text", type: "area", rows: 4 }],
      },
      {
        path: "about.stats",
        label: "At a glance",
        add: "Add figure",
        titleKey: "label",
        empty: () => ({ value: "", label: "" }),
        emptyText: "No figures yet.",
        fields: [
          { key: "label", label: "Caption" },
          { key: "value", label: "Number" },
        ],
      },
    ],
  },
  {
    id: "features",
    label: "Features",
    blurb: "The numbered index under “What we have”.",
    fields: [
      { path: "features.title", label: "Heading" },
      { path: "features.intro", label: "Intro", type: "area", rows: 2 },
    ],
    lists: [
      {
        path: "features.items",
        label: "Entries",
        add: "Add entry",
        titleKey: "title",
        empty: () => ({ title: "", text: "" }),
        emptyText: "No entries yet.",
        fields: [
          { key: "title", label: "Title" },
          { key: "text", label: "Description", type: "area", rows: 2 },
        ],
      },
    ],
  },
  {
    id: "divisions",
    label: "Grid",
    blurb: "The division table: teams, slots used and a note per division.",
    fields: [
      { path: "divisions.title", label: "Heading" },
      { path: "divisions.intro", label: "Intro", type: "area", rows: 2 },
    ],
    lists: [
      {
        path: "divisions.items",
        label: "Divisions",
        add: "Add division",
        titleKey: "name",
        empty: () => ({ name: "", teams: 0, slots: 0, note: "" }),
        emptyText: "No divisions yet.",
        fields: [
          { key: "name", label: "Division" },
          { key: "teams", label: "Teams", type: "number" },
          { key: "slots", label: "Slots used", type: "number" },
          { key: "note", label: "Note" },
        ],
      },
    ],
    after: [{ path: "divisions.note", label: "Footnote", type: "area", rows: 2 }],
  },
  {
    id: "calendar",
    label: "Calendar",
    blurb: "One row per round. Laps and pit windows are printed as typed.",
    fields: [
      { path: "calendar.title", label: "Heading" },
      { path: "calendar.intro", label: "Intro", type: "area", rows: 2 },
    ],
    lists: [
      {
        path: "calendar.rounds",
        label: "Rounds",
        add: "Add round",
        titleKey: "circuit",
        empty: () => ({ round: 1, circuit: "", country: "", laps: 0, window: "" }),
        emptyText: "No rounds yet.",
        fields: [
          { key: "round", label: "Round", type: "number" },
          { key: "circuit", label: "Circuit" },
          { key: "country", label: "Country code", hint: "Three letters, e.g. ITA." },
          { key: "laps", label: "Laps", type: "number" },
          { key: "window", label: "Pit window", hint: "Printed verbatim, e.g. 8–14." },
        ],
      },
    ],
  },
  {
    id: "rules",
    label: "Rules",
    blurb: "The numbered list under “The rules, in short”.",
    fields: [
      { path: "rules.title", label: "Heading" },
      { path: "rules.intro", label: "Intro", type: "area", rows: 2 },
    ],
    lists: [
      {
        path: "rules.items",
        label: "Rules",
        add: "Add rule",
        fallback: "Rule",
        empty: () => "",
        emptyText: "No rules yet.",
        fields: [{ key: "", label: "Rule", type: "area", rows: 2 }],
      },
    ],
  },
  {
    id: "join",
    label: "Join",
    blurb: "The four entry steps and the invite line under them.",
    fields: [{ path: "join.title", label: "Heading" }],
    lists: [
      {
        path: "join.steps",
        label: "Steps",
        add: "Add step",
        titleKey: "title",
        empty: () => ({ title: "", text: "" }),
        emptyText: "No steps yet.",
        fields: [
          { key: "title", label: "Title" },
          { key: "text", label: "Description", type: "area", rows: 3 },
        ],
      },
    ],
    after: [
      { path: "join.invite", label: "Discord invite link", hint: "Leave empty to show the note below instead." },
      { path: "join.inviteNote", label: "Invite note", type: "area", rows: 2 },
    ],
  },
  {
    id: "faq",
    label: "FAQ",
    blurb: "Questions and answers, in the order they appear.",
    fields: [{ path: "faq.title", label: "Heading" }],
    lists: [
      {
        path: "faq.items",
        label: "Questions",
        add: "Add question",
        titleKey: "q",
        empty: () => ({ q: "", a: "" }),
        emptyText: "No questions yet.",
        fields: [
          { key: "q", label: "Question" },
          { key: "a", label: "Answer", type: "area", rows: 3 },
        ],
      },
    ],
  },
  {
    id: "footer",
    label: "Footer",
    blurb: "The line under the lineups. Keep it short.",
    fields: [{ path: "footer.text", label: "Footer text", type: "area", rows: 3 }],
  },
  {
    id: "json",
    label: "JSON",
    blurb: "Escape hatch for bulk edits. Applying replaces everything in this console.",
  },
];

const LISTS = SECTIONS.flatMap((section) => section.lists ?? []);

function sectionById(id) {
  return SECTIONS.find((section) => section.id === id) ?? SECTIONS[0];
}

function listSpec(path) {
  return LISTS.find((list) => list.path === path) ?? null;
}

function fieldHtml(path, field) {
  const id = `ams-f-${path.replace(/[^\w]+/g, "-")}`;
  const value = getPath(draft, path);
  const hint = field.hint ? `<p class="admin-hint">${esc(field.hint)}</p>` : "";
  const label = `<label for="${id}">${esc(field.label)}</label>`;
  if (field.type === "area") {
    return `<div class="admin-field">${label}
      <textarea id="${id}" data-path="${esc(path)}" rows="${field.rows ?? 3}" spellcheck="false">${esc(value ?? "")}</textarea>${hint}
    </div>`;
  }
  const type = field.type === "number" ? "number" : "text";
  return `<div class="admin-field">${label}
    <input id="${id}" data-path="${esc(path)}" type="${type}" value="${esc(value ?? "")}">${hint}
  </div>`;
}

function itemLabel(list, item, index) {
  const raw = list.titleKey && item && typeof item === "object" ? item[list.titleKey] : "";
  const title = String(raw ?? "").trim();
  return title || `${list.fallback ?? "Item"} ${index + 1}`;
}

function listHtml(list) {
  const items = getPath(draft, list.path);
  const rows = Array.isArray(items) && items.length
    ? items.map((item, index) => {
        const base = `${list.path}.${index}`;
        const fields = list.fields
          .map((field) => fieldHtml(field.key ? `${base}.${field.key}` : base, field))
          .join("");
        return `<details class="admin-item" data-key="${esc(base)}"${openItems.has(base) ? " open" : ""}>
          <summary class="admin-item-head">
            <span class="admin-item-n">${String(index + 1).padStart(2, "0")}</span>
            <span class="admin-item-title">${esc(itemLabel(list, item, index))}</span>
            <span class="admin-item-tools">
              <button class="admin-mini" type="button" data-move="${esc(list.path)}" data-from="${index}" data-to="${index - 1}" ${index === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
              <button class="admin-mini" type="button" data-move="${esc(list.path)}" data-from="${index}" data-to="${index + 1}" ${index === items.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
              <button class="admin-mini admin-danger" type="button" data-remove="${esc(list.path)}" data-index="${index}">Remove</button>
            </span>
          </summary>
          <div class="admin-item-body">${fields}</div>
        </details>`;
      }).join("")
    : `<p class="admin-empty">${esc(list.emptyText ?? "None yet.")}</p>`;

  return `<section class="admin-list">
    <div class="admin-list-head">
      <h3>${esc(list.label)}</h3>
      <button class="admin-mini" type="button" data-add="${esc(list.path)}">${esc(list.add ?? "Add")}</button>
    </div>
    ${rows}
  </section>`;
}

function viewHtml() {
  const section = sectionById(view);
  if (section.id === "json") {
    return `<div class="admin-view-head">
        <h3>JSON</h3>
        <p>Everything in the form, as one object. Apply replaces the form with what you typed.</p>
      </div>
      <textarea class="admin-json" id="ams-json" spellcheck="false" rows="22"></textarea>
      <div class="admin-row">
        <button class="btn" id="ams-apply-json" type="button">Apply JSON</button>
        <button class="btn" id="ams-copy-json" type="button">Copy</button>
      </div>
      <p class="admin-status" id="ams-json-status" role="status"></p>`;
  }
  return `<div class="admin-view-head">
      <h3>${esc(section.label)}</h3>
      <p>${esc(section.blurb)}</p>
    </div>
    ${(section.fields ?? []).map((field) => fieldHtml(field.path, field)).join("")}
    ${(section.lists ?? []).map(listHtml).join("")}
    ${(section.after ?? []).map((field) => fieldHtml(field.path, field)).join("")}`;
}

function renderView() {
  const host = $id("ams-view");
  if (!host) return;
  host.innerHTML = viewHtml();
  if (view === "json") {
    const box = $id("ams-json");
    if (box) box.value = JSON.stringify(draft, null, 2);
  }
  host.scrollTop = 0;
}

function renderPanel() {
  const nav = panel?.querySelector(".admin-nav");
  if (nav) {
    nav.innerHTML = SECTIONS.map((section) => (
      `<button type="button" data-view="${section.id}" aria-current="${section.id === view}">${esc(section.label)}</button>`
    )).join("");
  }
  renderView();
  refreshBar();
}

/* ---------- state ---------- */

function isDirty() {
  return Boolean(draft && published) && JSON.stringify(draft) !== JSON.stringify(published);
}

function refreshBar() {
  const publishButton = $id("ams-publish");
  // Never allow a publish built on a failed fetch: that would commit an empty page.
  if (publishButton) publishButton.disabled = publishing || !verifiedAs || !isDirty() || !contentLoaded;
  const dirtyFlag = $id("ams-dirty");
  if (dirtyFlag) dirtyFlag.hidden = !isDirty();
  const forget = $id("ams-forget");
  if (forget) forget.disabled = !token;
}

function setAuth(message, kind = "") {
  const node = $id("ams-auth");
  if (!node) return;
  node.textContent = message;
  node.className = `admin-auth-state${kind ? ` ${kind}` : ""}`;
}

function setStatus(message, kind = "") {
  const node = $id("ams-status");
  if (!node) return;
  node.textContent = message;
  node.className = `admin-status${kind ? ` ${kind}` : ""}`;
}

function setJsonStatus(message, kind = "") {
  const node = $id("ams-json-status");
  if (!node) return;
  node.textContent = message;
  node.className = `admin-status${kind ? ` ${kind}` : ""}`;
}

function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      if (isDirty()) localStorage.setItem(DRAFT_KEY, JSON.stringify({ at: Date.now(), data: draft }));
      else localStorage.removeItem(DRAFT_KEY);
    } catch (error) { /* private mode: drafts are a convenience, not a promise */ }
  }, 500);
}

function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw);
    return stored?.data && typeof stored.data === "object" ? stored : null;
  } catch (error) {
    return null;
  }
}

function whenLabel(timestamp) {
  const then = new Date(timestamp);
  if (Number.isNaN(then.getTime())) return "earlier";
  return then.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/* ---------- panel shell ---------- */

function buildPanel() {
  if (panel) return panel;
  panel = document.createElement("div");
  panel.className = "admin";
  panel.id = "ams-console";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Content console");
  panel.innerHTML = `
    <div class="admin-panel">
      <div class="admin-head">
        <div>
          <h2>Content</h2>
          <p class="hint">Edits commit to <code>${esc(REPO)}</code> when you publish. Rosters come from Discord
          roles and are not edited here.</p>
        </div>
        <button class="admin-close" type="button" aria-label="Close">×</button>
      </div>

      <div class="admin-auth">
        <label for="ams-token">GitHub token</label>
        <input id="ams-token" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…">
        <label class="admin-remember"><input type="checkbox" id="ams-remember"> Remember on this device</label>
        <button class="admin-mini" id="ams-forget" type="button">Forget</button>
        <span class="admin-auth-state" id="ams-auth">Not signed in</span>
        <p class="admin-token-help">A fine-grained token with <em>Contents: read and write</em> on
          <code>${esc(REPO)}</code>. <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener">Create one</a> —
          it stays in this browser, and only if you tick Remember.</p>
      </div>

      <div class="admin-body">
        <nav class="admin-nav" aria-label="Sections"></nav>
        <div class="admin-view" id="ams-view"></div>
      </div>

      <div class="admin-bar">
        <p class="admin-status" id="ams-status" role="status" aria-live="polite"></p>
        <div class="admin-actions">
          <span class="admin-dirty" id="ams-dirty" hidden>Unsaved changes</span>
          <button class="btn" id="ams-discard" type="button">Discard</button>
          <button class="btn btn-primary" id="ams-publish" type="button" disabled>Publish changes</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(panel);

  const tokenInput = $id("ams-token");
  tokenInput.value = token;
  tokenInput.addEventListener("input", () => {
    token = tokenInput.value.trim();
    verifiedAs = "";
    setAuth(token ? "Not checked yet — tab out to verify" : "Not signed in");
    refreshBar();
  });
  tokenInput.addEventListener("change", () => {
    if (token) verifyToken(false);
  });

  $id("ams-remember").checked = hasRememberedToken();
  $id("ams-remember").addEventListener("change", (event) => {
    try {
      if (event.target.checked && verifiedAs) localStorage.setItem(TOKEN_KEY, token);
      if (!event.target.checked) localStorage.removeItem(TOKEN_KEY);
    } catch (error) { /* ignore */ }
  });

  panel.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) {
      if (event.target === panel) closePanel();
      return;
    }

    // Buttons often sit inside a <summary>; keep them from also toggling the entry.
  event.preventDefault();
  if (target.classList.contains("admin-close")) return closePanel();

    if (target.dataset.view) {
      view = target.dataset.view;
      renderPanel();
      return;
    }
    if (target.dataset.add) {
      addItem(target.dataset.add);
      return;
    }
    if (target.dataset.remove) {
      removeItem(target.dataset.remove, Number(target.dataset.index));
      return;
    }
    if (target.dataset.move) {
      moveItem(target.dataset.move, Number(target.dataset.from), Number(target.dataset.to));
      return;
    }

    switch (target.id) {
      case "ams-forget":
        forgetToken();
        break;
      case "ams-discard":
        discardDraft();
        break;
      case "ams-publish":
        publishChanges();
        break;
      case "ams-apply-json":
        applyJson();
        break;
      case "ams-copy-json":
        copyJson();
        break;
      default:
        break;
    }
  });

  panel.addEventListener("toggle", (event) => {
    const details = event.target;
    if (!details?.classList?.contains("admin-item")) return;
    if (details.open) openItems.add(details.dataset.key);
    else openItems.delete(details.dataset.key);
  }, true);

  panel.addEventListener("input", (event) => {
    const element = event.target;
    if (!element.dataset?.path) return;
    const value = element.type === "number" ? Number(element.value || 0) : element.value;
    setPath(draft, element.dataset.path, value);
    refreshBar();
    scheduleDraftSave();
  });

  return panel;
}

function hasRememberedToken() {
  try {
    return Boolean(localStorage.getItem(TOKEN_KEY));
  } catch (error) {
    return false;
  }
}

/* ---------- list editing ---------- */

function addItem(path) {
  const spec = listSpec(path);
  if (!spec) return;
  let list = getPath(draft, path);
  if (!Array.isArray(list)) {
    list = [];
    setPath(draft, path, list);
  }
  list.push(spec.empty());
  const key = `${path}.${list.length - 1}`;
  openItems.add(key);
  renderPanel();
  refreshBar();
  scheduleDraftSave();
  $id("ams-view")?.querySelector(`details[data-key="${key}"] [data-path]`)?.focus();
}

function removeItem(path, index) {
  const list = getPath(draft, path);
  if (!Array.isArray(list) || index < 0 || index >= list.length) return;
  openItems.delete(`${path}.${index}`);
  list.splice(index, 1);
  renderPanel();
  refreshBar();
  scheduleDraftSave();
}

function moveItem(path, from, to) {
  const list = getPath(draft, path);
  if (!Array.isArray(list) || to < 0 || to >= list.length || from === to) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  renderPanel();
  refreshBar();
  scheduleDraftSave();
}

/* ---------- GitHub ---------- */

async function gh(path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

async function verifyToken(announce = false) {
  verifiedAs = "";
  if (!token) {
    setAuth("Not signed in");
    refreshBar();
    if (announce) setStatus("Paste a token first.", "err");
    return false;
  }
  setAuth("Checking…");
  const { ok, status, body } = await gh("");
  if (!ok) {
    setAuth(`Rejected (HTTP ${status})`, "err");
    sessionStorage.removeItem(TOKEN_KEY);
    try { if (localStorage.getItem(TOKEN_KEY) === token) localStorage.removeItem(TOKEN_KEY); } catch (error) { /* ignore */ }
    refreshBar();
    if (announce) setStatus(`Token rejected (HTTP ${status}). Check it hasn't expired.`, "err");
    return false;
  }
  if (body?.permissions?.push !== true) {
    setAuth(`Read-only as ${body?.login ?? "someone"}`, "err");
    refreshBar();
    if (announce) setStatus(`Signed in as ${body?.login ?? "someone"}, but this token cannot write to the repo.`, "err");
    return false;
  }

  verifiedAs = body.login ?? "token";
  sessionStorage.setItem(TOKEN_KEY, token);
  if ($id("ams-remember")?.checked) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch (error) { /* ignore */ }
  }
  setAuth(`Signed in as ${verifiedAs}`, "ok");
  refreshBar();
  if (announce) setStatus(`Verified ${body.full_name ?? REPO}. Publish becomes available once something changes.`, "ok");
  return true;
}

function forgetToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  } catch (error) { /* ignore */ }
  token = "";
  verifiedAs = "";
  const input = $id("ams-token");
  if (input) input.value = "";
  const remember = $id("ams-remember");
  if (remember) remember.checked = false;
  setAuth("Not signed in");
  refreshBar();
  setStatus("Token forgotten. It is no longer stored in this browser.", "");
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function publishChanges() {
  if (publishing || !draft) return;
  if (draft.schema !== 1) {
    setStatus('Refusing to publish: "schema" must be 1.', "err");
    return;
  }
  if (!isDirty()) {
    setStatus("Nothing to publish — the form matches the published copy.", "");
    return;
  }
  if (!(await verifyToken(false))) {
    setStatus("Paste a working GitHub token before publishing.", "err");
    return;
  }

  publishing = true;
  refreshBar();
  setStatus("Publishing…");

  const current = await gh("/contents/data/content.json");
  // 404 is expected the first time: the file is created by this publish.
  if (!current.ok && current.status !== 404) {
    publishing = false;
    refreshBar();
    setStatus(`Could not read the current file (HTTP ${current.status}).`, "err");
    return;
  }

  const body = {
    message: `Update homepage content (${new Date().toISOString().slice(0, 16)}Z)`,
    content: toBase64(JSON.stringify(draft, null, 2) + "\n"),
    branch: BRANCH,
  };
  if (current.ok && current.body?.sha) body.sha = current.body.sha;

  const put = await gh("/contents/data/content.json", { method: "PUT", body: JSON.stringify(body) });
  publishing = false;

  if (!put.ok) {
    refreshBar();
    setStatus(`Publish failed (HTTP ${put.status}). ${put.body?.message ?? ""}`, "err");
    return;
  }

  published = clone(draft);
  render(clone(draft));
  try { localStorage.removeItem(DRAFT_KEY); } catch (error) { /* ignore */ }
  refreshBar();
  setStatus(`Published ${put.body?.commit?.sha?.slice(0, 7) ?? "commit ok"}. GitHub Pages can take a few minutes to show it.`, "ok");
}

/* ---------- JSON escape hatch ---------- */

function applyJson() {
  const box = $id("ams-json");
  if (!box) return;
  let parsed;
  try {
    parsed = JSON.parse(box.value);
  } catch (error) {
    setJsonStatus(`Invalid JSON: ${error.message}`, "err");
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    setJsonStatus("The content must be a JSON object.", "err");
    return;
  }
  draft = parsed;
  renderPanel();
  scheduleDraftSave();
  setStatus("JSON applied. Review the sections before publishing.", "ok");
}

async function copyJson() {
  const text = JSON.stringify(draft, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    setJsonStatus("Copied.", "ok");
  } catch (error) {
    setJsonStatus("Could not copy — select the text and copy it manually.", "err");
  }
}

/* ---------- open / close ---------- */

async function openPanel() {
  buildPanel().hidden = false;
  document.addEventListener("keydown", onPanelKey);

  // Opening straight onto #ams-admin races the initial fetch; wait for it rather
  // than showing an empty form.
  if (!contentLoaded) await (contentPromise ?? loadContent());

  published = clone(content ?? {});
  const stored = readDraft();

  if (stored && JSON.stringify(stored.data) !== JSON.stringify(published)) {
    draft = stored.data;
    setStatus(`Restored unsaved changes from ${whenLabel(stored.at)}. Publish or Discard them.`, "");
  } else {
    draft = clone(published);
    try { localStorage.removeItem(DRAFT_KEY); } catch (error) { /* ignore */ }
    setStatus("");
  }

  view = "hero";
  renderPanel();
  if (!contentLoaded) {
    setStatus("Could not load the published content. Publishing stays disabled until it loads — use Discard to retry.", "err");
  }

  if (token) {
    await verifyToken(false);
    if (!verifiedAs) setAuth(token ? "Rejected — replace the token" : "Not signed in", "err");
  } else {
    setAuth("Not signed in");
  }
  refreshBar();

  const first = token && verifiedAs ? $id("ams-view")?.querySelector("input, textarea") : $id("ams-token");
  first?.focus({ preventScroll: true });
}

function closePanel() {
  if (panel) panel.hidden = true;
  document.removeEventListener("keydown", onPanelKey);
  if (location.hash === ADMIN_HASH) history.replaceState(null, "", location.pathname + location.search);
}

function onPanelKey(event) {
  if (event.key === "Escape") closePanel();
}

async function discardDraft() {
  setStatus("Reloading the published content…");
  const ok = await loadContent();
  published = clone(content ?? {});
  draft = clone(published);
  try { localStorage.removeItem(DRAFT_KEY); } catch (error) { /* ignore */ }
  renderPanel();
  setStatus(ok ? "Back to the published content." : "Could not reload — showing the last copy we had.", ok ? "" : "err");
}
// The only two ways in. Neither is discoverable from the page itself.
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "a") {
    event.preventDefault();
    if (panel?.hidden === false) closePanel(); else openPanel();
  }
});

window.addEventListener("hashchange", () => {
  if (location.hash === ADMIN_HASH) openPanel();
});

/* ------------------------------------------------------------------- theme */

const THEME_KEY = "ams.theme";

function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function applyTheme(theme, persist) {
  document.documentElement.dataset.theme = theme;
  if (persist) {
    try { localStorage.setItem(THEME_KEY, theme); } catch (error) { /* private mode */ }
  }
  const label = $id("theme-label");
  if (label) label.textContent = theme === "dark" ? "Dark" : "Light";
  const button = $id("theme-toggle");
  if (button) {
    button.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    button.setAttribute("aria-pressed", String(theme === "dark"));
  }
}

function initTheme() {
  applyTheme(currentTheme(), false);
  $id("theme-toggle")?.addEventListener("click", () => {
    applyTheme(currentTheme() === "dark" ? "light" : "dark", true);
  });

  // Follow the system only while the visitor has not chosen a theme themselves.
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", (event) => {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (error) { /* ignore */ }
    if (!saved) applyTheme(event.matches ? "dark" : "light", false);
  });
}

loadContent();
initTheme();
if (location.hash === ADMIN_HASH) openPanel();
})();
