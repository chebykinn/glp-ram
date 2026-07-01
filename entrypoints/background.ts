import { getSettings, isWhitelisted } from '@/lib/settings';
import { planKeep } from '@/lib/policy';
import type { ContentToBackground, Settings, TabInfo } from '@/lib/types';

import type { Tabs, Runtime } from 'webextension-polyfill';
type Tab = Tabs.Tab;
type Sender = Runtime.MessageSender;

const ALARM = 'glpram-scan';
const STATE_KEY = 'glpram:tabs';
const SCAN_KEY = 'glpram:scan'; // { at, periodMs } for the dashboard scan clock
// 30s is Chrome's minimum alarm period; fine granularity for working-set checks.
const SCAN_PERIOD_MIN = 0.5;

// Fallback notification icon (1x1 transparent PNG) so chrome.notifications never
// fails for pages that pass no icon.
const FALLBACK_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// ---- live state (mirrored to storage.session so it survives SW restarts) ----
const tabs = new Map<number, TabInfo>();
// chrome.notifications id -> tabId, so clicking a relayed notification focuses it.
const notifTab = new Map<string, number>();
let notifSeq = 0;
// In-memory settings cache so onCreated can defer synchronously (no awaited
// getSettings race that the MV3 service worker can drop mid-event).
let settingsCache: Settings | null = null;

function now(): number {
  return Date.now();
}

function getInfo(tabId: number): TabInfo {
  let info = tabs.get(tabId);
  if (!info) {
    info = { lastActive: now(), state: 'active', media: false, notify: false, push: false, everActive: false };
    tabs.set(tabId, info);
  }
  return info;
}

function snapshot(): Record<number, TabInfo> {
  const obj: Record<number, TabInfo> = {};
  for (const [id, info] of tabs) obj[id] = info;
  return obj;
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persistState(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    browser.storage.session.set({ [STATE_KEY]: snapshot() }).catch(() => {});
  }, 1000);
}

/** Write state immediately (used for kill reasons, which the SW may otherwise
 *  lose if it's terminated before the debounced write fires). */
function persistNow(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  return browser.storage.session.set({ [STATE_KEY]: snapshot() }).then(
    () => {},
    () => {},
  );
}

async function restoreState(): Promise<void> {
  try {
    const stored = await browser.storage.session.get(STATE_KEY);
    const obj = stored[STATE_KEY] as Record<number, TabInfo> | undefined;
    if (obj) for (const [id, info] of Object.entries(obj)) tabs.set(Number(id), info);
  } catch {
    /* session storage may be empty on cold start */
  }
}

// ---- url helpers ------------------------------------------------------------

/**
 * Only ordinary, fully-formed web pages are managed; never our own pages,
 * chrome://, or transient/garbage URLs (e.g. a mid-typing omnibox value that
 * isn't a real URL — suspending those produces broken `xn--…` placeholder
 * navigations). The URL must parse cleanly as http(s) with a real hostname.
 */
