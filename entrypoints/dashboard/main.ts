import { getSettings } from '@/lib/settings';
import { analyze, planKeep, type SpareReason } from '@/lib/policy';
import { measureTabHeaps, hasSystemMemoryApi, getSystemMemory } from '@/lib/memory';
import type { TabInfo } from '@/lib/types';
import type { Tabs } from 'webextension-polyfill';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- formatting -------------------------------------------------------------

function fmtBytes(b: number | undefined): string {
  if (!b) return '-';
  return b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GB' : Math.round(b / 1024 ** 2) + ' MB';
}

const SPARE_LABEL: Record<NonNullable<SpareReason>, string> = {
  active: 'active',
  whitelist: 'whitelisted',
  audible: 'audio/video',
  capture: 'mic/cam/screen',
};

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return url || '';
  }
}

// ---- scan clock -------------------------------------------------------------

interface ScanMeta {
  at: number;
  periodMs: number;
}
let scanMeta: ScanMeta | null = null;

function renderClock(): void {
  if (!scanMeta) {
    $('vClock').textContent = '–';
    return;
  }
  const remaining = scanMeta.at + scanMeta.periodMs - Date.now();
  $('vClock').textContent = remaining <= 1000 ? 'now' : Math.ceil(remaining / 1000) + 's';
}

// ---- sorting state ----------------------------------------------------------

let tabSort = 'keep';
let tabDir = 1;

interface Row {
  tab: Tabs.Tab;
  info: TabInfo;
  mem: number; // JS heap (performance.memory), approximate
  policy: ReturnType<typeof analyze>;
  rank: number; // recency rank, 0 = most recent (active); Infinity = discarded
  willEvict: boolean; // discarded next scan (beyond the working set / force-unload)
}

// ---- render -----------------------------------------------------------------

