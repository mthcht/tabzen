// TabZen — Background service worker
// Manifest V3 module. Runs ephemerally; persists state in chrome.storage.

// ─── Constants ──────────────────────────────────────────────────────────────

const ALARM_TICK = "tabzen-tick";
const ALARM_TICK_PERIOD_MIN = 1; // run rules every minute
const SUSPENDED_PAGE = chrome.runtime.getURL("suspended/suspended.html");
const STORAGE_KEY_SETTINGS = "settings";
const STORAGE_KEY_STATS = "stats";
const STORAGE_KEY_USAGE = "usage"; // for smart-suspension learning
const STORAGE_KEY_SESSIONS = "sessions";

// In-memory tab activity ledger. Rebuilt on service worker wake.
// Map<tabId, { lastActiveAt: epoch_ms, hasFormInput: boolean, audible: boolean }>
const tabState = new Map();

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  enabled: true,

  // Core timing
  suspendAfterMinutes: 30,
  strategy: "replace", // "replace" (full suspended page) | "discard" (Chrome's native)

  // Conditional never-suspend
  neverSuspend: {
    pinned: true,
    audible: true,
    hasFormInput: true,
    offline: true,
    onlyTabInWindow: false,
    activeInAnyWindow: true,
    onPowerSource: false, // skip suspension when plugged in
    inTabGroup: false
  },

  // URL filters — multiple match modes
  whitelist: [
    // { mode: "domain"|"contains"|"exact"|"regex"|"glob", value: "..." }
  ],
  blacklist: [], // force-suspend matches even if they'd normally be skipped

  // Per-domain rule overrides
  perDomainRules: [
    // { pattern: "github.com", mode: "domain", suspendAfterMinutes: 60, neverSuspend: false, enabled: true }
  ],

  // Battery / power awareness
  power: {
    aggressiveOnBattery: false,
    batterySuspendAfterMinutes: 10
  },

  // Time-of-day schedule
  schedule: {
    enabled: false,
    days: [1, 2, 3, 4, 5], // Mon-Fri
    workStart: "09:00",
    workEnd: "17:00",
    workSuspendAfterMinutes: 15,
    offSuspendAfterMinutes: 90
  },

  // Memory pressure
  memoryPressure: {
    enabled: false,
    thresholdMB: 4096, // when free RAM drops below this, accelerate suspension
    aggressiveSuspendAfterMinutes: 5
  },

  // Smart usage learning
  smart: {
    enabled: true,
    frequentTabMultiplier: 2.0, // tabs visited often get 2x the base timer
    rareTabMultiplier: 0.6,     // rarely-revisited tabs suspend faster
    visitsThreshold: 5
  },

  // Suspended-page appearance
  appearance: {
    theme: "dark", // "dark" | "light" | "auto"
    accent: "#e8956b",
    showLastVisited: true,
    showRestoreHint: true,
    customMessage: "",
    autoRestoreOnFocus: false,
    confirmRestoreForLargePages: false
  },

  // Notifications
  notifications: {
    onSuspend: false,
    onMilestone: true // notify on RAM-saved milestones
  }
};

const DEFAULT_STATS = {
  installedAt: 0,
  totalSuspensions: 0,
  totalRestorations: 0,
  estimatedBytesSaved: 0,
  lastMilestoneGB: 0,
  byDomain: {} // { "github.com": { suspensions, lastSuspendedAt } }
};

// ─── Storage helpers ────────────────────────────────────────────────────────

async function getSettings() {
  const { [STORAGE_KEY_SETTINGS]: s } = await chrome.storage.local.get(STORAGE_KEY_SETTINGS);
  return mergeDeep(structuredClone(DEFAULT_SETTINGS), s || {});
}

async function setSettings(patch) {
  const current = await getSettings();
  const next = mergeDeep(current, patch);
  await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: next });
  return next;
}

async function getStats() {
  const { [STORAGE_KEY_STATS]: s } = await chrome.storage.local.get(STORAGE_KEY_STATS);
  return Object.assign({}, DEFAULT_STATS, s || {});
}

async function setStats(patch) {
  const current = await getStats();
  const next = Object.assign({}, current, patch);
  await chrome.storage.local.set({ [STORAGE_KEY_STATS]: next });
  return next;
}