function isManageable(url: string | undefined): boolean {
  if (!url || /\s/.test(url)) return false; // a real URL never contains whitespace
  if (url.startsWith(browser.runtime.getURL(''))) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  // Reject hostnames that aren't real (no dot and not localhost) — these come
  // from typed search text Chrome hasn't resolved to a navigation yet.
  if (!u.hostname || (!u.hostname.includes('.') && u.hostname !== 'localhost')) return false;
  return true;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ---- feature 1: defer loading of new background tabs ------------------------

function suspendedUrlFor(url: string, title: string): string {
  return (
    browser.runtime.getURL('/suspended.html') +
    '?u=' +
    encodeURIComponent(url) +
    '&t=' +
    encodeURIComponent(title)
  );
}

/**
 * Defer a brand-new BACKGROUND tab by redirecting it to the lightweight
 * placeholder (a single tabs.update — same tab id, no churn). It loads the real
 * page when you switch to it. We NEVER discard here (discard reassigns the id
 * and thrashes) and we only ever touch a fresh, still-loading background tab.
 */
function onTabCreated(tab: Tab, settings: Settings): void {
  if (!settings.enabled || !settings.deferLoad) return;
  if (tab.active || tab.id == null) return; // the foreground tab is never deferred
  if (tab.discarded) return; // restored / lazy tab — leave it alone
  if (tab.status === 'complete') return; // already loaded — not a fresh tab
  if (tabs.get(tab.id)?.everLoaded) return; // we've already let it load
  const url = tab.pendingUrl || tab.url;
  if (!isManageable(url) || isWhitelisted(url, settings.whitelist)) return;
  const info = getInfo(tab.id);
  info.state = 'suspended';
  void browser.tabs.update(tab.id, { url: suspendedUrlFor(url!, tab.title || hostOf(url!)) }).catch(() => {});
}

// ---- the periodic scan ------------------------------------------------------

async function scan(): Promise<void> {
  const settings = await getSettings();
  if (!settings.enabled) return;

  const allTabs = await browser.tabs.query({});
  // The one true "active" tab: active in the focused window. Only it stays
  // recency-fresh and is spared as active; background windows' active tabs age.
  const [focusedTab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  const focusedId = focusedTab?.id;
  const live = new Set<number>();
  const t = now();
  const entries: { tab: Tab; info: TabInfo }[] = [];

  for (const tab of allTabs) {
    if (tab.id == null) continue;
    live.add(tab.id);
    if (!isManageable(tab.url)) continue;

    const info = getInfo(tab.id);
    info.focused = tab.id === focusedId;
    if (tab.active) {
      if (info.focused) info.lastActive = t; // only the focused tab stays fresh
      info.state = tab.discarded ? 'unloaded' : 'active';
      info.everActive = true;
    } else if (tab.discarded) {
      info.state = 'unloaded';
    }
    if (!tab.discarded) {
      info.everLoaded = true; // currently showing real content; never re-suspend it
      entries.push({ tab, info });
    }
  }

  // Drop bookkeeping for tabs that no longer exist.
  for (const id of [...tabs.keys()]) if (!live.has(id)) tabs.delete(id);

  // Keep only the most-recently-used tabs loaded; discard (unload) the rest.
  const plan = planKeep(entries, settings);
  for (const id of plan.evict) await killTab(id, 'oom');

  // Record this sweep so the dashboard can show a countdown to the next one.
  void browser.storage.session
    .set({ [SCAN_KEY]: { at: Date.now(), periodMs: SCAN_PERIOD_MIN * 60_000 } })
    .catch(() => {});

  persistState();
}

/** Discard a tab's renderer process ("kill"); never closes it. Returns success. */
async function killTab(tabId: number, reason: 'oom' | 'manual'): Promise<boolean> {
  try {
    // discard() may return the tab with a NEW id — record the reason on that id.
    const discarded = await browser.tabs.discard(tabId);
    const newId = discarded?.id ?? tabId;
    if (newId !== tabId) {
      const prev = tabs.get(tabId);
      if (prev) tabs.set(newId, prev);
      tabs.delete(tabId);
    }
    const info = getInfo(newId);
    info.state = 'unloaded';
    info.unloadReason = reason;
    console.log('[glp-ram] killed tab', tabId, newId !== tabId ? `(now ${newId})` : '', 'reason=', reason);
    await persistNow(); // persist the reason now; the SW may die before a debounce
    return true;
  } catch (e) {
    console.warn('[glp-ram] discard failed', tabId, e);
    return false; // already discarded or non-discardable
  }
}

// ---- feature 4: notification relay ------------------------------------------

async function handleMessage(
  message: ContentToBackground,
  sender: Sender,
): Promise<void> {
  // Manual kill from the dashboard/popup carries its own tabId (no sender.tab).
  if (message.type === 'KILL_TAB') {
    await killTab(message.tabId, 'manual');
    return;
  }

  const tabId = sender.tab?.id;
  if (tabId == null) return;
  const info = getInfo(tabId);

  switch (message.type) {
    case 'MEDIA_STATE':
      info.media = message.active;
      persistState();
      break;
    case 'NOTIFICATION_CAPABLE':
      info.notify = true;
      persistState();
      break;
    case 'PUSH_STATE':
      info.push = message.active;
      persistState();
      break;
    case 'INPUT_STATE': {
      // Aggregate across frames: hasInput is true if ANY frame has unsaved text.
      const fid = sender.frameId ?? 0;
      const frames = (info.inputFrames ??= {});
      if (message.hasInput) frames[fid] = true;
      else delete frames[fid];
      info.hasInput = Object.keys(frames).length > 0;
      persistState();
      break;
    }
    case 'PLAYBACK_STATE': {
      const fid = sender.frameId ?? 0;
      const frames = (info.playbackFrames ??= {});
      if (message.active) frames[fid] = true;
      else delete frames[fid];
      info.hasPlayback = Object.keys(frames).length > 0;
      persistState();
      break;
    }
    case 'SHOW_NOTIFICATION': {
      info.notify = true;
      const settings = await getSettings();
      if (settings.relayNotifications) {
        const id = `glpram:${tabId}:${notifSeq++}`;
        notifTab.set(id, tabId);
        try {
          await browser.notifications.create(id, {
            type: 'basic',
            title: message.title || hostOf(sender.tab?.url || ''),
            message: message.options.body || '',
            iconUrl: message.options.icon || FALLBACK_ICON,
          });
        } catch {
          /* malformed icon etc.; retry with the fallback icon */
          try {
            await browser.notifications.create(id, {
              type: 'basic',
              title: message.title || '',
              message: message.options.body || '',
              iconUrl: FALLBACK_ICON,
            });
          } catch {
            /* give up silently */
          }
        }
      }
      persistState();
      break;
    }
  }
}

// ---- startup: adopt already-open tabs ---------------------------------------

async function injectIntoOpenTabs(): Promise<void> {
  const open = await browser.tabs.query({});
  for (const tab of open) {
    if (tab.id == null || !isManageable(tab.url) || tab.discarded) continue;
    // Ensure the tab is tracked, but keep its restored recency — clobbering
    // lastActive here would reset the working-set order on every SW restart.
    const info = getInfo(tab.id);
    if (tab.active) info.lastActive = now();
    try {
      await browser.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['/content-scripts/relay.js'],
      });
      await browser.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        files: ['/content-scripts/hooks.js'],
      });
    } catch {
      /* restricted page; skip */
    }
  }
  persistState();
}

