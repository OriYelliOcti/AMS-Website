// Race centre tabs: Lineups | Results | Fantasy.
// The hash is the source of truth so #results and #fantasy can be linked to,
// and #roster keeps every existing "see the grid" link working.

(() => {
  "use strict";

  const BLOCK_ID = "roster";
  const HASH_FOR = { lineups: "#roster", results: "#results", fantasy: "#fantasy" };
  const TAB_FOR_HASH = { roster: "lineups", lineups: "lineups", results: "results", fantasy: "fantasy" };

  const tabs = Array.from(document.querySelectorAll('[role="tab"][data-tab]'));
  if (!tabs.length) return;

  function panelFor(tab) {
    return document.getElementById(tab.getAttribute("aria-controls"));
  }

  function select(name, { focus = false, scroll = false } = {}) {
    const chosen = tabs.find((tab) => tab.dataset.tab === name) ?? tabs[0];
    for (const tab of tabs) {
      const active = tab === chosen;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = panelFor(tab);
      if (panel) panel.hidden = !active;
    }
    if (focus) chosen.focus();
    if (scroll) {
      const block = document.getElementById(BLOCK_ID);
      if (block) block.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    return chosen;
  }

  function tabFromHash() {
    const hash = location.hash.replace(/^#/, "").toLowerCase();
    return TAB_FOR_HASH[hash] ?? null;
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      select(tab.dataset.tab);
      // replaceState rather than location.hash: no jump, no extra history entry.
      history.replaceState(null, "", HASH_FOR[tab.dataset.tab] ?? "#roster");
    });

    tab.addEventListener("keydown", (event) => {
      const index = tabs.indexOf(tab);
      let next = null;
      if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
      else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (event.key === "Home") next = tabs[0];
      else if (event.key === "End") next = tabs[tabs.length - 1];
      if (!next) return;
      event.preventDefault();
      select(next.dataset.tab, { focus: true });
      history.replaceState(null, "", HASH_FOR[next.dataset.tab] ?? "#roster");
    });
  });

  window.addEventListener("hashchange", () => {
    const name = tabFromHash();
    if (name) select(name, { scroll: true });
  });

  const initial = tabFromHash();
  if (initial && initial !== "lineups") select(initial, { scroll: true });
  else select(initial ?? "lineups");
})();
