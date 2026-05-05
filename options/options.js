// TabZen options page

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => root.querySelectorAll(sel);

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

let SETTINGS = null;
let dirty = false;

// ─── Toast ──────────────────────────────────────────────────────────────────
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => { t.hidden = true; }, 250);
  }, 1800);
}

// ─── Save (debounced) ───────────────────────────────────────────────────────
let saveTimer = null;
function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await send({ type: "replace-settings", settings: SETTINGS });
    dirty = false;
    toast("Saved");
  }, 350);
}

// ─── Load & render ──────────────────────────────────────────────────────────
async function load() {
  const res = await send({ type: "get-settings" });
  SETTINGS = res.data;
  renderAll();
  loadStats();
  loadSessions();
  loadMemoryInfo();

  // Welcome banner
  if (new URLSearchParams(window.location.search).get("welcome") === "1") {
    $("welcome").hidden = false;
  }
}

function renderAll() {
  // General
  $("opt-enabled").checked = SETTINGS.enabled;
  $("opt-minutes").value = SETTINGS.suspendAfterMinutes;
  $("opt-strategy").value = SETTINGS.strategy;

  // Never suspend
  $("ns-pinned").checked = SETTINGS.neverSuspend.pinned;
  $("ns-audible").checked = SETTINGS.neverSuspend.audible;
  $("ns-form").checked = SETTINGS.neverSuspend.hasFormInput;
  $("ns-offline").checked = SETTINGS.neverSuspend.offline;
  $("ns-active").checked = SETTINGS.neverSuspend.activeInAnyWindow;
  $("ns-only").checked = SETTINGS.neverSuspend.onlyTabInWindow;
  $("ns-power").checked = SETTINGS.neverSuspend.onPowerSource;
  $("ns-group").checked = SETTINGS.neverSuspend.inTabGroup;

  // Filters
  renderRuleList("whitelist", SETTINGS.whitelist);
  renderRuleList("blacklist", SETTINGS.blacklist);
  renderPerDomain(SETTINGS.perDomainRules);
  refreshGroupTitles();

  // Schedule
  $("sch-enabled").checked = SETTINGS.schedule.enabled;
  $$('input[type="checkbox"]', $("sch-days")).forEach(cb => {
    cb.checked = SETTINGS.schedule.days.includes(Number(cb.value));
  });
  $("sch-start").value = SETTINGS.schedule.workStart;
  $("sch-end").value = SETTINGS.schedule.workEnd;
  $("sch-work-min").value = SETTINGS.schedule.workSuspendAfterMinutes;
  $("sch-off-min").value = SETTINGS.schedule.offSuspendAfterMinutes;

  // Power & memory
  $("pow-aggro").checked = SETTINGS.power.aggressiveOnBattery;
  $("pow-bat-min").value = SETTINGS.power.batterySuspendAfterMinutes;
  $("mem-enabled").checked = SETTINGS.memoryPressure.enabled;
  $("mem-threshold").value = SETTINGS.memoryPressure.thresholdMB;
  $("mem-min").value = SETTINGS.memoryPressure.aggressiveSuspendAfterMinutes;

  // Smart
  $("smart-enabled").checked = SETTINGS.smart.enabled;
  $("smart-freq").value = SETTINGS.smart.frequentTabMultiplier;
  $("smart-rare").value = SETTINGS.smart.rareTabMultiplier;
  $("smart-visits").value = SETTINGS.smart.visitsThreshold;

  // Appearance
  $("ap-theme").value = SETTINGS.appearance.theme;
  $("ap-accent").value = SETTINGS.appearance.accent;
  $("ap-lastvisit").checked = SETTINGS.appearance.showLastVisited;
  $("ap-hint").checked = SETTINGS.appearance.showRestoreHint;
  $("ap-autorestore").checked = SETTINGS.appearance.autoRestoreOnFocus;
  $("ap-message").value = SETTINGS.appearance.customMessage || "";
}