export default defineBackground(() => {
  console.log('[glp-ram] background service worker started');
  void restoreState().then(async () => {
    await injectIntoOpenTabs();
    await scan(); // populate the working set + scan clock immediately, not after ~30s
  });

  // Keep settings cached so onCreated can defer synchronously (the MV3 worker
  // can drop an awaited getSettings mid-event).
  void getSettings().then((s) => (settingsCache = s));
  browser.storage.onChanged.addListener((_c, area) => {
    if (area === 'sync') void getSettings().then((s) => (settingsCache = s));
  });

  browser.alarms.create(ALARM, { periodInMinutes: SCAN_PERIOD_MIN });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void scan();
  });

  // Defer new background tabs to the placeholder (feature 1).
  browser.tabs.onCreated.addListener((tab) => {
    if (settingsCache) onTabCreated(tab, settingsCache);
    else void getSettings().then((s) => onTabCreated(tab, s));
  });

  // Fallback: tabs opened in another window or via window.open fire onCreated
  // BEFORE their URL is known, so onCreated can't defer them. Catch them on
  // their first 'loading' tick instead. Suspend only (no discard), and never
  // touch a tab that has already loaded real content or is already a placeholder.
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'loading') return;
    const s = settingsCache;
    if (!s || !s.enabled || !s.deferLoad) return;
    if (tab.active || tab.discarded) return;
    const info = getInfo(tabId);
    if (info.everLoaded || info.state === 'suspended') return; // loaded / already deferred
    const url = changeInfo.url || tab.pendingUrl || tab.url;
    if (!isManageable(url) || isWhitelisted(url, s.whitelist)) return;
    info.state = 'suspended';
    void browser.tabs
      .update(tabId, { url: suspendedUrlFor(url!, tab.title || hostOf(url!)) })
      .catch(() => {});
  });

  browser.tabs.onActivated.addListener(({ tabId }) => {
    for (const [id, i] of tabs) if (id !== tabId) i.focused = false; // single focused tab
    const info = getInfo(tabId);
    info.lastActive = now();
    info.state = 'active';
    info.everActive = true;
    info.everLoaded = true; // it's showing real content now; never re-suspend it
    info.focused = true;
    info.unloadReason = undefined; // reloads on activation; clear the kill reason
    persistState();
  });

  // Switching windows doesn't fire onActivated — track the focused window's
  // active tab so background windows' active tabs stop counting as "active".
  browser.windows.onFocusChanged.addListener((windowId) => {
    void browser.tabs.query({ active: true, windowId }).then(([tab]) => {
      const fid = tab?.id;
      for (const [id, i] of tabs) i.focused = id === fid;
      if (fid != null) {
        const info = getInfo(fid);
        info.lastActive = now();
        info.everActive = true;
      }
      persistState();
    });
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    tabs.delete(tabId);
    for (const [nid, tid] of notifTab) if (tid === tabId) notifTab.delete(nid);
    persistState();
  });

  // Discarding a tab can change its id. onReplaced fires with the new and old
  // ids — migrate our bookkeeping (incl. the kill reason) so the dashboard can
  // still attribute the discard correctly instead of showing "not by glp-ram".
  browser.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    const info = tabs.get(removedTabId);
    if (info) {
      tabs.set(addedTabId, info);
      tabs.delete(removedTabId);
    }
    for (const [nid, tid] of notifTab) if (tid === removedTabId) notifTab.set(nid, addedTabId);
    console.log('[glp-ram] tab replaced', removedTabId, '->', addedTabId,
      'reason carried=', info?.unloadReason);
    void persistNow();
  });

  browser.runtime.onMessage.addListener((message, sender) => {
    void handleMessage(message as ContentToBackground, sender);
    return false;
  });

  // Clicking a relayed notification focuses the originating tab.
  browser.notifications.onClicked.addListener((id) => {
    const tabId = notifTab.get(id);
    if (tabId == null) return;
    void browser.tabs.update(tabId, { active: true }).then((tab) => {
      if (tab?.windowId != null) void browser.windows.update(tab.windowId, { focused: true });
    });
    void browser.notifications.clear(id);
    notifTab.delete(id);
  });
  browser.notifications.onClosed.addListener((id) => notifTab.delete(id));
});
