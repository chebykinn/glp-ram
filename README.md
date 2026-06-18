# glp-ram

A Chrome (MV3) extension that takes over tab memory management and loading.

## What it does

1. **Defer loading until active.** A tab opened in the background never starts
   loading the real page. It's redirected to a lightweight placeholder
   (`suspended.html`) that holds the destination URL and only navigates to it
   when you switch to the tab.
2. **Unload idle tabs.** After `unloadDelayMin` minutes of inactivity a background
   tab is unloaded (`tabs.discard`), keeping its place in the tab strip and
   reloading when you return. (There is intentionally no JS-freeze "pause" stage:
   the only way for an extension to freeze a tab's JS is the `chrome.debugger`
   API, which shows a persistent "debugging this browser" banner.)
3. **Protect media tabs.** Tabs playing sound, using the microphone / camera /
   screen-share, or with **unmuted** audio/video you started and paused part-way
   are never unloaded. (Muted autoplay/background video is ignored — only media
   you actually started counts.)
4. **Notification relay.** A single service worker watches each page's
   `Notification` hook and shows notifications through `chrome.notifications`.
   Clicking a relayed notification focuses the originating tab.
5. **OOM guard.** Under memory pressure, idle tabs are **killed** (discarded —
   never closed). Mic/cam/screen/audio tabs, the active tab, and whitelisted
   sites are spared. Scoring depends on what Chrome exposes (see below).

## How it works

- **`background.ts`** — the single service worker. Runs a `chrome.alarms` scan
  every 30s that drives features 2 and 5, handles tab lifecycle events for
  feature 1, and relays notifications for feature 4.
- **`hooks.content.ts`** (MAIN world, `document_start`) — wraps
  `navigator.mediaDevices.getUserMedia` / `getDisplayMedia` to detect live
  mic/cam/screen capture, and wraps `window.Notification` to detect/relay
  notifications. Because MAIN-world scripts can't use `chrome.*`, it talks to…
- **`relay.content.ts`** (ISOLATED world) — bridges the hook's messages to the
  service worker, reports the tab's JS heap (`performance.memory`), and reports
  whether the page has unsaved text.
- **`suspended/`** — the deferred-load placeholder page.
- **`dashboard/`** — full-page view of every tab and process (see below).
- **`popup/`**, **`options/`** — status UI and settings.
- **`lib/policy.ts`** — the single source of truth for "what happens to this tab
  and when", imported by both the background scan and the dashboard so their
  decisions and countdowns can't drift apart.

## Dashboard

Open it from the toolbar popup → **Open dashboard** (or navigate to
`chrome-extension://<id>/dashboard.html`). It auto-refreshes every 2s and shows:

- **Tabs** — title/host, current state (active / unloaded / suspended), protection
  flags (audio, capture, notify, push, input), per-tab memory (JS heap, `~`),
  **how long until it's unloaded** ("alive for") — and for unloaded tabs **how it
  was unloaded** (killed by OOM / idle timer / by the browser) — plus its **OOM
  rank** (#1 = first to be killed; "spared" if protected/active/whitelisted).

The table is click-to-sort. Summary cards show total tab JS heap vs the budget,
system free / total memory, and a **Next OOM check** countdown to the next sweep.

**Unsaved-text protection:** a tab with any non-empty `<input>`, `<textarea>`, or
`contenteditable` / WYSIWYG editor (detected across iframes and open shadow DOM)
is never unloaded *or* OOM-killed — discarding would lose the text. Shown with an
"input" flag in the dashboard.

(There is no `beforeunload`/"Leave site?" detection: reliably determining whether
a page would actually block requires *running* its `beforeunload` handler, which
has destructive side effects — e.g. it disconnects a live Google Meet call.)

## Notifications + unloading (the nuance)

Whether a tab can still notify after being unloaded depends on *how* it notifies:

- **Web Push** (`PushManager` + service worker — Gmail, Slack, Discord, WhatsApp
  Web, etc.): notifications **keep working even when the tab is unloaded or fully
  closed**. A push wakes the *site's own service worker*, which the browser runs
  independently of any tab.
- **Page-JS `new Notification(...)`** with no push subscription: the page must be
  alive, since an unloaded tab runs no JavaScript.

So glp-ram detects push subscriptions (it hooks `PushManager.subscribe` and checks
for an existing subscription once the SW is active). With `protectNotifications`
on, it keeps **only non-push notification tabs** loaded (never unloaded);
push-subscribed tabs are unloaded normally because their notifications survive.
Under genuine memory pressure the OOM guard (feature 5) *may* still kill even a
non-push notification tab — memory pressure wins.

Separately, the single service worker relays page-JS `new Notification(...)` calls
through `chrome.notifications` while the tab is alive (feature 4).

## Memory measurement & the OOM guard

Chrome exposes **no per-tab/per-process memory API** to extensions on the stable
channel (the `chrome.processes` API is Dev-channel only and can't even be
*requested* on stable without the extension failing to load). glp-ram uses the two
signals that *are* available on stable:

- **Per-tab memory** = each tab's JS heap, read from its content script via
  Chrome's `performance.memory.usedJSHeapSize`. This is **approximate** — JS heap
  only (no DOM/images/GPU) and quantized to ~10 MB on non-cross-origin-isolated
  pages — but it's the only per-tab signal available. The dashboard shows it with
  a `~` prefix.
- **System memory** = `chrome.system.memory` (free / total physical RAM).

The OOM guard evicts (kills = `tabs.discard`, never closes) the **heaviest-heap**
eligible tabs — tie-broken by longest idle — when **either**:
1. the **total tab JS heap exceeds `memoryLimitMB`** (the memory budget, default
   1536 MB = 1.5 GB), or
2. **free system memory drops below `minFreeMemoryMB`** (safety net, default 0 = off).

Kills are capped per scan so a momentary dip can't cascade. Mic/cam/screen/audio
tabs, the active tab, and whitelisted sites are always spared. Because the OOM
guard runs every scan, a tab can be unloaded **before** its idle timer if memory
is tight — the dashboard's "Alive for" column shows whether a tab was *killed by
OOM* vs *unloaded (idle timer)*.

## Develop / build

```sh
bun install
bun run dev       # launches Chrome with the extension loaded
bun run build     # outputs .output/chrome-mv3
bun run typecheck
```

## Load unpacked

1. `bun run build`
2. Go to `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select `.output/chrome-mv3`.

Tune everything (delays, protections, memory budget, whitelist) from the
extension's **Settings** page or the toolbar popup.