// ─── Rule list rendering ────────────────────────────────────────────────────
function renderRuleList(elId, rules) {
  const ul = $(elId);
  ul.innerHTML = "";
  rules.forEach((r, i) => ul.appendChild(buildRuleNode(r, i, elId)));
  if (rules.length === 0) {
    const empty = document.createElement("li");
    empty.className = "rule-empty";
    empty.style.cssText = "padding:14px;color:var(--text-faint);font-size:12.5px;font-style:italic;text-align:center;";
    empty.textContent = "No entries yet. Click + Add entry to get started.";
    ul.appendChild(empty);
  }
}

// Populate the <datalist id="group-titles"> with current Chrome tab-group titles
// so users get autocomplete when authoring group-targeted rules.
async function refreshGroupTitles() {
  const dl = $("group-titles");
  if (!dl) return;
  let groups = [];
  try { groups = await chrome.tabGroups.query({}); } catch { /* tabGroups missing on some forks */ }
  const seen = new Set();
  dl.innerHTML = "";
  for (const g of groups) {
    const title = (g.title || "").trim();
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const opt = document.createElement("option");
    opt.value = title;
    dl.appendChild(opt);
  }
}

// Mode options shown depend on whether the rule targets a URL or a tab-group title.
const MODES_URL = [
  ["domain",   "domain"],
  ["contains", "contains"],
  ["exact",    "exact"],
  ["glob",     "glob"],
  ["regex",    "regex"],
];
const MODES_GROUP = [
  ["exact",    "exact"],
  ["contains", "contains"],
];

function applyModeOptions(modeSelect, target, currentValue) {
  const opts = target === "group" ? MODES_GROUP : MODES_URL;
  modeSelect.innerHTML = "";
  for (const [value, label] of opts) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    modeSelect.appendChild(o);
  }
  // Pick the previous mode if it's still valid; otherwise fall back to the first option.
  const valid = opts.some(([v]) => v === currentValue);
  modeSelect.value = valid ? currentValue : opts[0][0];
}

function buildRuleNode(rule, index, listKey) {
  const tpl = $("tpl-rule");
  const node = tpl.content.firstElementChild.cloneNode(true);
  const enabled = node.querySelector(".r-enabled");
  const target  = node.querySelector(".r-target");
  const mode    = node.querySelector(".r-mode");
  const value   = node.querySelector(".r-value");
  const del     = node.querySelector(".r-del");

  enabled.checked = rule.enabled !== false;
  target.value = rule.target || "url";
  applyModeOptions(mode, target.value, rule.mode || (target.value === "group" ? "exact" : "domain"));
  value.value = rule.value || "";
  value.placeholder = target.value === "group" ? "tab group title" : "value";

  enabled.addEventListener("change", () => {
    SETTINGS[listKey][index].enabled = enabled.checked;
    scheduleSave();
  });
  target.addEventListener("change", () => {
    SETTINGS[listKey][index].target = target.value;
    applyModeOptions(mode, target.value, mode.value);
    SETTINGS[listKey][index].mode = mode.value;
    value.placeholder = target.value === "group" ? "tab group title" : "value";
    scheduleSave();
  });
  mode.addEventListener("change", () => {
    SETTINGS[listKey][index].mode = mode.value;
    scheduleSave();
  });
  value.addEventListener("input", () => {
    SETTINGS[listKey][index].value = value.value.trim();
    scheduleSave();
  });
  del.addEventListener("click", () => {
    SETTINGS[listKey].splice(index, 1);
    renderRuleList(listKey, SETTINGS[listKey]);
    scheduleSave();
  });

  return node;
}

