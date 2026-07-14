<p align="center">
  <img src="assets/glp-ram-icon.svg" alt="glp-ram icon" width="128" height="128" />
</p>

# glp-ram

[**Install from the Chrome Web Store →**](https://chromewebstore.google.com/detail/glp-ram/aaphgiadoaoofglkffofblcefdnnnjhn)

A Chrome (MV3) extension that takes over tab memory management and loading. It
keeps only a small working set of tabs loaded — the focused tab plus your most
recently used ones — and unloads the rest to free RAM, while never touching tabs
that play media, use the mic/camera, hold unsaved text, or fire notifications.
New background tabs are deferred to a placeholder until you actually open them.

## What it does

1. **Defer loading until active.** A tab opened in the background never starts
   loading the real page. It's redirected to a lightweight placeholder
   (`suspended.html`) that holds the destination URL and only navigates to it
   when you switch to the tab. The **first** background tab you open is an
   exception — it loads eagerly (it's the "just opened in background" working-set
   slot); further background tabs are deferred until that one is visited.
2. **Keep a small working set loaded.** glp-ram keeps the `keepLoaded` (default
   **3**) most-recently-used tabs loaded — typically the active tab, the previous
   tab, and a freshly-opened background tab — and **discards** (`tabs.discard`,
   never closes) everything else. Discarded tabs keep their place in the tab
   strip and reload when you return. There is no idle timer and no memory-MB
   budget: it's purely the recency-ranked working set.
3. **Protect media tabs.** Tabs playing sound, using the microphone / camera /
   screen-share, or with **unmuted** audio/video you started and paused part-way
   are never discarded. (Muted autoplay/background video is ignored — only media
   you actually started counts.) Protected tabs are kept loaded *on top of* the
   working-set count.
4. **Notification relay.** A single service worker watches each page's
   `Notification` hook and shows notifications through `chrome.notifications`.
   Clicking a relayed notification focuses the originating tab.

## How it works

- **`background.ts`** — the single service worker. Runs a `chrome.alarms` scan
  every 30s that maintains the working set (feature 2), handles tab lifecycle
  events for feature 1, and relays notifications for feature 4.
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
  a **Status** (loaded / discards next scan / kept because protected / how it was
  unloaded), and its **Keep order** — the recency rank (#1 = active); ranks beyond
  `keepLoaded` are discarded unless protected.

The table is click-to-sort. Summary cards show total tab JS heap, the keep-loaded
count and system free memory, and a **Next scan** countdown to the next sweep.

**Unsaved-text protection:** once you've actually typed/edited, a tab with a
non-empty `<input>`, `<textarea>`, or `contenteditable` / WYSIWYG editor (across
iframes and open shadow DOM) is never discarded — discarding would lose the text.
Shown with an "input" flag. It only protects the **specific fields you edited**
(tracked per element on a trusted `input`/`keyup`/`paste`), so pages that ship
pre-filled/readonly fields, search boxes, or selection checkboxes you never
touched aren't falsely protected.

**Always-unload list:** hostnames in Settings → *Always-unload* are unloaded when
inactive **regardless of every protection** (media, audio, notifications, unsaved
input) and take precedence over the whitelist. The active tab is still never
unloaded. Shown with a "force-unload" flag.

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
on, it keeps **only non-push notification tabs** loaded (never discarded);
push-subscribed tabs are discarded normally because their notifications survive.
(A non-push notification tab is still discarded if it's on the always-unload list.)

Separately, the single service worker relays page-JS `new Notification(...)` calls
through `chrome.notifications` while the tab is alive (feature 4).

## The working set

glp-ram keeps the `keepLoaded` (default **3**) most-recently-used tabs loaded and
discards the rest. Recency is ranked by last-activation: the active tab is always
#1, the tab you just left is #2, and a freshly-opened background tab (which counts
as "just used") slots in near the top — so the common working set is *active +
previous + one background tab*. Every scan (30s), any tab ranked beyond
`keepLoaded` is discarded (`tabs.discard`, never closed) unless it's protected.

Always kept, regardless of rank:
- the **active tab** of every window,
- **media** tabs (sound, mic/cam/screen, or unmuted audio/video you paused),
- tabs with **unsaved text** you edited,
- **non-push notification** tabs (must stay loaded to fire),
- **whitelisted** hosts.

The **always-unload** list bypasses all of those (see below).

There is no memory-MB budget and no idle timer — eviction is purely the
recency-ranked working set. The dashboard still shows each tab's JS heap
(`performance.memory`, approximate: JS heap only, ~10 MB granularity) and system
free memory (`chrome.system.memory`) for information, but they don't drive
eviction. (Chrome exposes no per-tab/per-process memory API on the stable channel
— `chrome.processes` is Dev-channel only — so a true memory budget can't be
measured reliably anyway.)

## Develop / build

```sh
bun install
bun run dev       # launches Chrome with the extension loaded
bun run build     # outputs .output/chrome-mv3
bun run zip       # Web Store upload zip -> .output/glp-ram-<version>-chrome.zip
bun run crx       # builds, then packs a signed .crx -> .output/glp-ram.crx
bun run typecheck
```

`bun run crx` signs with `key.pem` (gitignored). It's generated on first run and
reused after — keep it, since the key determines the extension's stable ID. To
install the `.crx`, drag `.output/glp-ram.crx` onto `chrome://extensions` with
Developer mode on (Chrome may still warn / disable non-Web-Store crx's depending
on policy; **Load unpacked** on `.output/chrome-mv3` is the reliable dev path).

## Load unpacked

1. `bun run build`
2. Go to `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select `.output/chrome-mv3`.

Tune everything (keep-loaded count, protections, whitelist) from the
extension's **Settings** page or the toolbar popup.