async function getUsage() {
  const { [STORAGE_KEY_USAGE]: u } = await chrome.storage.local.get(STORAGE_KEY_USAGE);
  return u || {}; // { "host/path-prefix": { visits, totalDwellMs, lastVisitAt } }
}

async function setUsage(map) {
  await chrome.storage.local.set({ [STORAGE_KEY_USAGE]: map });
}

function mergeDeep(target, source) {
  if (source === null || typeof source !== "object") return source;
  if (Array.isArray(source)) return source.slice();
  const out = Object.assign({}, target);
  for (const key of Object.keys(source)) {
    out[key] = (key in target && typeof target[key] === "object" && target[key] !== null && !Array.isArray(target[key]))
      ? mergeDeep(target[key], source[key])
      : (typeof source[key] === "object" && source[key] !== null && !Array.isArray(source[key]))
        ? mergeDeep({}, source[key])
        : source[key];
  }
  return out;
}

// ─── URL & rule matching ────────────────────────────────────────────────────

function parseUrl(url) {
  try { return new URL(url); } catch { return null; }
}

// A ctx represents what we know about a tab for matching purposes:
//   { url: string, groupTitle: string|null }
function matchRule(ctx, rule) {
  if (!rule || rule.enabled === false) return false;
  const value = (rule.value ?? rule.pattern ?? "").trim();
  if (!value) return false;
  const target = rule.target || "url";

  if (target === "group") {
    if (!ctx.groupTitle) return false;
    const title = ctx.groupTitle.toLowerCase();
    const v = value.toLowerCase();
    switch (rule.mode) {
      case "contains": return title.includes(v);
      case "exact":
      default:         return title === v;
    }
  }

  // target === "url"
  const url = ctx.url;
  const u = parseUrl(url);
  if (!u) return false;

  switch (rule.mode) {
    case "domain": {
      const host = u.hostname.toLowerCase();
      const t = value.toLowerCase().replace(/^\*\./, "");
      return host === t || host.endsWith("." + t);
    }
    case "exact":
      return url === value;
    case "contains":
      return url.includes(value);
    case "glob":
      return globToRegex(value).test(url);
    case "regex":
      try { return new RegExp(value).test(url); } catch { return false; }
    default:
      return false;
  }
}

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")
                      .replace(/\*/g, ".*")
                      .replace(/\?/g, ".");
  return new RegExp("^" + escaped + "$");
}

function findPerDomainRule(ctx, rules) {
  return rules.find(r => matchRule(ctx, r));
}

function isWhitelisted(ctx, settings) {
  return settings.whitelist.some(r => matchRule(ctx, r));
}

function isBlacklisted(ctx, settings) {
  return settings.blacklist.some(r => matchRule(ctx, r));
}

async function buildTabContext(tab) {
  let groupTitle = null;
  try {
    if (tab && tab.groupId !== undefined && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      const g = await chrome.tabGroups.get(tab.groupId);
      groupTitle = g?.title ?? null;
    }
  } catch { /* group may have been removed mid-sweep — ignore */ }
  return { url: tab?.url || "", groupTitle };
}

function isInternalUrl(url) {
  if (!url) return true;
  return url.startsWith("chrome://") ||
         url.startsWith("chrome-extension://") ||
         url.startsWith("edge://") ||
         url.startsWith("about:") ||
         url.startsWith("file://") ||
         url.startsWith("devtools://") ||
         url === "" ||
         url.startsWith(SUSPENDED_PAGE);
}

function isAlreadySuspended(url) {
  return url && url.startsWith(SUSPENDED_PAGE);
}

// ─── Suspension decision logic ──────────────────────────────────────────────

