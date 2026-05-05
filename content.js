// TabZen content script — detects "dirty" form state so the suspender
// knows when to leave a tab alone. Lightweight and passive.
(() => {
  if (window.__tabzen_injected) return;
  window.__tabzen_injected = true;

  let dirty = false;
  let lastReported = null;

  function report(state) {
    if (state === lastReported) return;
    lastReported = state;
    try {
      chrome.runtime.sendMessage({ type: "report-form-input", hasFormInput: state });
    } catch (_) { /* extension might be reloading */ }
  }

  function isMeaningfulInput(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT") {
      const type = (el.type || "").toLowerCase();
      // Ignore search/checkboxes/radios — they don't represent unsaved data we'd lose
      if (["checkbox", "radio", "submit", "button", "reset", "hidden"].includes(type)) return false;
      return (el.value || "").length > 0;
    }
    if (tag === "TEXTAREA") return (el.value || "").length > 0;
    if (el.isContentEditable) return (el.innerText || "").trim().length > 0;
    return false;
  }

  function checkDirty() {
    const fields = document.querySelectorAll("input, textarea, [contenteditable=''], [contenteditable='true']");
    for (const f of fields) {
      if (isMeaningfulInput(f)) return true;
    }
    return false;
  }

  function onChange() {
    const next = checkDirty();
    if (next !== dirty) {
      dirty = next;
      report(dirty);
    }
  }

  // Throttle: a single rAF chain is enough; input events fire often.
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      onChange();
    });
  }

  document.addEventListener("input", schedule, true);
  document.addEventListener("change", schedule, true);

  // Submitting a form clears the dirty state.
  document.addEventListener("submit", () => {
    setTimeout(() => { dirty = false; report(false); }, 0);
  }, true);

  // Initial check after first paint
  if (document.readyState === "complete" || document.readyState === "interactive") {
    schedule();
  } else {
    window.addEventListener("DOMContentLoaded", schedule, { once: true });
  }
})();
