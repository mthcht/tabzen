// TabZen suspended page — reads tab info from the URL hash, renders the
// card, applies user theme, and restores the tab on any interaction.
(() => {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const url = params.get("u") || "about:blank";
  const titleParam = params.get("t") || "Untitled tab";
  const fav = params.get("f") || "";
  const at = Number(params.get("at")) || Date.now();
  const wakeAt = Number(params.get("w")) || 0;

  document.title = titleParam;

  // Set favicon to original site's favicon
  const faviconLink = document.querySelector("link[rel='icon']");
  if (fav) {
    try {
      const newLink = document.createElement("link");
      newLink.rel = "icon";
      newLink.href = fav;
      newLink.type = "image/x-icon";
      faviconLink.replaceWith(newLink);
    } catch (_) { /* ignore */ }
  }

  // Apply settings (theme, accent, custom message, hint preferences)
  chrome.runtime.sendMessage({ type: "get-settings" }, (res) => {
    if (!res?.ok) return;
    const a = res.data.appearance || {};
    const root = document.documentElement;

    // Theme
    let theme = a.theme;
    if (theme === "auto") {
      theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    root.setAttribute("data-theme", theme || "dark");

    // Accent
    if (a.accent) root.style.setProperty("--accent", a.accent);

    // Toggle hint visibility
    if (a.showRestoreHint === false) {
      const h = document.getElementById("hint");
      if (h) h.style.display = "none";
    }

    // Last-visited line
    if (a.showLastVisited !== false) {
      const lv = document.getElementById("lastvisit");
      lv.innerHTML = `<b>Last active</b> · ${formatRelative(at)} · ${formatExact(at)}`;
    } else {
      const lv = document.getElementById("lastvisit");
      lv.style.visibility = "hidden";
    }

    // Custom message
    if (a.customMessage) {
      const c = document.getElementById("custom");
      c.textContent = a.customMessage;
      c.hidden = false;
    }

    // Auto-restore on focus (when user switches to the tab)
    if (a.autoRestoreOnFocus) {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") restore();
      }, { once: true });
    }
  });

  // Render text content
  document.getElementById("title").textContent = titleParam;
  const urlEl = document.getElementById("url");
  urlEl.textContent = prettifyUrl(url);
  urlEl.href = url;
  urlEl.title = url;

  // Favicon image element
  const img = document.getElementById("favicon");
  if (fav) {
    img.src = fav;
    img.onerror = () => { img.style.display = "none"; };
  } else {
    img.style.display = "none";
  }

  // Snooze badge (only when this suspension has a scheduled wake time)
  if (wakeAt > Date.now()) {
    const badge = document.getElementById("snooze-badge");
    const txt = document.getElementById("snooze-text");
    if (badge && txt) {
      txt.textContent = `Wakes ${formatWake(wakeAt)}`;
      badge.title = `Auto-restoring at ${formatExact(wakeAt)}`;
      badge.hidden = false;
    }
  }

  function restore() {
    window.location.replace(url);
  }

  // Interaction → restore
  document.getElementById("restore").addEventListener("click", (e) => {
    e.stopPropagation();
    restore();
  });

  document.getElementById("url").addEventListener("click", (e) => {
    // Let middle-click / new-tab modifiers behave normally; plain click → restore in place
    if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) {
      e.preventDefault();
      restore();
    }
  });

  document.body.addEventListener("click", (e) => {
    // Click anywhere except the URL/footer button (handled above)
    if (e.target.closest("a, button")) return;
    restore();
  });

  document.addEventListener("keydown", (e) => {
    // Don't hijack when user is using browser shortcuts
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Tab") return;
    restore();
  });

  function prettifyUrl(u) {
    try {
      const x = new URL(u);
      return x.host + (x.pathname === "/" ? "" : x.pathname) + (x.search || "");
    } catch { return u; }
  }

  function formatRelative(ts) {
    const diffSec = Math.floor((Date.now() - ts) / 1000);
    if (diffSec < 60) return "just now";
    const m = Math.floor(diffSec / 60);
    if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
    const d = Math.floor(h / 24);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }

  function formatExact(ts) {
    try {
      return new Date(ts).toLocaleString(undefined, {
        weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit"
      });
    } catch { return ""; }
  }

  function formatWake(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = ts - Date.now();
    if (diffMs < 60 * 60_000) {
      const m = Math.max(1, Math.round(diffMs / 60_000));
      return `in ${m} min`;
    }
    if (diffMs < 12 * 60 * 60_000) {
      const h = Math.round(diffMs / 3_600_000);
      return `in ${h}h`;
    }
    const sameDay = d.toDateString() === now.toDateString();
    const tomorrow = new Date(now.getTime() + 24 * 3_600_000).toDateString() === d.toDateString();
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (sameDay)   return `today at ${time}`;
    if (tomorrow)  return `tomorrow at ${time}`;
    const day = d.toLocaleDateString(undefined, { weekday: "short" });
    return `${day} at ${time}`;
  }
})();
