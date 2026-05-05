// TabZen popup — redesigned for casual-friendly tab triage.
const $ = (id) => document.getElementById(id);

const SUSPENDED_PREFIX = chrome.runtime.getURL("suspended/");
const ESTIMATE_PER_TAB_MB = 80; // matches background.js accounting
const IDLE_MIN_MS = 60_000;     // hide tabs idle < 1 minute (effectively just-used)

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function isSuspendedUrl(url) {
  return !!(url && url.startsWith(SUSPENDED_PREFIX));
}
function isInternal(url) {
  if (!url) return true;
  return url.startsWith("chrome://") || url.startsWith("edge://") ||
         url.startsWith("about:") || url.startsWith("file://") ||
         url.startsWith("devtools://") || url.startsWith("chrome-extension://");
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

function unsuspendInfo(url) {
  // Pull original URL/title/favicon out of a TabZen suspended page.
  if (!isSuspendedUrl(url)) return null;
  const params = new URLSearchParams((url.split("#")[1] || ""));
  return {
    url: params.get("u") || "",
    title: params.get("t") || "",
    favIconUrl: params.get("f") || "",
  };
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatAge(ms) {
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins - hours * 60;
  if (hours < 24) return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  const days = Math.floor(hours / 24);
  const remH = hours - days * 24;
  return remH === 0 ? `${days}d` : `${days}d ${remH}h`;
}

function ageHeat(ms) {
  if (ms >= 60 * 60_000) return "hot";   // ≥ 1h
  if (ms >= 15 * 60_000) return "warm";  // ≥ 15m
  return "";
}

let TOAST_TIMER = null;
function toast(msg, ms = 1600) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  // Force reflow so the transition runs
  void t.offsetWidth;
  t.classList.add("show");
  if (TOAST_TIMER) clearTimeout(TOAST_TIMER);
  TOAST_TIMER = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => { t.hidden = true; }, 220);
  }, ms);
}

// ─── Whitelist helpers (domain-mode rules) ────────────────────────────────
function whitelistedFor(host, settings) {
  if (!host) return false;
  const h = host.toLowerCase();
  return (settings.whitelist || []).some(r => {
    if (r.enabled === false) return false;
    if ((r.target || "url") !== "url") return false;
    if (r.mode !== "domain") return false;
    const t = (r.value || "").toLowerCase().replace(/^\*\./, "");
    return t && (h === t || h.endsWith("." + t));
  });
}

async function toggleWhitelist(host) {
  const cur = (await send({ type: "get-settings" }))?.data;
  cur.whitelist = cur.whitelist || [];
  const idx = cur.whitelist.findIndex(r =>
    (r.target || "url") === "url" && r.mode === "domain" &&
    (r.value || "").toLowerCase() === host.toLowerCase()
  );
  let added;
  if (idx >= 0) { cur.whitelist.splice(idx, 1); added = false; }
  else {
    cur.whitelist.push({ target: "url", mode: "domain", value: host, enabled: true });
    added = true;
  }
  await send({ type: "replace-settings", settings: cur });
  return added;
}

// ─── Idle list rendering ──────────────────────────────────────────────────
function buildIdleRow(tab, idleMs, settings) {
  const tpl = $("tpl-idle");
  const node = tpl.content.firstElementChild.cloneNode(true);
  const fav = node.querySelector(".ir-fav");
  const title = node.querySelector(".ir-title");
  const host = node.querySelector(".ir-host");
  const age = node.querySelector(".ir-age");
  const suspend = node.querySelector(".ir-suspend");

  const dispUrl = tab.url || "";
  const h = hostOf(dispUrl);

  title.textContent = tab.title || h || "Untitled";
  host.textContent = h || "—";

  if (tab.favIconUrl) {
    fav.src = tab.favIconUrl;
    fav.onerror = () => { fav.classList.add("fallback"); fav.removeAttribute("src"); };
  } else {
    fav.classList.add("fallback");
  }

  age.textContent = formatAge(idleMs);
  age.title = `Idle for ${formatAge(idleMs)} · click ⊘ to suspend now`;
  const heat = ageHeat(idleMs);
  if (heat) age.classList.add(heat);

  suspend.addEventListener("click", async (e) => {
    e.stopPropagation();
    suspend.disabled = true;
    await send({ type: "suspend-tab", tabId: tab.id });
    node.style.transition = "opacity .18s, transform .18s";
    node.style.opacity = "0";
    node.style.transform = "translateX(8px)";
    setTimeout(() => { node.remove(); refreshAfterAction(); }, 180);
  });

  // Click anywhere else on the row → focus that tab
  node.addEventListener("click", () => {
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });
    window.close();
  });

  return node;
}

