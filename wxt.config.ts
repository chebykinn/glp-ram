import { defineConfig } from 'wxt';
import { createPublicKey } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Pin the extension ID by embedding the public half of key.pem as the manifest
// "key". Chrome derives the extension ID (and thus every chrome-extension://<id>
// URL — including our suspended.html placeholder tabs) from this key, so it stays
// identical across reloads/updates and between unpacked and the packed .crx. That
// keeps deferred (suspended) tabs valid instead of orphaning them on a reload.
function manifestKey(): string | undefined {
  const pem = resolve(dirname(fileURLToPath(import.meta.url)), 'key.pem');
  if (!existsSync(pem)) return undefined;
  try {
    return createPublicKey(readFileSync(pem))
      .export({ type: 'spki', format: 'der' })
      .toString('base64');
  } catch {
    return undefined;
  }
}

// glp-ram is a Chrome-targeted MV3 extension. It needs:
// - tabs:          read tab state (audible/discarded/active) and discard tabs
// - scripting:     inject hooks into already-open tabs at startup
// - alarms:        drive the periodic idle/OOM scan
// - storage:       persist settings (sync) and live tab bookkeeping (session)
// - notifications: relay page notifications through our single service worker
// - system.memory: detect real memory pressure for the OOM guard
//
// Per-tab memory comes from each tab's content script (performance.memory, JS
// heap). There is deliberately no `chrome.processes` permission: it's Dev-channel
// only and makes the extension fail to load on stable Chrome.
export default defineConfig({
  manifest: {
    name: 'glp-ram',
    description:
      'Take over tab memory: defer loading until active, unload idle tabs, relay notifications, and evict idle tabs under memory pressure.',
    version: '0.1.0',
    permissions: ['tabs', 'scripting', 'alarms', 'storage', 'notifications', 'system.memory'],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'glp-ram' },
    // "split": run a separate instance inside Incognito so our placeholder page
    // can render in Incognito tabs (spanning mode forbids extension pages there).
    // Settings (synced storage) are shared; per-tab state stays per-profile.
    incognito: 'split',
    // Pin the extension ID so suspended.html placeholder tabs survive reloads.
    ...(manifestKey() ? { key: manifestKey() } : {}),
  },
});
