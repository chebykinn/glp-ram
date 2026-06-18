import { defineConfig } from 'wxt';

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
  },
});