async function getEffectiveTimeoutMs(ctx, settings) {
  // Per-domain (or per-group) rule wins
  const rule = findPerDomainRule(ctx, settings.perDomainRules);
  if (rule) {
    if (rule.neverSuspend) return Infinity;
    if (typeof rule.suspendAfterMinutes === "number") {
      return rule.suspendAfterMinutes * 60_000;
    }
  }

  let minutes = settings.suspendAfterMinutes;

  // Schedule (work hours)
  if (settings.schedule.enabled) {
    const now = new Date();
    const day = now.getDay(); // 0=Sun
    const inDays = settings.schedule.days.includes(day);
    const inHours = isInTimeRange(now, settings.schedule.workStart, settings.schedule.workEnd);
    minutes = (inDays && inHours)
      ? settings.schedule.workSuspendAfterMinutes
      : settings.schedule.offSuspendAfterMinutes;
  }

  // Battery aware
  if (settings.power.aggressiveOnBattery) {
    const onBattery = await isOnBattery();
    if (onBattery) {
      minutes = Math.min(minutes, settings.power.batterySuspendAfterMinutes);
    }
  }

  // Memory pressure
  if (settings.memoryPressure.enabled) {
    const free = await getFreeMemoryMB();
    if (free !== null && free < settings.memoryPressure.thresholdMB) {
      minutes = Math.min(minutes, settings.memoryPressure.aggressiveSuspendAfterMinutes);
    }
  }

  // Smart learning
  if (settings.smart.enabled) {
    const usage = await getUsage();
    const key = usageKeyFor(ctx.url);
    const entry = usage[key];
    if (entry && entry.visits >= settings.smart.visitsThreshold) {
      // Frequent — be lazy about suspending
      minutes *= settings.smart.frequentTabMultiplier;
    } else if (entry && entry.visits === 1) {
      // Probably one-off — reclaim sooner
      minutes *= settings.smart.rareTabMultiplier;
    }
  }

  return Math.max(1, minutes) * 60_000;
}