async function refreshAfterAction() {
  // Re-render the idle list after a row is removed, so counts/bulk stay in sync.
  const ul = $("idle-list");
  const rows = ul.querySelectorAll(".idle-row").length;
  $("idle-count").textContent = String(rows);
  $("bulk-count").textContent = String(rows);
  $("bulk-est").textContent = `~${formatBytes(rows * ESTIMATE_PER_TAB_MB * 1024 * 1024)}`;
  if (rows === 0) {
    $("bulk-suspend").hidden = true;
    $("idle-empty").hidden = false;
  }
}

async function loadIdleList(currentTabId, currentWindowId) {
  const list = $("idle-list");
  list.innerHTML = "";

  const resp = await send({ type: "list-tabs", query: { windowId: currentWindowId } });
  const tabs = resp?.data || [];
  const settings = (await send({ type: "get-settings" }))?.data || { whitelist: [] };

  const now = Date.now();

  // Decorate with idleMs, then filter to candidates worth showing.
  const candidates = tabs
    .filter(t => t.id !== currentTabId)
    .filter(t => !t.suspended)
    .filter(t => !t.discarded)
    .filter(t => !isInternal(t.url))
    .filter(t => typeof t.lastActiveAt === "number")
    .map(t => ({ tab: t, idleMs: Math.max(0, now - t.lastActiveAt) }))
    .filter(c => c.idleMs >= IDLE_MIN_MS)
    .sort((a, b) => b.idleMs - a.idleMs)
    .slice(0, 30);

  candidates.forEach(c => {
    list.appendChild(buildIdleRow(c.tab, c.idleMs, settings));
  });

  $("idle-count").textContent = String(candidates.length);

  if (candidates.length === 0) {
    $("idle-empty").hidden = false;
    $("bulk-suspend").hidden = true;
  } else {
    $("idle-empty").hidden = true;
    $("bulk-suspend").hidden = false;
    $("bulk-count").textContent = String(candidates.length);
    $("bulk-est").textContent = `~${formatBytes(candidates.length * ESTIMATE_PER_TAB_MB * 1024 * 1024)}`;
  }

  // Bulk suspend handler: suspend each idle tab in sequence.
  $("bulk-suspend").onclick = async () => {
    $("bulk-suspend").disabled = true;
    const ids = candidates.map(c => c.tab.id);
    for (const id of ids) await send({ type: "suspend-tab", tabId: id });
    toast(`Suspended ${ids.length} tab${ids.length === 1 ? "" : "s"}`);
    list.innerHTML = "";
    $("idle-count").textContent = "0";
    $("bulk-suspend").hidden = true;
    $("idle-empty").hidden = false;
  };
}

