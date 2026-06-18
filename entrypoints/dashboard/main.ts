import { getSettings } from '@/lib/settings';
import { analyze, type SpareReason } from '@/lib/policy';
import { measureTabHeaps, hasSystemMemoryApi, getSystemMemory } from '@/lib/memory';
import type { TabInfo } from '@/lib/types';
import type { Tabs } from 'webextension-polyfill';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- formatting -------------------------------------------------------------

function fmtBytes(b: number | undefined): string {
  if (!b) return '-';
  return b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GB' : Math.round(b / 1024 ** 2) + ' MB';
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
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

// ---- OOM clock --------------------------------------------------------------

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

let tabSort = 'mem';
let tabDir = -1;

interface Row {
  tab: Tabs.Tab;
  info: TabInfo;
  mem: number; // JS heap (performance.memory), approximate
  idleMs: number;
  policy: ReturnType<typeof analyze>;
  oomRank: number; // 1 = first to be killed; 0 = spared
  aliveMs: number | null; // ms until unload, null = won't unload / n/a
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

  const rows: Row[] = managed.map((tab) => {
    const info: TabInfo =
      states[tab.id!] ||
      ({ lastActive: now, state: 'active', media: false, notify: false, push: false } as TabInfo);
    const policy = analyze(tab, info, settings, now);
    return {
      tab,
      info,
      mem: heaps.get(tab.id!) || 0,
      idleMs: Math.max(0, now - info.lastActive),
      policy,
      oomRank: 0,
      aliveMs: policy.discarded ? null : policy.msUntilUnload,
    };
  });

  // OOM rank: #1 dies first — heaviest JS heap, tie-broken by longest idle.
  const eligible = rows
    .filter((r) => r.policy.oomEligible)
    .sort((a, b) => b.mem - a.mem || b.idleMs - a.idleMs);
  eligible.forEach((r, i) => (r.oomRank = i + 1));

  // ---- summary cards ----
  $('vTabs').textContent = String(managed.length);
  let totalHeap = 0;
  for (const r of rows) totalHeap += r.mem;
  $('kMem').textContent = 'Tab JS heap / budget';
  $('vMem').textContent = `${totalHeap ? '~' + fmtBytes(totalHeap) : '-'} / ${settings.memoryLimitMB} MB`;
  $('cardMem').classList.toggle('warn', totalHeap > settings.memoryLimitMB * 1024 ** 2);

  if (hasSystemMemoryApi()) {
    const sys = await getSystemMemory();
    $('kBudget').textContent = 'System free / total';
    if (sys) {
      $('vBudget').textContent = `${fmtBytes(sys.availableCapacity)} / ${fmtBytes(sys.capacity)}`;
      const low = sys.availableCapacity < settings.minFreeMemoryMB * 1024 ** 2;
      $('cardBudget').classList.toggle('warn', low);
      $('cardBudget').title = `OOM guard evicts below ${settings.minFreeMemoryMB} MB free`;
    } else {
      $('vBudget').textContent = 'n/a';
    }
  } else {
    $('kBudget').textContent = 'System memory';
    $('vBudget').textContent = 'n/a';
  }

  // ---- tabs table ----
  const sorters: Record<string, (r: Row) => number | string> = {
    title: (r) => (r.tab.title || hostOf(r.tab.url)).toLowerCase(),
    state: (r) => (r.policy.discarded ? 'unloaded' : r.info.state),
    mem: (r) => r.mem,
    // Order: killed-by-OOM, idle-unloaded, browser-discarded, then live tabs by
    // soonest unload, then "never" (protected). Ascending shows dead-first.
    alive: (r) => {
      if (r.policy.discarded) {
        return r.info.unloadReason === 'oom' ? 0 : r.info.unloadReason === 'idle' ? 1 : 2;
      }
      return r.aliveMs == null ? Number.POSITIVE_INFINITY : 10 + r.aliveMs / 1000;
    },
    oom: (r) => (r.oomRank === 0 ? Number.POSITIVE_INFINITY : r.oomRank),
  };
  const key = sorters[tabSort] || sorters.mem;
  rows.sort((a, b) => {
    const va = key(a);
    const vb = key(b);
    if (va < vb) return -tabDir;
    if (va > vb) return tabDir;
    return 0;
  });

  const body = $('tabsBody');
  body.replaceChildren(...rows.map((r) => renderTabRow(r, settings.oomEnabled)));
  $('memNote').textContent =
    'Memory is each tab’s JS heap (performance.memory): approximate — JS heap only, ~10 MB granularity, excludes DOM/images/GPU. The OOM guard triggers on system free memory and kills the heaviest-heap tabs first.';
}

function badge(cls: string, label: string = cls): HTMLElement {
  const el = document.createElement('span');
  el.className = 'badge ' + cls;
  el.textContent = label;
  return el;
}

function renderTabRow(r: Row, oomEnabled: boolean): HTMLElement {
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
  if (r.info.hasInput) add('input', 'has unsaved text — never unloaded or OOM-killed');
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

  // Alive for / how it was unloaded
  const tdAlive = document.createElement('td');
  if (r.policy.discarded) {
    if (r.info.unloadReason === 'oom') {
      tdAlive.innerHTML = '<span class="danger">killed by OOM</span>';
    } else if (r.info.unloadReason === 'idle') {
      tdAlive.innerHTML = '<span class="muted">unloaded (idle timer)</span>';
    } else {
      tdAlive.innerHTML = '<span class="muted">discarded (not by glp-ram)</span>';
      tdAlive.title =
        "Discarded by something other than glp-ram: Chrome's Memory Saver, session restore, a manual discard, or it was already discarded before glp-ram started tracking (e.g. after a browser restart).";
    }
  } else if (r.policy.spared) {
    tdAlive.innerHTML = `<span class="spared">never (${SPARE_LABEL[r.policy.spared]})</span>`;
  } else if (r.policy.notifHold) {
    tdAlive.innerHTML = '<span class="spared">never (notifications)</span>';
  } else if (r.policy.inputHold) {
    tdAlive.innerHTML = '<span class="spared">never (unsaved input)</span>';
  } else if (r.aliveMs != null) {
    const cls = r.aliveMs < 60_000 ? 'danger' : '';
    tdAlive.innerHTML = `<span class="${cls}">unload in ${fmtDuration(r.aliveMs)}</span>`;
  } else {
    tdAlive.textContent = '-';
  }

  // OOM rank
  const tdOom = document.createElement('td');
  tdOom.className = 'num';
  if (!oomEnabled) {
    tdOom.innerHTML = '<span class="muted">off</span>';
  } else if (r.oomRank === 0) {
    tdOom.innerHTML = '<span class="muted">spared</span>';
  } else {
    const hot = r.oomRank <= 3;
    tdOom.innerHTML = `<span class="oom ${hot ? 'hot' : ''}">#${r.oomRank}</span>`;
    tdOom.title = 'Lower rank = killed sooner under memory pressure';
  }

  tr.append(tdTab, tdState, tdProt, tdMem, tdAlive, tdOom);
  return tr;
}

// ---- wiring -----------------------------------------------------------------

document.querySelectorAll<HTMLElement>('#tabsTable th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort!;
    if (tabSort === key) tabDir = -tabDir as 1 | -1;
    else {
      tabSort = key;
      tabDir = key === 'title' || key === 'state' || key === 'alive' ? 1 : -1;
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

setInterval(renderClock, 1000); // smooth OOM countdown between full refreshes
void render();
setAuto(true);
