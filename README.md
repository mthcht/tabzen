# TabZen - Advanced Tab Suspender

Reclaim RAM by intelligently suspending inactive tabs. Per-domain rules, regex whitelists, battery-aware scheduling, smart usage learning, and a calm suspended page. Manifest V3, local-only, no telemetry.


<img width="392" height="641" alt="Capture d&#39;écran 2026-05-06 002354" src="https://github.com/user-attachments/assets/b83f8187-b27a-45d8-8339-a0e3269a579f" />

<img width="1217" height="679" alt="Capture d&#39;écran 2026-05-06 002603" src="https://github.com/user-attachments/assets/6ffcac58-b417-47ff-9776-c98e1ba59644" />

<img width="1231" height="894" alt="Capture d&#39;écran 2026-05-06 002443" src="https://github.com/user-attachments/assets/ee9a49c6-0300-4a06-ac6c-5c23f42552af" />

<img width="1141" height="870" alt="Capture d&#39;écran 2026-05-06 002502" src="https://github.com/user-attachments/assets/e10e7ba5-fb3c-4420-97c4-6462e2452aae" />

<img width="1245" height="895" alt="Capture d&#39;écran 2026-05-06 002509" src="https://github.com/user-attachments/assets/636dcc14-bf8d-4f2b-83c8-a49e189e53ee" />

<img width="1177" height="870" alt="Capture d&#39;écran 2026-05-06 002453" src="https://github.com/user-attachments/assets/5d5d4279-6953-4c6c-85e5-e51a88758a27" />


---

## Install From the WebStore

https://chromewebstore.google.com/detail/tabzen-%E2%80%94-advanced-tab-sus/gdnekjhfpkbnhipehcngckafgnnmdoll

## Install (developer mode)

1. Open `chrome://extensions` in Chrome / Edge / Brave / Arc.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select the `tabzen/` folder.
4. Pin the extension to your toolbar. Open the popup or right-click the icon → **Options** to configure.

Requires Chrome 116 or newer.

---

## What makes it different

Most tab suspenders give you a single timeout and a whitelist. TabZen gives you a real configuration surface - every knob below is exposed, and they compose.

| Capability | The Great Suspender | Marvellous Suspender | Auto Tab Discard | **TabZen** |
|---|:---:|:---:|:---:|:---:|
| Configurable timer | ✓ | ✓ | ✓ | ✓ |
| Domain whitelist | ✓ | ✓ | ✓ | ✓ |
| Glob / regex match modes | - | - | partial | **✓ (5 modes)** |
| Per-domain custom timer | - | - | - | **✓** |
| Per–tab-group custom timer | - | - | - | **✓** |
| In-popup idle tab triage list | - | - | - | **✓** |
| **Snooze tab (auto-restore at time)** | - | - | - | **✓** |
| **Suspend all other tabs in this window** | - | - | - | **✓** |
| **Suspend all in other windows** | - | - | - | **✓** |
| Time-of-day schedule | - | - | - | **✓** |
| Battery-aware timer | - | - | - | **✓** |
| Memory-pressure trigger | - | - | - | **✓** |
| Usage-frequency learning | - | - | - | **✓** |
| Form-input detection | ✓ | ✓ | ✓ | ✓ |
| Tab-group awareness | - | - | - | **✓** |
| Two suspend strategies (replace vs native discard) | - | - | partial | **✓** |
| Named session snapshots | ✓ | ✓ | - | ✓ |
| JSON config import / export | - | - | - | **✓** |

### Tab triage from the popup

Open the toolbar popup and you see every idle tab in the current window, sorted oldest first, with the idle time shown next to each. One tap on the ⊘ icon suspends a single tab; one tap on **Suspend all N** suspends the whole list. Click anywhere else on a row to jump to that tab. Idle time is colour-coded - over an hour goes warm amber, over fifteen minutes goes lighter amber - so the targets for cleanup jump out at a glance. The current tab also gets a single contextual primary button: "Suspend this tab" or "Restore this tab" depending on its state, with an inline estimate of memory saved. A small star icon next to the current tab toggles domain protection without leaving the popup.

### Suspension strategies

- **Replace page** (default) - swaps the tab to a calm placeholder page that shows favicon, title, and last-visited time. Click anywhere to restore. Frees the most memory.
- **Native discard** - uses Chrome's `tabs.discard()`. Tab keeps its title and favicon in the strip; reloads from network when re-activated.

### Never-suspend conditions

Compose any combination: pinned · audible · has form input · offline · last tab in window · only tab · on AC power · part of a tab group.

### Match modes for whitelist / blacklist / per-domain rules

Every rule first picks a **target**:

- **URL** - match against the tab's full URL using one of the modes below.
- **Tab group** - match against the title of the Chrome tab group the tab belongs to. Useful for "Reading list" → never suspend, or "Research" → suspend after 6 hours.

URL modes:

- **Domain** - `github.com` matches `github.com` and `*.github.com`
- **Contains** - substring against full URL
- **Exact** - full URL equality
- **Glob** - `https://*.notion.so/*`
- **Regex** - full JavaScript regex against the URL

Tab-group modes:

- **Exact** - group title equality (case-insensitive)
- **Contains** - substring against group title

Existing tab group titles auto-complete in the value field.

### Smart suspension

When enabled, TabZen tracks visit frequency per domain (locally, capped at 1000 entries) and stretches the timer for tabs you return to often, shortens it for ones you rarely revisit. Tunable bounds.

### Schedule

Different timers for work hours vs off hours, with a day-of-week selector. Useful if you want aggressive suspension during deep-work blocks and lazy suspension on weekends.

### Power & memory

- Aggressive timer when on battery (configurable multiplier).
- Optional memory-pressure trigger: when system free RAM drops below your threshold, the next sweep suspends more eagerly.

---

## Keyboard shortcuts

| Action | Default |
|---|---|
| Suspend current tab | `Alt+S` |
| Restore current tab | `Alt+R` |
| Suspend all other tabs in window | `Alt+Shift+S` |
| Restore all suspended tabs | `Alt+Shift+R` |
| Whitelist current domain | `Alt+W` |
| Open TabZen options | `Alt+O` |

Rebind any of them at `chrome://extensions/shortcuts`.

---

## Privacy

Everything runs locally. No analytics, no remote config, no network requests other than the ones the browser makes for Google Fonts on the suspended page (you can self-host the fonts by editing `suspended/suspended.css` if that bothers you). Settings, statistics, sessions, and the usage table all live in `chrome.storage.local` on your machine.

---

## File layout

```
tabzen/
├── manifest.json
├── background.js          # service worker: alarms, decisions, messaging
├── content.js             # form-input detector
├── icons/                 # 16/32/48/128 px
├── popup/                 # toolbar popup UI
├── options/               # full settings page
└── suspended/             # the placeholder page swapped in for suspended tabs
```

---

## Development notes

- MV3 service worker - no persistent background page; state rehydrates from `chrome.storage` on each wake.
- The activity ledger (`Map<tabId, lastActiveTimestamp>`) is in-memory and reseeds from `chrome.tabs.query` after wake; this is fine because the worst case is one extra full timer cycle.
- Suspended URLs use the hash, not the query string, so the original URL is never sent anywhere - `chrome-extension://…/suspended/suspended.html#u=<original>&t=<title>&f=<favicon>&at=<lastActive>`.
- Form-input detection runs only on tabs that haven't been marked dirty yet, throttled via `requestAnimationFrame`.

---

## License

MIT.
