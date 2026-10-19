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
let panel = null;
let token = sessionStorage.getItem(TOKEN_KEY) || "";

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
          <h2>Content console</h2>
          <p class="hint">Publishing commits to <code>${esc(REPO)}</code>. Rosters come from Discord
          roles — editing them here would be overwritten on the next role change.</p>
        </div>
        <button class="admin-close" type="button" aria-label="Close">×</button>
      </div>
      <label for="ams-token">GitHub token (contents: write)</label>
      <input id="ams-token" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…">
      <div class="admin-row">
        <button class="btn" id="ams-verify" type="button">Verify</button>
        <button class="btn" id="ams-reload" type="button">Reload</button>
      </div>
      <label for="ams-json">Homepage content</label>
      <textarea id="ams-json" spellcheck="false"></textarea>
      <div class="admin-row">
        <button class="btn btn-primary" id="ams-publish" type="button" disabled>Publish</button>
        <button class="btn" id="ams-format" type="button">Format</button>
      </div>
      <p class="admin-status" id="ams-status"></p>
    </div>`;
  document.body.appendChild(panel);

  panel.querySelector(".admin-close").addEventListener("click", closePanel);
  panel.addEventListener("click", (event) => { if (event.target === panel) closePanel(); });
  $id("ams-token").value = token;
  $id("ams-token").addEventListener("input", (event) => { token = event.target.value.trim(); });
  $id("ams-verify").addEventListener("click", () => verifyToken(true));
  $id("ams-reload").addEventListener("click", async () => {
    setStatus("Reloading from the server…");
    const ok = await loadContent();
    fillEditor(ok ? content : {});
    setStatus(ok ? "Reloaded the published content." : "Could not reload — keeping what is on screen.", ok ? "ok" : "err");
  });
  $id("ams-format").addEventListener("click", formatEditor);
  $id("ams-publish").addEventListener("click", publish);
  return panel;
}

function setStatus(message, kind = "") {
  const node = $id("ams-status");
  if (!node) return;
  node.textContent = message;
  node.className = `admin-status${kind ? ` ${kind}` : ""}`;
}

function fillEditor(data) {
  const box = $id("ams-json");
  if (box) box.value = JSON.stringify(data ?? {}, null, 2);
}

function formatEditor() {
  const box = $id("ams-json");
  if (!box) return;
  try {
    box.value = JSON.stringify(JSON.parse(box.value), null, 2);
    setStatus("Formatted.", "ok");
  } catch (error) {
    setStatus(`Invalid JSON: ${error.message}`, "err");
  }
}

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
  if (!token) {
    if (announce) setStatus("Enter a token first.", "err");
    return false;
  }
  const { ok, status, body } = await gh("");
  const canPush = body?.permissions?.push === true;
  if (!ok) {
    if (announce) setStatus(`Token rejected (HTTP ${status}). Check it hasn't expired.`, "err");
    sessionStorage.removeItem(TOKEN_KEY);
    return false;
  }
  if (!canPush) {
    if (announce) setStatus(`Signed in as ${body?.login ?? "someone"}, but this token cannot write to the repo.`, "err");
    return false;
  }
  sessionStorage.setItem(TOKEN_KEY, token);
  const publish = $id("ams-publish");
  if (publish) publish.disabled = false;
  if (announce) setStatus(`Verified ${body.full_name} (${body.permissions.push ? "write" : "read"}).`, "ok");
  return true;
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function publish() {
  const box = $id("ams-json");
  if (!box) return;
  let parsed;
  try {
    parsed = JSON.parse(box.value);
  } catch (error) {
    setStatus(`Invalid JSON: ${error.message}`, "err");
    return;
  }
  if (parsed.schema !== 1) {
    setStatus('Refusing to publish: "schema" must be 1.', "err");
    return;
  }
  if (!(await verifyToken())) {
    setStatus("Not authorised — verify the token first.", "err");
    return;
  }

  setStatus("Publishing…");
  const current = await gh("/contents/data/content.json");
  // 404 is expected the first time: the file is created by this publish.
  if (!current.ok && current.status !== 404) {
    setStatus(`Could not read the current file (HTTP ${current.status}).`, "err");
    return;
  }

  const body = {
    message: `Update homepage content (${new Date().toISOString().slice(0, 16)}Z)`,
    content: toBase64(JSON.stringify(parsed, null, 2) + "\n"),
    branch: BRANCH,
  };
  if (current.ok && current.body?.sha) body.sha = current.body.sha;
  const put = await gh("/contents/data/content.json", { method: "PUT", body: JSON.stringify(body) });
  if (!put.ok) {
    setStatus(`Publish failed (HTTP ${put.status}). ${put.body?.message ?? ""}`, "err");
    return;
  }

  render(parsed);
  setStatus(`Published (${put.body?.commit?.sha?.slice(0, 7) ?? "commit ok"}). GitHub Pages can take up to 10 minutes to serve it everywhere.`, "ok");
}

async function openPanel() {
  buildPanel().hidden = false;
  document.addEventListener("keydown", onPanelKey);
  if (token) verifyToken(false);
  $id("ams-token")?.focus();

  // Opening straight onto #ams-admin races the initial fetch; wait for it rather
  // than showing an empty editor.
  if (!contentLoaded) {
    const box = $id("ams-json");
    if (box && !box.value.trim()) box.placeholder = "Loading the published content…";
    await (contentPromise ?? loadContent());
  }
  const box = $id("ams-json");
  if (box) box.placeholder = "";
  fillEditor(content ?? {});
}

function closePanel() {
  if (panel) panel.hidden = true;
  document.removeEventListener("keydown", onPanelKey);
  if (location.hash === ADMIN_HASH) history.replaceState(null, "", location.pathname + location.search);
}

function onPanelKey(event) {
  if (event.key === "Escape") closePanel();
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

loadContent();
if (location.hash === ADMIN_HASH) openPanel();
})();