// ─── Init ─────────────────────────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const settings = (await send({ type: "get-settings" }))?.data;
  const stats = (await send({ type: "get-stats" }))?.data;
  const mem = await send({ type: "memory-info" });

  // Enabled toggle
  function paintEnabled(on) {
    $("enabled-label").textContent = on ? "On" : "Paused";
    $("enabled-dot").classList.toggle("off", !on);
  }
  paintEnabled(settings.enabled);
  $("toggle-enabled").addEventListener("click", async () => {
    const cur = (await send({ type: "get-settings" }))?.data;
    const next = !cur.enabled;
    await send({ type: "set-settings", patch: { enabled: next } });
    paintEnabled(next);
    toast(next ? "Auto-suspend on" : "Auto-suspend paused");
  });

  // Current tab card
  if (!tab) return;

  const isSusp = isSuspendedUrl(tab.url);
  const sInfo = unsuspendInfo(tab.url);
  const displayUrl = isSusp && sInfo ? sInfo.url : (tab.url || "");
  const displayTitle = isSusp && sInfo?.title ? sInfo.title : (tab.title || "Untitled");
  const host = hostOf(displayUrl);

  $("cur-title").textContent = displayTitle;
  $("cur-host").textContent = host || "—";

  const fav = $("cur-fav");
  const favSrc = isSusp && sInfo?.favIconUrl ? sInfo.favIconUrl : tab.favIconUrl;
  if (favSrc) {
    fav.src = favSrc;
    fav.onerror = () => { fav.style.display = "none"; };
  } else {
    fav.style.display = "none";
  }

  // Status chip — only show when meaningful
  const chip = $("cur-status");
  const wlMatch = whitelistedFor(host, settings);
  function renderChip() {
    chip.classList.remove("suspended", "whitelisted");
    chip.hidden = false;
    if (isSusp) { chip.textContent = "Suspended"; chip.classList.add("suspended"); }
    else if (tab.discarded) { chip.textContent = "Discarded"; chip.classList.add("suspended"); }
    else if (wlMatch) { chip.textContent = "Protected"; chip.classList.add("whitelisted"); }
    else if (tab.pinned) { chip.textContent = "Pinned"; }
    else if (tab.audible) { chip.textContent = "Audible"; }
    else { chip.hidden = true; }
  }
  renderChip();

  // Whitelist (heart/star) toggle
  const wlBtn = $("act-whitelist");
  function paintWl(on) {
    wlBtn.classList.toggle("on", on);
    wlBtn.title = on ? `${host} is protected — click to remove` : `Never suspend ${host || "this site"}`;
  }
  paintWl(wlMatch);
  if (!host || isInternal(displayUrl)) {
    wlBtn.disabled = true;
    wlBtn.style.opacity = "0.35";
  } else {
    wlBtn.addEventListener("click", async () => {
      const added = await toggleWhitelist(host);
      paintWl(added);
      toast(added ? `Protected ${host}` : `Removed ${host} from protected`);
      // Update status chip too
      const fresh = (await send({ type: "get-settings" }))?.data;
      const nowWl = whitelistedFor(host, fresh);
      if (!isSusp && !tab.discarded && !tab.pinned && !tab.audible) {
        chip.classList.remove("suspended", "whitelisted");
        if (nowWl) { chip.textContent = "Protected"; chip.classList.add("whitelisted"); chip.hidden = false; }
        else { chip.hidden = true; }
      }
    });
  }

  // Smart primary action
  const primary = $("primary-action");
  const pText = $("primary-text");
  const pHint = $("primary-hint");
  const pSk = $("primary-shortcut");
  const snoozeRow = $("snooze-row");

  // Snooze state — when a chip is armed, the primary button suspends with a wakeAt.
  let armedSnooze = null; // { wakeAt, label } or null

  function presetWakeAt(preset) {
    const d = new Date();
    if (preset === "tomorrow") {
      // Next day at 8:00 local time
      d.setDate(d.getDate() + 1);
      d.setHours(8, 0, 0, 0);
      return { wakeAt: d.getTime(), label: "tomorrow 8 am" };
    }
    if (preset === "monday") {
      // Next Monday at 8:00 local. If today is Monday, 7 days from now.
      const day = d.getDay(); // 0 Sun .. 6 Sat
      const daysToMon = ((1 - day + 7) % 7) || 7;
      d.setDate(d.getDate() + daysToMon);
      d.setHours(8, 0, 0, 0);
      return { wakeAt: d.getTime(), label: "Mon 8 am" };
    }
    return null;
  }

  function paintSnoozeArm() {
    document.querySelectorAll(".snooze-chip").forEach(chip => chip.classList.remove("armed"));
    if (!armedSnooze) {
      // Reset hint to default
      paintPrimary();
      return;
    }
    const target = document.querySelector(
      armedSnooze.preset
        ? `.snooze-chip[data-preset="${armedSnooze.preset}"]`
        : `.snooze-chip[data-mins="${armedSnooze.mins}"]`
    );
    if (target) target.classList.add("armed");
    pText.textContent = "Snooze this tab";
    pHint.textContent = `Auto-restores ${armedSnooze.label}`;
    pSk.textContent = "Alt+S";
    primary.classList.remove("muted");
    primary.dataset.action = "suspend";
  }

  function paintPrimary() {
    primary.classList.remove("muted");
    primary.disabled = false;
    pSk.hidden = false;

    if (isSusp || tab.discarded) {
      pText.textContent = "Restore this tab";
      pHint.textContent = isSusp ? "Bring it back" : "Reload from cache";
      pSk.textContent = "Alt+R";
      primary.dataset.action = "restore";
    } else if (isInternal(tab.url)) {
      pText.textContent = "Can't suspend this page";
      pHint.textContent = "Browser pages stay loaded";
      pSk.hidden = true;
      primary.classList.add("muted");
      primary.disabled = true;
    } else if (wlMatch) {
      pText.textContent = "Suspend this tab";
      pHint.textContent = `${host} is protected — suspend anyway`;
      pSk.textContent = "Alt+S";
      primary.classList.add("muted");
      primary.dataset.action = "suspend";
    } else {
      pText.textContent = "Suspend this tab";
      pHint.textContent = `Frees about ${ESTIMATE_PER_TAB_MB} MB`;
      pSk.textContent = "Alt+S";
      primary.dataset.action = "suspend";
    }
  }
  paintPrimary();

  // Show snooze chips only when this tab can actually be suspended.
  const canSnooze = !isSusp && !tab.discarded && !isInternal(tab.url);
  if (canSnooze) {
    snoozeRow.hidden = false;
    document.querySelectorAll(".snooze-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        const mins = chip.dataset.mins ? Number(chip.dataset.mins) : null;
        const preset = chip.dataset.preset || null;
        const isCurrentlyArmed =
          (armedSnooze?.mins === mins && mins !== null) ||
          (armedSnooze?.preset === preset && preset !== null);
        if (isCurrentlyArmed) {
          armedSnooze = null;
        } else if (mins !== null) {
          armedSnooze = { wakeAt: Date.now() + mins * 60_000, label: `in ${mins >= 60 ? (mins/60) + " hr" : mins + " min"}`, mins };
        } else if (preset) {
          const p = presetWakeAt(preset);
          if (p) armedSnooze = { ...p, preset };
        }
        paintSnoozeArm();
      });
    });
  }

  primary.addEventListener("click", async () => {
    const action = primary.dataset.action;
    if (action === "restore") {
      await send({ type: "restore-tab", tabId: tab.id });
    } else {
      const payload = { type: "suspend-tab", tabId: tab.id };
      if (armedSnooze) payload.wakeAt = armedSnooze.wakeAt;
      await send(payload);
    }
    window.close();
  });

  // Stats
  $("s-suspensions").textContent = String(stats.totalSuspensions || 0);
  $("s-saved").textContent = formatBytes(stats.estimatedBytesSaved || 0);
  $("s-free").textContent = mem?.freeMB
    ? (mem.freeMB >= 1024 ? `${(mem.freeMB / 1024).toFixed(1)} GB` : `${Math.round(mem.freeMB)} MB`)
    : "—";

  // Footer
  $("act-restore-all").addEventListener("click", async () => {
    await send({ type: "restore-all" });
    toast("Restored all suspended tabs");
    setTimeout(() => window.close(), 700);
  });
  $("open-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
  $("open-github").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "https://github.com/mthcht/tabzen" });
    window.close();
  });

  // The new feature — populate idle list (after the rest renders, so popup feels snappy)
  loadIdleList(tab.id, tab.windowId);
  loadOthersInWindowAction(tab.id, tab.windowId);
  loadOtherWindowsAction(tab.windowId);
}