async function render(): Promise<void> {
  const [settings, allTabs, stateStore] = await Promise.all([
    getSettings(),
    browser.tabs.query({}),
    browser.storage.session.get(['glpram:tabs', 'glpram:scan']),
  ]);
  const states = (stateStore['glpram:tabs'] as Record<number, TabInfo> | undefined) || {};
  scanMeta = (stateStore['glpram:scan'] as ScanMeta | undefined) || null;
  renderClock();
  const now = Date.now();

  const managed = allTabs.filter((t) => t.id != null && /^https?:\/\//i.test(t.url || ''));
  const liveIds = managed.filter((t) => !t.discarded).map((t) => t.id!);
  // Per-tab memory = JS heap via performance.memory (only per-tab signal on stable).
  const heaps = await measureTabHeaps(liveIds);

  const infoOf = (tab: Tabs.Tab): TabInfo =>
    states[tab.id!] ||
    ({ lastActive: now, state: 'active', media: false, notify: false, push: false } as TabInfo);

  // Working-set plan over live (non-discarded) tabs — same logic the scan uses.
  const liveEntries = managed
    .filter((t) => !t.discarded)
    .map((t) => ({ tab: t, info: infoOf(t) }));
  const plan = planKeep(liveEntries, settings);
  const evictSet = new Set(plan.evict);

  const rows: Row[] = managed.map((tab) => {
    const info = infoOf(tab);
    const policy = analyze(tab, info, settings);
    return {
      tab,
      info,
      mem: heaps.get(tab.id!) || 0,
      policy,
      rank: plan.rank.get(tab.id!) ?? Number.POSITIVE_INFINITY,
      willEvict: evictSet.has(tab.id!),
    };
  });

  // ---- summary cards ----
  $('vTabs').textContent = String(managed.length);
  let totalHeap = 0;
  for (const r of rows) totalHeap += r.mem;
  $('kMem').textContent = 'Tab JS heap';
  $('vMem').textContent = totalHeap ? '~' + fmtBytes(totalHeap) : '-';

  $('kBudget').textContent = 'Keep loaded';
  if (hasSystemMemoryApi()) {
    const sys = await getSystemMemory();
    $('vBudget').textContent = sys
      ? `${settings.keepLoaded} tabs · ${fmtBytes(sys.availableCapacity)} free`
      : `${settings.keepLoaded} tabs`;
  } else {
    $('vBudget').textContent = `${settings.keepLoaded} tabs`;
  }

  // ---- tabs table ----
  // Status rank for sorting: discarded(0) < will-discard(1) < loaded(2) < protected(3).
  const statusCode = (r: Row): number => {
    if (r.policy.discarded) return 0;
    if (r.willEvict) return 1;
    if (r.policy.spared || r.policy.notifHold || r.policy.inputHold) return 3;
    return 2;
  };
  const sorters: Record<string, (r: Row) => number | string> = {
    title: (r) => (r.tab.title || hostOf(r.tab.url)).toLowerCase(),
    state: (r) => (r.policy.discarded ? 'unloaded' : r.info.state),
    mem: (r) => r.mem,
    status: statusCode,
    keep: (r) => r.rank,
  };
  const key = sorters[tabSort] || sorters.keep;
  rows.sort((a, b) => {
    const va = key(a);
    const vb = key(b);
    if (va < vb) return -tabDir;
    if (va > vb) return tabDir;
    return 0;
  });

  const body = $('tabsBody');
  body.replaceChildren(...rows.map((r) => renderTabRow(r, settings.keepLoaded)));
  $('memNote').textContent =
    'glp-ram keeps the most-recently-used tabs loaded (the working set) and discards the rest; protected tabs (media, unsaved input, non-push notifications) are always kept. Memory is each tab’s JS heap (performance.memory): approximate, ~10 MB granularity, JS heap only.';
}

function badge(cls: string, label: string = cls): HTMLElement {
  const el = document.createElement('span');
  el.className = 'badge ' + cls;
  el.textContent = label;
  return el;
}

function renderTabRow(r: Row, keepLoaded: number): HTMLElement {
  const tr = document.createElement('tr');
  if (r.tab.active) tr.className = 'is-active';
  if (r.policy.discarded) tr.className = 'is-discarded';

  // Tab
  const tdTab = document.createElement('td');
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = r.tab.title || hostOf(r.tab.url) || '(untitled)';
  title.title = r.tab.url || '';
  const host = document.createElement('div');
  host.className = 'host';
  host.textContent = hostOf(r.tab.url);
  tdTab.append(title, host);

  // State
  const tdState = document.createElement('td');
  const st = r.policy.discarded ? 'unloaded' : r.info.state;
  tdState.append(badge(st));

  // Protection flags (text, no icons)
  const tdProt = document.createElement('td');
  const flags = document.createElement('div');
  flags.className = 'flags';
  const add = (txt: string, tip: string) => {
    const s = document.createElement('span');
    s.textContent = txt;
    s.title = tip;
    flags.append(s);
  };
  if (r.tab.audible) add('audio', 'playing audio');
  if (r.info.hasPlayback && !r.tab.audible) add('media', 'unmuted audio/video paused part-way (you started it) — protected');
  if (r.info.media) add('capture', 'mic / camera / screen capture');
  if (r.info.notify) add('notify', 'uses notifications');
  if (r.info.push) add('push', 'has a Web Push subscription (survives unloading)');
  if (r.info.hasInput && !r.policy.forced) add('input', 'has unsaved text — never discarded');
  if (r.policy.forced) add('force-unload', 'on the always-unload list — every protection bypassed');
  tdProt.append(flags);

  // Memory (JS heap, approximate)
  const tdMem = document.createElement('td');
  tdMem.className = 'num';
  if (r.mem) {
    tdMem.textContent = '~' + fmtBytes(r.mem);
    tdMem.title = 'JS heap (performance.memory) — approximate';
  } else {
    tdMem.textContent = '-';
  }

  // Status
  const tdStatus = document.createElement('td');
  if (r.policy.discarded) {
    if (r.info.unloadReason === 'oom') {
      tdStatus.innerHTML = '<span class="muted">unloaded (working set)</span>';
    } else if (r.info.unloadReason === 'manual') {
      tdStatus.innerHTML = '<span class="muted">killed (manually)</span>';
    } else {
      tdStatus.innerHTML = '<span class="muted">discarded (not by glp-ram)</span>';
      tdStatus.title =
        "Discarded by something other than glp-ram: Chrome's Memory Saver, session restore, a manual discard, or it was already discarded before glp-ram started tracking.";
    }
  } else if (r.policy.spared) {
    tdStatus.innerHTML = `<span class="spared">kept (${SPARE_LABEL[r.policy.spared]})</span>`;
  } else if (r.policy.notifHold) {
    tdStatus.innerHTML = '<span class="spared">kept (notifications)</span>';
  } else if (r.policy.inputHold) {
    tdStatus.innerHTML = '<span class="spared">kept (unsaved input)</span>';
  } else if (r.willEvict) {
    tdStatus.innerHTML = '<span class="danger">discards next scan</span>';
  } else {
    tdStatus.innerHTML = '<span>loaded (working set)</span>';
  }

  // Keep order (recency rank)
  const tdKeep = document.createElement('td');
  tdKeep.className = 'num';
  if (r.policy.discarded || !Number.isFinite(r.rank)) {
    tdKeep.innerHTML = '<span class="muted">-</span>';
  } else {
    const inSet = r.rank < keepLoaded;
    tdKeep.innerHTML = `<span class="oom ${inSet ? '' : 'hot'}">#${r.rank + 1}</span>`;
    tdKeep.title = inSet
      ? `Within the working set (keep ${keepLoaded})`
      : `Beyond the working set (keep ${keepLoaded}) — discarded unless protected`;
  }

  // Action: kill (discard) now
  const tdAct = document.createElement('td');
  const kill = document.createElement('button');
  kill.className = 'kill';
  kill.textContent = 'Kill';
  if (r.policy.discarded) {
    kill.disabled = true;
    kill.title = 'Already unloaded';
  } else if (r.tab.active) {
    kill.disabled = true;
    kill.title = "Chrome won't discard the active tab — switch away first";
  } else {
    kill.title = 'Discard this tab now (keeps it in the tab strip)';
    kill.addEventListener('click', async () => {
      kill.disabled = true;
      kill.textContent = 'Killing…';
      await browser.runtime.sendMessage({ type: 'KILL_TAB', tabId: r.tab.id! });
      void render();
    });
  }
  tdAct.append(kill);

  tr.append(tdTab, tdState, tdProt, tdMem, tdStatus, tdKeep, tdAct);
  return tr;
}

// ---- wiring -----------------------------------------------------------------

document.querySelectorAll<HTMLElement>('#tabsTable th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort!;
    if (tabSort === key) tabDir = -tabDir as 1 | -1;
    else {
      tabSort = key;
      tabDir = key === 'title' || key === 'state' || key === 'keep' ? 1 : -1;
    }
    void render();
  });
});

let timer: ReturnType<typeof setInterval> | undefined;
function setAuto(on: boolean): void {
  if (timer) clearInterval(timer);
  timer = on ? setInterval(() => void render(), 2000) : undefined;
}
($('auto') as HTMLInputElement).addEventListener('change', (e) =>
  setAuto((e.target as HTMLInputElement).checked),
);
$('refresh').addEventListener('click', () => void render());

setInterval(renderClock, 1000); // smooth scan countdown between full refreshes
void render();
setAuto(true);
