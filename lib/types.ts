// Shared types for glp-ram.

/** User-configurable behaviour. Persisted in chrome.storage.sync. */
export interface Settings {
  /** Master switch. When false the extension does nothing. */
  enabled: boolean;

  // ---- Feature 1: defer loading -------------------------------------------
  /** Redirect background-opened tabs to a placeholder until they're activated. */
  deferLoad: boolean;

  // ---- Feature 2: unload idle tabs -----------------------------------------
  /** Minutes of inactivity before a tab is unloaded (discarded). */
  unloadDelayMin: number;

  // ---- Feature 3: protection ----------------------------------------------
  /** Never pause/unload tabs that are producing sound. */
  protectAudible: boolean;
  /** Never pause/unload tabs using mic / camera / screen-share. */
  protectMedia: boolean;
  /** Don't *unload* tabs that use the Notification API (they may still be paused). */
  protectNotifications: boolean;

  // ---- Feature 4: notification relay ---------------------------------------
  /** Route page `new Notification(...)` through our single service worker. */
  relayNotifications: boolean;

  // ---- Feature 5: OOM guard ------------------------------------------------
  /** Kill (discard) idle tabs under memory pressure. */
  oomEnabled: boolean;
  /**
   * Memory budget in MB. Evict when the total tab JS heap (summed
   * performance.memory) exceeds this. Heaviest-heap eligible tabs killed first.
   */
  memoryLimitMB: number;
  /**
   * Safety net (0 = off): also evict when free system memory
   * (chrome.system.memory) drops below this many MB, regardless of the budget.
   * Off by default — it evicts based on whole-system RAM, which is mostly other
   * apps, so killing tabs rarely helps.
   */
  minFreeMemoryMB: number;

  /** Hostnames that are never touched by any feature. */
  whitelist: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  deferLoad: true,
  unloadDelayMin: 30,
  protectAudible: true,
  protectMedia: true,
  protectNotifications: true,
  relayNotifications: true,
  oomEnabled: true,
  memoryLimitMB: 1536,
  minFreeMemoryMB: 0,
  whitelist: [],
};

/** Live, rebuildable per-tab bookkeeping. Mirrored to chrome.storage.session. */
export interface TabInfo {
  /** Epoch ms of the last moment this tab was active (its idle clock origin). */
  lastActive: number;
  state: 'active' | 'unloaded' | 'suspended';
  /** Tab is using mic / camera / screen-share (from the getUserMedia hook). */
  media: boolean;
  /** Tab has used / been granted the Notification API. */
  notify: boolean;
  /** Tab has an active Web Push subscription (notifications survive unloading). */
  push: boolean;
  /** Tab has non-empty text input / textarea / contenteditable — never discard it. */
  hasInput?: boolean;
  /** Per-frame unsaved-text state (frameId -> true); hasInput = any true. */
  inputFrames?: Record<number, true>;
  /** Tab has audio/video with playback state (playing or paused part-way). */
  hasPlayback?: boolean;
  /** Per-frame playback state (frameId -> true); hasPlayback = any true. */
  playbackFrames?: Record<number, true>;
  /** Why this tab was unloaded, when state === 'unloaded'. */
  unloadReason?: 'idle' | 'oom';
  /** Has this tab ever been the active/foreground tab? (gates deferred loading) */
  everActive?: boolean;
  /** When suspended, the real URL we deferred. */
  suspendedUrl?: string;
}

// ---- Messages: page (MAIN world) -> relay (ISOLATED) -> background ---------

export type ContentToBackground =
  | { type: 'MEDIA_STATE'; active: boolean }
  | { type: 'NOTIFICATION_CAPABLE' }
  | { type: 'PUSH_STATE'; active: boolean }
  | { type: 'INPUT_STATE'; hasInput: boolean }
  | { type: 'PLAYBACK_STATE'; active: boolean }
  | {
      type: 'SHOW_NOTIFICATION';
      title: string;
      options: { body?: string; icon?: string; tag?: string };
    };

export type BackgroundToContent = { type: 'GET_HEAP' };

/** Reply to GET_HEAP: a snapshot of performance.memory (Chrome, approximate). */
export interface HeapInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/** Config pushed down from the ISOLATED relay to the MAIN hook. */
export type RelayToHook = { type: 'CONFIG'; relay: boolean };

/** Marker on window.postMessage payloads bridging MAIN <-> ISOLATED worlds. */
export const BRIDGE_KEY = '__glpram__';
