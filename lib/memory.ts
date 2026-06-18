// Memory signals available to an extension on stable Chrome:
//  - chrome.system.memory: system-wide physical memory (free / total)
//  - per-tab JS heap via each tab's content script (performance.memory)
// There is no stable API for true per-tab/per-process memory.

interface ChromeSystemMemory {
  getInfo(cb: (info: { capacity: number; availableCapacity: number }) => void): void;
}

declare const chrome: {
  system?: { memory?: ChromeSystemMemory };
  runtime?: { lastError?: unknown };
};

export function hasSystemMemoryApi(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.system?.memory;
}

export interface SystemMemory {
  /** Total physical memory in bytes. */
  capacity: number;
  /** Currently free physical memory in bytes. */
  availableCapacity: number;
}

/** System-wide physical memory (stable channel). Null if unavailable. */
export function getSystemMemory(): Promise<SystemMemory | null> {
  return new Promise((resolve) => {
    if (!hasSystemMemoryApi()) return resolve(null);
    try {
      chrome.system!.memory!.getInfo((info) => {
        void chrome.runtime?.lastError;
        resolve(info || null);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Per-tab JS heap (bytes) via each tab's content script (performance.memory).
 * Approximate: JS heap only (no DOM/images/GPU), quantized to ~10 MB on
 * non-cross-origin-isolated pages. Tabs without a content script (discarded,
 * restricted pages) are simply omitted.
 */
export async function measureTabHeaps(tabIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  await Promise.all(
    tabIds.map(async (id) => {
      // A frozen tab (paused JS) never replies, so the sendMessage promise would
      // hang forever — race it against a timeout that resolves to null.
      const heap = await Promise.race([
        browser.tabs
          .sendMessage(id, { type: 'GET_HEAP' })
          .then((r) => {
            const used = (r as { usedJSHeapSize?: number } | null)?.usedJSHeapSize;
            return typeof used === 'number' ? used : null;
          })
          .catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 700)),
      ]);
      if (heap != null) out.set(id, heap);
    }),
  );
  return out;
}