function isInTimeRange(date, startStr, endStr) {
  const [sh, sm] = startStr.split(":").map(Number);
  const [eh, em] = endStr.split(":").map(Number);
  const cur = date.getHours() * 60 + date.getMinutes();
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

async function isOnBattery() {
  // Use the Battery Status API. Some Chrome builds expose it on service workers,
  // others don't (it's been deprecated for fingerprinting concerns). If it's
  // unavailable we fall back to assuming the device is plugged in, which means
  // battery-aware features simply don't trigger — a safe default.
  try {
    if (typeof navigator !== "undefined" && typeof navigator.getBattery === "function") {
      const battery = await navigator.getBattery();
      return battery.charging === false;
    }
  } catch (_) { /* ignore */ }
  return false;
}

async function getFreeMemoryMB() {
  try {
    const info = await chrome.system.memory.getInfo();
    return Math.round(info.availableCapacity / (1024 * 1024));
  } catch (_) { return null; }
}

function usageKeyFor(url) {
  const u = parseUrl(url);
  if (!u) return url;
  // Group by host + first path segment so different sections of a site count separately
  const seg = (u.pathname || "/").split("/").filter(Boolean)[0] || "";
  return `${u.hostname}/${seg}`;
}

async function shouldSuspend(tab, settings) {
  if (!settings.enabled) return { suspend: false, reason: "disabled" };
  if (!tab.url || isInternalUrl(tab.url)) return { suspend: false, reason: "internal-url" };
  if (isAlreadySuspended(tab.url)) return { suspend: false, reason: "already-suspended" };
  if (tab.discarded) return { suspend: false, reason: "already-discarded" };

  // Build a single context object used by every rule list below.
  const ctx = await buildTabContext(tab);

  // Force-suspend via blacklist bypasses some checks but not internal/active
  const forced = isBlacklisted(ctx, settings);

  if (!forced) {
    if (isWhitelisted(ctx, settings)) return { suspend: false, reason: "whitelisted" };

    const ns = settings.neverSuspend;
    if (ns.pinned && tab.pinned) return { suspend: false, reason: "pinned" };
    if (ns.audible && tab.audible) return { suspend: false, reason: "audible" };

    const state = tabState.get(tab.id);
    if (ns.hasFormInput && state?.hasFormInput) return { suspend: false, reason: "form-input" };

    if (ns.offline && !navigator.onLine) return { suspend: false, reason: "offline" };

    if (ns.onPowerSource) {
      const onBattery = await isOnBattery();
      if (!onBattery) return { suspend: false, reason: "on-power" };
    }

    if (ns.inTabGroup && tab.groupId !== undefined && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      return { suspend: false, reason: "in-group" };
    }

    if (ns.activeInAnyWindow && tab.active) return { suspend: false, reason: "active" };

    if (ns.onlyTabInWindow) {
      const tabsInWindow = await chrome.tabs.query({ windowId: tab.windowId });
      if (tabsInWindow.length === 1) return { suspend: false, reason: "only-tab" };
    }

    const perDomain = findPerDomainRule(ctx, settings.perDomainRules);
    if (perDomain && perDomain.neverSuspend) {
      return { suspend: false, reason: "per-domain-skip" };
    }
  }

  const last = tabState.get(tab.id)?.lastActiveAt ?? Date.now();
  const idleMs = Date.now() - last;
  const timeoutMs = await getEffectiveTimeoutMs(ctx, settings);
  if (idleMs < timeoutMs) {
    return { suspend: false, reason: "not-idle-enough", idleMs, timeoutMs };
  }
  return { suspend: true, idleMs, timeoutMs };
}

// ─── Suspend & restore actions ──────────────────────────────────────────────

const WAKE_ALARM_PREFIX = "tabzen-wake-";
const STORAGE_KEY_SNOOZED = "snoozedTabs"; // { [tabId]: { wakeAt, originalUrl } }

async function getSnoozed() {
  return (await chrome.storage.local.get(STORAGE_KEY_SNOOZED))[STORAGE_KEY_SNOOZED] || {};
}
async function setSnoozed(map) {
  await chrome.storage.local.set({ [STORAGE_KEY_SNOOZED]: map });
}

function buildSuspendedUrl(tab, opts = {}) {
  const params = new URLSearchParams();
  params.set("u", tab.url);
  if (tab.title) params.set("t", tab.title);
  if (tab.favIconUrl) params.set("f", tab.favIconUrl);
  params.set("at", String(Date.now()));
  if (opts.wakeAt) params.set("w", String(opts.wakeAt));
  return `${SUSPENDED_PAGE}#${params.toString()}`;
}

async function scheduleWake(tabId, wakeAt) {
  // chrome.alarms.create overwrites any alarm with the same name, so re-snoozing
  // the same tab safely replaces the previous schedule.
  chrome.alarms.create(WAKE_ALARM_PREFIX + tabId, { when: wakeAt });
  const map = await getSnoozed();
  map[tabId] = { wakeAt, scheduledAt: Date.now() };
  await setSnoozed(map);
}

async function clearWake(tabId) {
  try { await chrome.alarms.clear(WAKE_ALARM_PREFIX + tabId); } catch {}
  const map = await getSnoozed();
  if (map[tabId]) {
    delete map[tabId];
    await setSnoozed(map);
  }
}

async function suspendTab(tabId, opts = {}) {
  const settings = await getSettings();
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return false; }
  if (!tab.url || isInternalUrl(tab.url) || isAlreadySuspended(tab.url)) return false;

  const useDiscard = (opts.strategy ?? settings.strategy) === "discard";
  const wakeAt = (typeof opts.wakeAt === "number" && opts.wakeAt > Date.now()) ? opts.wakeAt : null;

  if (useDiscard) {
    try {
      await chrome.tabs.discard(tabId);
    } catch (e) { return false; }
  } else {
    const suspendedUrl = buildSuspendedUrl(tab, { wakeAt });
    try {
      await chrome.tabs.update(tabId, { url: suspendedUrl });
    } catch (e) { return false; }
  }

  // Schedule the wake alarm AFTER the suspend lands, so the right tab id is associated.
  if (wakeAt) await scheduleWake(tabId, wakeAt);

  // Stats
  const stats = await getStats();
  const host = parseUrl(tab.url)?.hostname || "unknown";
  const byDomain = stats.byDomain || {};
  byDomain[host] = byDomain[host] || { suspensions: 0, lastSuspendedAt: 0 };
  byDomain[host].suspensions++;
  byDomain[host].lastSuspendedAt = Date.now();

  // Heuristic: assume an average page costs ~80MB. Better than nothing.
  const estimatedSaved = stats.estimatedBytesSaved + 80 * 1024 * 1024;
  await setStats({
    totalSuspensions: stats.totalSuspensions + 1,
    estimatedBytesSaved: estimatedSaved,
    byDomain
  });

  if (settings.notifications.onMilestone) {
    const gbSaved = Math.floor(estimatedSaved / (1024 * 1024 * 1024));
    if (gbSaved > stats.lastMilestoneGB && gbSaved > 0) {
      await setStats({ lastMilestoneGB: gbSaved });
      try {
        chrome.notifications.create({
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title: "TabZen milestone",
          message: `You've reclaimed about ${gbSaved}GB of memory across ${stats.totalSuspensions + 1} suspensions.`,
          priority: 0
        });
      } catch (_) { /* ignore in some environments */ }
    }
  }
  return true;
}

