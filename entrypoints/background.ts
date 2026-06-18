import { getSettings, isWhitelisted } from '@/lib/settings';
import { isMediaProtected } from '@/lib/policy';
import { measureTabHeaps, getSystemMemory } from '@/lib/memory';
import type { ContentToBackground, Settings, TabInfo } from '@/lib/types';

import type { Tabs, Runtime } from 'webextension-polyfill';
type Tab = Tabs.Tab;
type Sender = Runtime.MessageSender;

const ALARM = 'glpram-scan';
const STATE_KEY = 'glpram:tabs';
const SCAN_KEY = 'glpram:scan'; // { at, periodMs } for the dashboard OOM clock
// 30s is Chrome's minimum alarm period; fine granularity for idle/OOM checks.
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

/** Only ordinary web pages are managed; never our own pages or chrome://. */
function isManageable(url: string | undefined): boolean {
  if (!url) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (url.startsWith(browser.runtime.getURL(''))) return false;
  return true;
}

function suspendedUrlFor(url: string, title: string): string {
  return (
    browser.runtime.getURL('/suspended.html') +
    '?u=' +
    encodeURIComponent(url) +
    '&t=' +
    encodeURIComponent(title)
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ---- feature 1: defer loading of background tabs ----------------------------

/** Redirect a background tab to the placeholder, holding the real URL. */
function suspend(tabId: number, url: string, title: string): void {
  const info = getInfo(tabId);
  info.state = 'suspended'; // set before the async update so concurrent events dedupe
  info.suspendedUrl = url;
  info.lastActive = now();
  console.log('[glp-ram] suspending tab', tabId, '->', url);
  void browser.tabs
    .update(tabId, { url: suspendedUrlFor(url, title) })
    .catch((e) => console.warn('[glp-ram] suspend update failed', tabId, e));
  persistState();
}

function onTabCreated(tab: Tab, settings: Settings): void {
  const url = tab.pendingUrl || tab.url;
  console.log('[glp-ram] onCreated id=', tab.id, 'active=', tab.active, 'url=', url,
    'enabled=', settings.enabled, 'deferLoad=', settings.deferLoad);
  if (!settings.enabled || !settings.deferLoad) return;
  if (tab.active || tab.id == null) return;
  if (!isManageable(url) || isWhitelisted(url, settings.whitelist)) {
    console.log('[glp-ram] onCreated skip: not manageable/whitelisted', url);
    return;
  }
  suspend(tab.id, url!, tab.title || hostOf(url!));
}

// ---- the periodic scan ------------------------------------------------------

async function scan(): Promise<void> {
  const settings = await getSettings();
  if (!settings.enabled) return;

  const allTabs = await browser.tabs.query({});
  const live = new Set<number>();
  const unloadMs = settings.unloadDelayMin * 60_000;
  const t = now();

  for (const tab of allTabs) {
    if (tab.id == null) continue;
    live.add(tab.id);
    if (!isManageable(tab.url)) continue;

    const info = getInfo(tab.id);
    const whitelisted = isWhitelisted(tab.url, settings.whitelist);

    // Active tab: keep its clock fresh.
    if (tab.active) {
      info.lastActive = t;
      info.state = tab.discarded ? 'unloaded' : 'active';
      info.everActive = true;
      continue;
    }

    // Untouchable tabs: audio/mic/cam/screen, whitelisted, and non-push
    // notification tabs (must stay loaded to fire notifications). Never unload.
    const notifHold = settings.protectNotifications && info.notify && !info.push;
    if (whitelisted || isMediaProtected(tab, info, settings) || notifHold) {
      info.lastActive = t;
      continue;
    }

    if (tab.discarded) {
      info.state = 'unloaded';
      continue;
    }

    // Unload after the idle timeout, but never a tab with unsaved text.
    if (t - info.lastActive >= unloadMs && !info.hasInput) {
      await killTab(tab.id, 'idle');
    }
  }

  // Drop bookkeeping for tabs that no longer exist.
  for (const id of [...tabs.keys()]) if (!live.has(id)) tabs.delete(id);

  if (settings.oomEnabled) await enforceMemoryLimit(allTabs, settings);

  // Record this sweep so the dashboard can show a countdown to the next one.
  void browser.storage.session
    .set({ [SCAN_KEY]: { at: Date.now(), periodMs: SCAN_PERIOD_MIN * 60_000 } })
    .catch(() => {});

  persistState();
}

// ---- feature 5: OOM guard ---------------------------------------------------

/** Tabs that may be killed under memory pressure: not active, not media, not whitelisted. */
function oomCandidates(allTabs: Tab[], settings: Settings): Tab[] {
  return allTabs.filter((tab) => {
    if (tab.id == null || tab.discarded || !isManageable(tab.url)) return false;
    if (tab.active) return false;
    if (isWhitelisted(tab.url, settings.whitelist)) return false;
    const info = getInfo(tab.id);
    if (info.hasInput) return false; // never discard a tab with unsaved text
    return !isMediaProtected(tab, info, settings);
  });
}

async function enforceMemoryLimit(allTabs: Tab[], settings: Settings): Promise<void> {
  const candidates = oomCandidates(allTabs, settings);
  if (candidates.length === 0) return;

  // Per-tab memory on stable = JS heap (performance.memory). Measure all live
  // managed tabs for the total-heap budget, then evict only eligible candidates.
  const liveManaged = allTabs.filter((t) => t.id != null && !t.discarded && isManageable(t.url));
  const heaps = await measureTabHeaps(liveManaged.map((t) => t.id!));
  let totalHeap = 0;
  for (const v of heaps.values()) totalHeap += v;

  const budgetBytes = settings.memoryLimitMB * 1024 * 1024;
  const minFreeBytes = settings.minFreeMemoryMB * 1024 * 1024;
  const sys = await getSystemMemory();
  // minFreeMemoryMB <= 0 disables the system-free safety net.
  const lowFree = settings.minFreeMemoryMB > 0 && !!sys && sys.availableCapacity < minFreeBytes;

  // Trigger if total tab heap is over budget, OR free system memory is low.
  if (totalHeap <= budgetBytes && !lowFree) return;
  console.log(
    '[glp-ram] OOM triggered — totalHeap=',
    Math.round(totalHeap / 1048576),
    'MB / budget',
    settings.memoryLimitMB,
    'MB; free=',
    sys ? Math.round(sys.availableCapacity / 1048576) : 'n/a',
    'MB / min',
    settings.minFreeMemoryMB,
    'MB',
  );

  // Heaviest heap first; tie-break longest idle. Cap kills per scan so a stale
  // system-memory reading can't cascade into evicting everything.
  const victims = [...candidates].sort(
    (a, b) =>
      (heaps.get(b.id!) || 0) - (heaps.get(a.id!) || 0) ||
      getInfo(a.id!).lastActive - getInfo(b.id!).lastActive,
  );
  const MAX_PER_SCAN = 5;
  let killed = 0;
  let freed = 0;
  for (const tab of victims) {
    if (killed >= MAX_PER_SCAN) break;
    const overBudget = totalHeap - freed > budgetBytes;
    let stillLow = false;
    if (lowFree) {
      const cur = await getSystemMemory();
      stillLow = !!cur && cur.availableCapacity < minFreeBytes;
    }
    if (!overBudget && !stillLow) break;
    if (await killTab(tab.id!, 'oom')) {
      killed++;
      freed += heaps.get(tab.id!) || 0;
    }
  }
}

/** Discard a tab's renderer process ("kill"); never closes it. Returns success. */
async function killTab(tabId: number, reason: 'idle' | 'oom'): Promise<boolean> {
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
    getInfo(tab.id).lastActive = now();
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
  void restoreState().then(() => injectIntoOpenTabs());

  // Prime + keep the settings cache fresh (used for synchronous deferral).
  void getSettings().then((s) => {
    settingsCache = s;
    console.log('[glp-ram] settings loaded: enabled=', s.enabled, 'deferLoad=', s.deferLoad);
  });
  browser.storage.onChanged.addListener((_changes, area) => {
    if (area === 'sync') void getSettings().then((s) => (settingsCache = s));
  });

  browser.alarms.create(ALARM, { periodInMinutes: SCAN_PERIOD_MIN });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void scan();
  });

  browser.tabs.onCreated.addListener((tab) => {
    if (settingsCache) onTabCreated(tab, settingsCache);
    else void getSettings().then((s) => onTabCreated(tab, s));
  });

  browser.tabs.onActivated.addListener(({ tabId }) => {
    const info = getInfo(tabId);
    info.lastActive = now();
    info.state = 'active';
    info.everActive = true;
    info.unloadReason = undefined; // reloads on activation; clear the kill reason
    persistState();
  });

  // Fallback deferral: some background tabs (opened in another window, via
  // window.open, or by another app) fire onCreated before their URL is known, so
  // catch them when they start loading — but only tabs the user has never viewed.
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'loading') return;
    const s = settingsCache;
    if (!s || !s.enabled || !s.deferLoad || tab.active) return;
    const info = getInfo(tabId);
    if (info.everActive || info.state === 'suspended') return;
    const url = changeInfo.url || tab.pendingUrl || tab.url;
    if (!isManageable(url) || isWhitelisted(url, s.whitelist)) return;
    console.log('[glp-ram] onUpdated defer id=', tabId, 'url=', url);
    suspend(tabId, url!, tab.title || hostOf(url!));
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