function renderPerDomain(rules) {
  const ul = $("perdomain");
  ul.innerHTML = "";
  rules.forEach((r, i) => ul.appendChild(buildPdNode(r, i)));
  if (rules.length === 0) {
    const empty = document.createElement("li");
    empty.className = "rule-empty";
    empty.style.cssText = "padding:14px;color:var(--text-faint);font-size:12.5px;font-style:italic;text-align:center;";
    empty.textContent = "No per-domain rules. The General timer applies to everything.";
    ul.appendChild(empty);
  }
}

function buildPdNode(rule, index) {
  const tpl = $("tpl-pd");
  const node = tpl.content.firstElementChild.cloneNode(true);
  const enabled = node.querySelector(".r-enabled");
  const target  = node.querySelector(".r-target");
  const mode    = node.querySelector(".r-mode");
  const value   = node.querySelector(".r-value");
  const action  = node.querySelector(".r-action");
  const min     = node.querySelector(".r-min");
  const del     = node.querySelector(".r-del");

  enabled.checked = rule.enabled !== false;
  target.value = rule.target || "url";
  applyModeOptions(mode, target.value, rule.mode || (target.value === "group" ? "exact" : "domain"));
  value.value = rule.value || rule.pattern || "";
  value.placeholder = target.value === "group" ? "tab group title" : "pattern";
  action.value = rule.neverSuspend ? "never" : "custom";
  min.value = rule.suspendAfterMinutes ?? 30;
  min.disabled = rule.neverSuspend;

  enabled.addEventListener("change", () => {
    SETTINGS.perDomainRules[index].enabled = enabled.checked;
    scheduleSave();
  });
  target.addEventListener("change", () => {
    SETTINGS.perDomainRules[index].target = target.value;
    applyModeOptions(mode, target.value, mode.value);
    SETTINGS.perDomainRules[index].mode = mode.value;
    value.placeholder = target.value === "group" ? "tab group title" : "pattern";
    scheduleSave();
  });
  mode.addEventListener("change", () => {
    SETTINGS.perDomainRules[index].mode = mode.value;
    scheduleSave();
  });
  value.addEventListener("input", () => {
    SETTINGS.perDomainRules[index].value = value.value.trim();
    scheduleSave();
  });
  action.addEventListener("change", () => {
    const isNever = action.value === "never";
    SETTINGS.perDomainRules[index].neverSuspend = isNever;
    min.disabled = isNever;
    scheduleSave();
  });
  min.addEventListener("input", () => {
    SETTINGS.perDomainRules[index].suspendAfterMinutes = Number(min.value);
    scheduleSave();
  });
  del.addEventListener("click", () => {
    SETTINGS.perDomainRules.splice(index, 1);
    renderPerDomain(SETTINGS.perDomainRules);
    scheduleSave();
  });

  return node;
}