async function restoreTab(tabId) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { await clearWake(tabId); return false; }
  if (!tab.url) return false;
  if (isAlreadySuspended(tab.url)) {
    const params = new URLSearchParams(tab.url.split("#")[1] || "");
    const original = params.get("u");
    if (original) {
      await chrome.tabs.update(tabId, { url: original });
      await clearWake(tabId);
      const stats = await getStats();
      await setStats({ totalRestorations: stats.totalRestorations + 1 });
      return true;
    }
  } else if (tab.discarded) {
    await chrome.tabs.reload(tabId);
    await clearWake(tabId);
    const stats = await getStats();
    await setStats({ totalRestorations: stats.totalRestorations + 1 });
    return true;
  }
  await clearWake(tabId);
  return false;
}

async function suspendOtherWindows(currentWindowId) {
  // Suspends every suspendable tab that's NOT in the given window.
  const tabs = await chrome.tabs.query({});
  let count = 0;
  for (const tab of tabs) {
    if (tab.windowId === currentWindowId) continue;
    if (await suspendTab(tab.id)) count++;
  }
  return count;
}

async function suspendAllInWindow(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  let count = 0;
  for (const t of tabs) {
    if (!t.active) {
      const ok = await suspendTab(t.id);
      if (ok) count++;
    }
  }
  return count;
}

async function restoreAll() {
  const tabs = await chrome.tabs.query({});
  let count = 0;
  for (const t of tabs) {
    if (t.url && (isAlreadySuspended(t.url) || t.discarded)) {
      const ok = await restoreTab(t.id);
      if (ok) count++;
    }
  }
  return count;
}

// ─── Lifecycle: install, alarms, events ─────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  // Seed settings + stats if missing
  const cur = await chrome.storage.local.get([STORAGE_KEY_SETTINGS, STORAGE_KEY_STATS]);
  if (!cur[STORAGE_KEY_SETTINGS]) {
    await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: DEFAULT_SETTINGS });
  }
  if (!cur[STORAGE_KEY_STATS]) {
    await chrome.storage.local.set({ [STORAGE_KEY_STATS]: { ...DEFAULT_STATS, installedAt: Date.now() } });
  }

  chrome.alarms.create(ALARM_TICK, { periodInMinutes: ALARM_TICK_PERIOD_MIN });
  buildContextMenus();

  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html?welcome=1") });
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_TICK, { periodInMinutes: ALARM_TICK_PERIOD_MIN });
  buildContextMenus();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_TICK) {
    await runSweep();
    return;
  }
  if (alarm.name.startsWith(WAKE_ALARM_PREFIX)) {
    const tabId = Number(alarm.name.slice(WAKE_ALARM_PREFIX.length));
    if (Number.isFinite(tabId)) {
      // restoreTab clears the snoozed entry whether or not the restore succeeds
      // (e.g. tab closed while snoozed).
      await restoreTab(tabId);
    }
  }
});

async function runSweep() {
  const settings = await getSettings();
  if (!settings.enabled) return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const decision = await shouldSuspend(tab, settings);
    if (decision.suspend) {
      await suspendTab(tab.id);
    }
  }
}

