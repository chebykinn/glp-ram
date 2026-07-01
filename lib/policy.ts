// Single source of truth for "what happens to this tab". Both the background
// scan and the dashboard import these so their decisions and their displayed
// state can never drift apart.
import { hostMatches, isWhitelisted } from './settings';
import type { Settings, TabInfo } from './types';
import type { Tabs } from 'webextension-polyfill';

type Tab = Tabs.Tab;

/** Tabs with A/V (sound, playing/paused media, mic, camera, screen): never unload. */
export function isMediaProtected(tab: Tab, info: TabInfo, s: Settings): boolean {
  if (s.protectAudible && (tab.audible || info.hasPlayback)) return true;
  if (s.protectMedia && info.media) return true;
  return false;
}

/** Why a tab is exempt from unloading entirely (not just held loaded). */
export type SpareReason = 'active' | 'whitelist' | 'audible' | 'capture' | null;

export function spareReason(tab: Tab, info: TabInfo, s: Settings): SpareReason {
  // "active" only counts when the tab's window is focused. A background window's
  // active tab is just a normal tab for ranking/eviction purposes.
  if (info.focused) return 'active';
  if (isWhitelisted(tab.url, s.whitelist)) return 'whitelist';
  if (s.protectAudible && (tab.audible || info.hasPlayback)) return 'audible';
  if (s.protectMedia && info.media) return 'capture';
  return null;
}

/**
 * Can this tab be discarded to keep the working set small? True when it isn't
 * protected. NOTE: a window's *active* (selected) tab can't be discarded by
 * Chrome at all — `tabs.discard` refuses it — so we never target any active tab
 * (otherwise it would show "discards next scan" forever and never die). The
 * `focused` flag only affects ranking and the "active" label, not eligibility.
 */
export function isDiscardable(tab: Tab, info: TabInfo, s: Settings): boolean {
  if (tab.active) return false; // Chrome can't discard a window's active tab
  if (tab.discarded || info.state === 'unloaded') return false; // already gone
  if (hostMatches(tab.url, s.alwaysUnload)) return true; // force-unload list
  if (isWhitelisted(tab.url, s.whitelist)) return false;
  if (isMediaProtected(tab, info, s)) return false;
  if (s.protectNotifications && info.notify && !info.push) return false; // notif hold
  if (info.hasInput) return false; // unsaved text
  return true;
}

export interface TabPolicy {
  /** Already unloaded / discarded. */
  discarded: boolean;
  /** Fully exempt from unload, and why. */
  spared: SpareReason;
  /** Held loaded so non-push notifications keep firing. */
  notifHold: boolean;
  /** Protected from discard because it has unsaved text. */
  inputHold: boolean;
  /** On the always-unload list: protections bypassed. */
  forced: boolean;
  /** Not protected — eligible to be discarded to keep the working set small. */
  discardable: boolean;
}

export function analyze(tab: Tab, info: TabInfo, s: Settings): TabPolicy {
  const discarded = !!tab.discarded || info.state === 'unloaded';
  const forced = hostMatches(tab.url, s.alwaysUnload);
  const spared: SpareReason = forced ? (info.focused ? 'active' : null) : spareReason(tab, info, s);
  const notifHold = !forced && s.protectNotifications && info.notify && !info.push;
  const inputHold = !forced && !!info.hasInput;
  return { discarded, spared, notifHold, inputHold, forced, discardable: isDiscardable(tab, info, s) };
}

// ---- keep-loaded working set ------------------------------------------------

/**
 * Recency used to rank tabs for the working set: when the tab was last the
 * foreground tab. The focused window's active tab has the freshest value (the
 * scan keeps only it bumped), so it ranks first globally; background windows'
 * active tabs age normally and don't hog the budget.
 */
function recencyOf(info: TabInfo): number {
  return info.lastActive;
}

export interface KeepPlan {
  /** tabId -> recency rank (0 = most recent). */
  rank: Map<number, number>;
  /** tabIds to discard now (beyond the working set, or force-unload). */
  evict: number[];
}

/**
 * Keep the `keepLoaded` most-recently-used tabs loaded GLOBALLY (across all
 * windows) — typically the focused window's active tab plus the most-recent
 * others; everything past that is discarded if it isn't protected. Force-unload
 * (always-unload) tabs are evicted regardless of rank. `entries` should be the
 * live (non-discarded) manageable tabs; discarded tabs don't occupy a slot.
 * (Background windows' active tabs are still protected from discard — Chrome
 * can't discard an active tab — so they may stay loaded beyond the cap.)
 */
export function planKeep(entries: { tab: Tab; info: TabInfo }[], s: Settings): KeepPlan {
  // Guard: never let a missing/garbage value collapse the working set.
  const keep = Math.max(1, Math.floor(s.keepLoaded) || 3);
  const rank = new Map<number, number>();
  const evict: number[] = [];

  const ranked = [...entries].sort((a, b) => recencyOf(b.info) - recencyOf(a.info));
  ranked.forEach((e, i) => {
    const id = e.tab.id!;
    rank.set(id, i);
    if (!isDiscardable(e.tab, e.info, s)) return;
    // Discard if beyond the global working set, or on the always-unload list.
    if (i >= keep || hostMatches(e.tab.url, s.alwaysUnload)) evict.push(id);
  });
  return { rank, evict };
}