// ─── Wire controls ──────────────────────────────────────────────────────────
function wire() {
  // General
  $("opt-enabled").addEventListener("change", () => { SETTINGS.enabled = $("opt-enabled").checked; scheduleSave(); });
  $("opt-minutes").addEventListener("input", () => { SETTINGS.suspendAfterMinutes = clampInt($("opt-minutes").value, 1, 1440, 30); scheduleSave(); });
  $("opt-strategy").addEventListener("change", () => { SETTINGS.strategy = $("opt-strategy").value; scheduleSave(); });

  // Never suspend
  const nsMap = {
    "ns-pinned": "pinned",
    "ns-audible": "audible",
    "ns-form": "hasFormInput",
    "ns-offline": "offline",
    "ns-active": "activeInAnyWindow",
    "ns-only": "onlyTabInWindow",
    "ns-power": "onPowerSource",
    "ns-group": "inTabGroup"
  };
  for (const [id, key] of Object.entries(nsMap)) {
    $(id).addEventListener("change", () => {
      SETTINGS.neverSuspend[key] = $(id).checked;
      scheduleSave();
    });
  }

  // Filters
  $("add-whitelist").addEventListener("click", () => {
    SETTINGS.whitelist.push({ target: "url", mode: "domain", value: "", enabled: true });
    renderRuleList("whitelist", SETTINGS.whitelist);
    refreshGroupTitles();
    scheduleSave();
  });
  $("add-blacklist").addEventListener("click", () => {
    SETTINGS.blacklist.push({ target: "url", mode: "domain", value: "", enabled: true });
    renderRuleList("blacklist", SETTINGS.blacklist);
    refreshGroupTitles();
    scheduleSave();
  });
  $("add-perdomain").addEventListener("click", () => {
    SETTINGS.perDomainRules.push({ target: "url", mode: "domain", value: "", enabled: true, neverSuspend: false, suspendAfterMinutes: 60 });
    renderPerDomain(SETTINGS.perDomainRules);
    refreshGroupTitles();
    scheduleSave();
  });

  // Schedule
  $("sch-enabled").addEventListener("change", () => { SETTINGS.schedule.enabled = $("sch-enabled").checked; scheduleSave(); });
  $$("input[type='checkbox']", $("sch-days")).forEach(cb => {
    cb.addEventListener("change", () => {
      const day = Number(cb.value);
      if (cb.checked && !SETTINGS.schedule.days.includes(day)) SETTINGS.schedule.days.push(day);
      else if (!cb.checked) SETTINGS.schedule.days = SETTINGS.schedule.days.filter(d => d !== day);
      scheduleSave();
    });
  });
  $("sch-start").addEventListener("change", () => { SETTINGS.schedule.workStart = $("sch-start").value; scheduleSave(); });
  $("sch-end").addEventListener("change", () => { SETTINGS.schedule.workEnd = $("sch-end").value; scheduleSave(); });
  $("sch-work-min").addEventListener("input", () => { SETTINGS.schedule.workSuspendAfterMinutes = clampInt($("sch-work-min").value, 1, 1440, 15); scheduleSave(); });
  $("sch-off-min").addEventListener("input", () => { SETTINGS.schedule.offSuspendAfterMinutes = clampInt($("sch-off-min").value, 1, 1440, 90); scheduleSave(); });

  // Power & memory
  $("pow-aggro").addEventListener("change", () => { SETTINGS.power.aggressiveOnBattery = $("pow-aggro").checked; scheduleSave(); });
  $("pow-bat-min").addEventListener("input", () => { SETTINGS.power.batterySuspendAfterMinutes = clampInt($("pow-bat-min").value, 1, 1440, 10); scheduleSave(); });
  $("mem-enabled").addEventListener("change", () => { SETTINGS.memoryPressure.enabled = $("mem-enabled").checked; scheduleSave(); });
  $("mem-threshold").addEventListener("input", () => { SETTINGS.memoryPressure.thresholdMB = clampInt($("mem-threshold").value, 256, 65536, 4096); scheduleSave(); });
  $("mem-min").addEventListener("input", () => { SETTINGS.memoryPressure.aggressiveSuspendAfterMinutes = clampInt($("mem-min").value, 1, 1440, 5); scheduleSave(); });

  // Smart
  $("smart-enabled").addEventListener("change", () => { SETTINGS.smart.enabled = $("smart-enabled").checked; scheduleSave(); });
  $("smart-freq").addEventListener("input", () => { SETTINGS.smart.frequentTabMultiplier = clampFloat($("smart-freq").value, 1, 10, 2); scheduleSave(); });
  $("smart-rare").addEventListener("input", () => { SETTINGS.smart.rareTabMultiplier = clampFloat($("smart-rare").value, 0.1, 2, 0.6); scheduleSave(); });
  $("smart-visits").addEventListener("input", () => { SETTINGS.smart.visitsThreshold = clampInt($("smart-visits").value, 2, 100, 5); scheduleSave(); });

  // Appearance
  $("ap-theme").addEventListener("change", () => { SETTINGS.appearance.theme = $("ap-theme").value; scheduleSave(); });
  $("ap-accent").addEventListener("input", () => { SETTINGS.appearance.accent = $("ap-accent").value; scheduleSave(); });
  $("ap-lastvisit").addEventListener("change", () => { SETTINGS.appearance.showLastVisited = $("ap-lastvisit").checked; scheduleSave(); });
  $("ap-hint").addEventListener("change", () => { SETTINGS.appearance.showRestoreHint = $("ap-hint").checked; scheduleSave(); });
  $("ap-autorestore").addEventListener("change", () => { SETTINGS.appearance.autoRestoreOnFocus = $("ap-autorestore").checked; scheduleSave(); });
  $("ap-message").addEventListener("input", () => { SETTINGS.appearance.customMessage = $("ap-message").value; scheduleSave(); });

  // Sessions
  $("save-session").addEventListener("click", saveSession);

  // Stats
  $("reset-stats").addEventListener("click", async () => {
    if (!confirm("Clear all suspension statistics?")) return;
    await send({ type: "reset-stats" });
    loadStats();
    toast("Stats reset");
  });

  // Shortcuts
  $("open-shortcuts").addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });

  // Data
  $("export-btn").addEventListener("click", exportSettings);
  $("import-file").addEventListener("change", importSettings);
  $("reset-all").addEventListener("click", async () => {
    if (!confirm("This will erase all rules, stats, sessions, and settings. Continue?")) return;
    await chrome.storage.local.clear();
    location.reload();
  });

  // Sidebar nav highlighting
  setupNav();
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function clampFloat(v, min, max, fallback) {
  const n = parseFloat(v);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ─── Sidebar nav highlight on scroll ────────────────────────────────────────
function setupNav() {
  const items = Array.from($$(".nav-item"));

  // Map nav-item element → panel element. The href is "#general" but the
  // panel id is "general-panel", so we add the suffix when looking it up.
  const pairs = items.map(a => {
    const target = a.getAttribute("href") || "";
    const panelId = target.replace(/^#/, "") + "-panel";
    return { item: a, panel: document.getElementById(panelId) };
  }).filter(p => p.panel);

  // Click handler — scroll the panel into view and mark the item active.
  // We call preventDefault so the browser doesn't jump to a non-existent #id
  // (the href is "#general" but the actual id on the panel is "general-panel").
  pairs.forEach(({ item, panel }) => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      items.forEach(x => x.classList.remove("active"));
      item.classList.add("active");
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
      // Reflect the section in the URL without triggering a jump
      history.replaceState(null, "", item.getAttribute("href"));
    });
  });

  // Highlight on scroll — pick the panel whose top is closest to (but above)
  // a band 30% from the top of the viewport.
  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter(e => e.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (visible[0]) {
      const panelId = visible[0].target.id;
      const pair = pairs.find(p => p.panel.id === panelId);
      if (pair) {
        items.forEach(x => x.classList.remove("active"));
        pair.item.classList.add("active");
      }
    }
  }, { rootMargin: "-20% 0px -70% 0px", threshold: 0 });

  pairs.forEach(p => observer.observe(p.panel));

  // If the page loaded with a hash, jump there now (after fonts/layout settle)
  if (window.location.hash) {
    const target = window.location.hash.replace(/^#/, "") + "-panel";
    const panel = document.getElementById(target);
    if (panel) {
      requestAnimationFrame(() => panel.scrollIntoView({ block: "start" }));
    }
  }
}