// Tab activity tracking
chrome.tabs.onActivated.addListener(({ tabId }) => {
  const s = tabState.get(tabId) || {};
  s.lastActiveAt = Date.now();
  tabState.set(tabId, s);
  recordVisit(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const s = tabState.get(tabId) || {};
  if (changeInfo.audible !== undefined) s.audible = changeInfo.audible;
  if (changeInfo.status === "complete") s.lastActiveAt = s.lastActiveAt || Date.now();
  tabState.set(tabId, s);

  // If user navigates a suspended tab away, that's a manual restore.
  if (changeInfo.url && !isAlreadySuspended(changeInfo.url)) {
    // nothing, already handled by restore action
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  clearWake(tabId);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (active) {
      const s = tabState.get(active.id) || {};
      s.lastActiveAt = Date.now();
      tabState.set(active.id, s);
    }
  } catch (_) { /* ignore */ }
});

async function recordVisit(tabId) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  if (!tab.url || isInternalUrl(tab.url)) return;
  const usage = await getUsage();
  const key = usageKeyFor(tab.url);
  const e = usage[key] || { visits: 0, totalDwellMs: 0, lastVisitAt: 0 };
  e.visits++;
  e.lastVisitAt = Date.now();
  usage[key] = e;
  // Cap usage table size to ~1000 entries to bound storage
  const keys = Object.keys(usage);
  if (keys.length > 1000) {
    const sorted = keys.sort((a, b) => (usage[a].lastVisitAt || 0) - (usage[b].lastVisitAt || 0));
    for (const k of sorted.slice(0, keys.length - 1000)) delete usage[k];
  }
  await setUsage(usage);
}

// ─── Commands (keyboard shortcuts) ──────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  switch (command) {
    case "suspend-current-tab":
      if (active) await suspendTab(active.id);
      break;
    case "restore-current-tab":
      if (active) await restoreTab(active.id);
      break;
    case "suspend-all-tabs":
      if (active) await suspendAllInWindow(active.windowId);
      break;
    case "restore-all-tabs":
      await restoreAll();
      break;
    case "whitelist-current-domain":
      if (active?.url) {
        const host = parseUrl(active.url)?.hostname;
        if (host) {
          const settings = await getSettings();
          if (!settings.whitelist.some(r => r.mode === "domain" && r.value === host)) {
            settings.whitelist.push({ mode: "domain", value: host, enabled: true });
            await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: settings });
          }
        }
      }
      break;
    case "open-options":
      chrome.runtime.openOptionsPage();
      break;
  }
});

// ─── Context menus ──────────────────────────────────────────────────────────

function buildContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "tabzen-suspend", title: "Suspend this tab", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabzen-suspend-others", title: "Suspend all other tabs", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabzen-suspend-window", title: "Suspend all tabs in this window", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabzen-restore-all", title: "Restore all suspended tabs", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabzen-sep", type: "separator", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabzen-whitelist-domain", title: "Never suspend this domain", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabzen-whitelist-url", title: "Never suspend this exact URL", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabzen-sep2", type: "separator", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "tabzen-options", title: "TabZen settings…", contexts: ["page", "action"] });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  switch (info.menuItemId) {
    case "tabzen-suspend":
      await suspendTab(tab.id);
      break;
    case "tabzen-suspend-others": {
      const tabs = await chrome.tabs.query({ windowId: tab.windowId });
      for (const t of tabs) if (t.id !== tab.id) await suspendTab(t.id);
      break;
    }
    case "tabzen-suspend-window":
      await suspendAllInWindow(tab.windowId);
      break;
    case "tabzen-restore-all":
      await restoreAll();
      break;
    case "tabzen-whitelist-domain": {
      const host = parseUrl(tab.url)?.hostname;
      if (!host) break;
      const settings = await getSettings();
      if (!settings.whitelist.some(r => r.mode === "domain" && r.value === host)) {
        settings.whitelist.push({ mode: "domain", value: host, enabled: true });
        await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: settings });
      }
      break;
    }
    case "tabzen-whitelist-url": {
      const settings = await getSettings();
      if (!settings.whitelist.some(r => r.mode === "exact" && r.value === tab.url)) {
        settings.whitelist.push({ mode: "exact", value: tab.url, enabled: true });
        await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: settings });
      }
      break;
    }
    case "tabzen-options":
      chrome.runtime.openOptionsPage();
      break;
  }
});