async function loadOthersInWindowAction(currentTabId, currentWindowId) {
  // The "I want to free everything except what I'm looking at right now" action.
  // Distinct from the bulk button on the idle list, which only acts on tabs idle
  // for >1 minute — this includes recently-used non-idle tabs as well.
  const btn = document.getElementById("suspend-others-in-window");
  if (!btn) return;
  const resp = await chrome.runtime.sendMessage({
    type: "count-other-tabs-in-window",
    windowId: currentWindowId,
  });
  const n = resp?.count || 0;
  if (n === 0) { btn.hidden = true; return; }

  document.getElementById("in-window-count").textContent = String(n);
  btn.hidden = false;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.querySelector(".primary-text").textContent = "Suspending…";
    btn.querySelector(".primary-hint").textContent = "";
    const r = await chrome.runtime.sendMessage({
      type: "suspend-all-window",
      windowId: currentWindowId,
    });
    const count = r?.count ?? n;
    toast(`Suspended ${count} tab${count === 1 ? "" : "s"} in this window`);
    setTimeout(() => window.close(), 700);
  });
}

async function loadOtherWindowsAction(currentWindowId) {
  const btn = document.getElementById("suspend-others");
  if (!btn) return;
  const resp = await chrome.runtime.sendMessage({ type: "count-other-window-tabs", windowId: currentWindowId });
  const n = resp?.count || 0;
  const winCount = resp?.windowCount || 0;
  if (n === 0) { btn.hidden = true; return; }

  // Chip on the right: total tab count.  Hint underneath: window count.
  document.getElementById("other-window-count").textContent = String(n);
  document.getElementById("other-count").textContent = String(winCount);
  document.getElementById("other-plural").textContent = winCount === 1 ? "" : "s";
  btn.hidden = false;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.querySelector(".primary-text").textContent = "Suspending…";
    btn.querySelector(".primary-hint").textContent = "";
    const r = await chrome.runtime.sendMessage({ type: "suspend-other-windows", windowId: currentWindowId });
    toast(`Suspended ${r?.count ?? n} tab${(r?.count ?? n) === 1 ? "" : "s"} in other windows`);
    setTimeout(() => window.close(), 700);
  });
}

document.addEventListener("DOMContentLoaded", init);