// ─── Stats ──────────────────────────────────────────────────────────────────
async function loadStats() {
  const stats = (await send({ type: "get-stats" }))?.data;
  if (!stats) return;
  $("bs-suspensions").textContent = String(stats.totalSuspensions || 0);
  $("bs-saved").textContent = formatBytes(stats.estimatedBytesSaved || 0);
  $("bs-restored").textContent = String(stats.totalRestorations || 0);
  $("bs-since").textContent = stats.installedAt ? new Date(stats.installedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

  const ul = $("top-domains");
  ul.innerHTML = "";
  const entries = Object.entries(stats.byDomain || {})
    .sort((a, b) => b[1].suspensions - a[1].suspensions)
    .slice(0, 10);
  if (entries.length === 0) {
    const li = document.createElement("li");
    li.style.cssText = "color:var(--text-faint);font-style:italic;justify-content:center;";
    li.textContent = "No data yet — keep browsing.";
    ul.appendChild(li);
  } else {
    for (const [host, info] of entries) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="dom">${escapeHtml(host)}</span><span class="cnt">${info.suspensions} suspensions</span>`;
      ul.appendChild(li);
    }
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&": "&amp;","<": "&lt;",">": "&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// ─── Sessions ───────────────────────────────────────────────────────────────
async function saveSession() {
  const name = prompt("Name this session:", `Session ${new Date().toLocaleString()}`);
  if (!name) return;
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const stripped = tabs.map(t => {
    let url = t.url;
    // If suspended, store the original
    const susp = chrome.runtime.getURL("suspended/");
    if (url && url.startsWith(susp)) {
      const params = new URLSearchParams(url.split("#")[1] || "");
      url = params.get("u") || url;
    }
    return { title: t.title, url, favIconUrl: t.favIconUrl, pinned: t.pinned };
  });
  await send({ type: "save-session", name, tabs: stripped });
  loadSessions();
  toast("Session saved");
}

async function loadSessions() {
  const res = await send({ type: "list-sessions" });
  const list = res?.data || [];
  const ul = $("session-list");
  ul.innerHTML = "";
  if (list.length === 0) {
    const li = document.createElement("li");
    li.style.cssText = "justify-content:center;color:var(--text-faint);font-style:italic;";
    li.textContent = "No saved sessions.";
    ul.appendChild(li);
    return;
  }
  list.forEach((s, i) => {
    const li = document.createElement("li");
    const left = document.createElement("div");
    left.innerHTML = `<div class="s-name">${escapeHtml(s.name)}</div><div class="s-meta">${s.tabs.length} tabs · ${new Date(s.savedAt).toLocaleString()}</div>`;
    const right = document.createElement("div");
    right.className = "s-actions";

    const restoreBtn = document.createElement("button");
    restoreBtn.className = "btn primary-btn";
    restoreBtn.textContent = "Open";
    restoreBtn.addEventListener("click", async () => {
      for (const t of s.tabs) {
        await chrome.tabs.create({ url: t.url, pinned: t.pinned, active: false });
      }
      toast(`Opened ${s.tabs.length} tabs`);
    });

    const delBtn = document.createElement("button");
    delBtn.className = "btn danger-btn";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete session "${s.name}"?`)) return;
      await send({ type: "delete-session", index: i });
      loadSessions();
      toast("Session deleted");
    });

    right.appendChild(restoreBtn);
    right.appendChild(delBtn);
    li.appendChild(left);
    li.appendChild(right);
    ul.appendChild(li);
  });
}

// ─── Memory info ────────────────────────────────────────────────────────────
async function loadMemoryInfo() {
  const res = await send({ type: "memory-info" });
  if (res?.ok) {
    $("mem-current").textContent = res.freeMB ? `${(res.freeMB / 1024).toFixed(1)} GB` : "unknown";
    $("mem-battery").textContent = res.onBattery ? "on battery" : "on power";
  }
}

// ─── Import / export ────────────────────────────────────────────────────────
function exportSettings() {
  const blob = new Blob([JSON.stringify(SETTINGS, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tabzen-config-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Configuration exported");
}

async function importSettings(e) {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || !parsed) throw new Error("invalid format");
    if (!confirm("Replace current configuration with imported settings?")) return;
    await send({ type: "replace-settings", settings: parsed });
    location.reload();
  } catch (err) {
    alert("Could not import: " + err.message);
  }
  e.target.value = "";
}

// ─── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  await load();
  wire();
});