// ─── Messaging ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "get-settings":
          sendResponse({ ok: true, data: await getSettings() });
          break;
        case "set-settings":
          sendResponse({ ok: true, data: await setSettings(msg.patch || {}) });
          break;
        case "replace-settings":
          await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: msg.settings });
          sendResponse({ ok: true });
          break;
        case "get-stats":
          sendResponse({ ok: true, data: await getStats() });
          break;
        case "reset-stats":
          await chrome.storage.local.set({ [STORAGE_KEY_STATS]: { ...DEFAULT_STATS, installedAt: Date.now() } });
          sendResponse({ ok: true });
          break;
        case "suspend-tab":
          sendResponse({ ok: await suspendTab(msg.tabId, { strategy: msg.strategy, wakeAt: msg.wakeAt }) });
          break;
        case "restore-tab":
          sendResponse({ ok: await restoreTab(msg.tabId) });
          break;
        case "suspend-current":
          {
            const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
            sendResponse({ ok: t ? await suspendTab(t.id, { wakeAt: msg.wakeAt }) : false });
          }
          break;
        case "suspend-all-window":
          sendResponse({ ok: true, count: await suspendAllInWindow(msg.windowId) });
          break;
        case "suspend-other-windows":
          {
            // Suspend everything not in this window. Useful when focusing on one task.
            const count = await suspendOtherWindows(msg.windowId);
            sendResponse({ ok: true, count });
          }
          break;
        case "count-other-window-tabs":
          {
            // For UI: how many candidate tabs live in other windows, and across how many windows?
            const tabs = await chrome.tabs.query({});
            let tabCount = 0;
            const winIds = new Set();
            for (const t of tabs) {
              if (t.windowId === msg.windowId) continue;
              if (!t.url || isInternalUrl(t.url) || isAlreadySuspended(t.url) || t.discarded) continue;
              tabCount++;
              winIds.add(t.windowId);
            }
            sendResponse({ ok: true, count: tabCount, windowCount: winIds.size });
          }
          break;
        case "count-other-tabs-in-window":
          {
            // For UI: how many suspendable tabs in this window are NOT the active one?
            // Used by the "Suspend all other tabs in this window" affordance.
            const tabs = await chrome.tabs.query({ windowId: msg.windowId });
            let n = 0;
            for (const t of tabs) {
              if (t.active) continue;
              if (!t.url || isInternalUrl(t.url) || isAlreadySuspended(t.url) || t.discarded) continue;
              n++;
            }
            sendResponse({ ok: true, count: n });
          }
          break;
        case "get-snoozed":
          sendResponse({ ok: true, data: await getSnoozed() });
          break;
        case "restore-all":
          sendResponse({ ok: true, count: await restoreAll() });
          break;
        case "list-tabs":
          {
            const tabs = await chrome.tabs.query(msg.query || {});
            sendResponse({ ok: true, data: tabs.map(t => ({
              id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl,
              active: t.active, pinned: t.pinned, audible: t.audible,
              discarded: t.discarded, windowId: t.windowId, groupId: t.groupId,
              suspended: !!(t.url && isAlreadySuspended(t.url)),
              lastActiveAt: tabState.get(t.id)?.lastActiveAt || null
            })) });
          }
          break;
        case "report-form-input":
          {
            const tabId = sender.tab?.id;
            if (tabId !== undefined) {
              const s = tabState.get(tabId) || {};
              s.hasFormInput = !!msg.hasFormInput;
              tabState.set(tabId, s);
            }
            sendResponse({ ok: true });
          }
          break;
        case "save-session": {
          const { [STORAGE_KEY_SESSIONS]: existing = [] } = await chrome.storage.local.get(STORAGE_KEY_SESSIONS);
          existing.push({ name: msg.name || `Session ${new Date().toLocaleString()}`, savedAt: Date.now(), tabs: msg.tabs });
          await chrome.storage.local.set({ [STORAGE_KEY_SESSIONS]: existing });
          sendResponse({ ok: true });
          break;
        }
        case "list-sessions": {
          const { [STORAGE_KEY_SESSIONS]: existing = [] } = await chrome.storage.local.get(STORAGE_KEY_SESSIONS);
          sendResponse({ ok: true, data: existing });
          break;
        }
        case "delete-session": {
          const { [STORAGE_KEY_SESSIONS]: existing = [] } = await chrome.storage.local.get(STORAGE_KEY_SESSIONS);
          const next = existing.filter((_, i) => i !== msg.index);
          await chrome.storage.local.set({ [STORAGE_KEY_SESSIONS]: next });
          sendResponse({ ok: true });
          break;
        }
        case "memory-info":
          sendResponse({ ok: true, freeMB: await getFreeMemoryMB(), onBattery: await isOnBattery() });
          break;
        default:
          sendResponse({ ok: false, error: "unknown-message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // keep channel open for async sendResponse
});
