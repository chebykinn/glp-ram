// The deferred-load placeholder. Holds the real URL in its own query string and
// navigates to it only once the tab becomes visible (i.e. the user activates it).
const params = new URLSearchParams(location.search);
const rawReal = params.get('u') || '';
const title = params.get('t') || '';

// Only ever navigate to a clean http(s) URL. A malformed value (e.g. typed
// omnibox text with spaces) would otherwise be turned into a broken `xn--…`
// navigation by the browser.
function validHttpUrl(u: string): string {
  if (!u || /\s/.test(u)) return '';
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (!parsed.hostname) return '';
    return u;
  } catch {
    return '';
  }
}
const real = validHttpUrl(rawReal);

const titleEl = document.getElementById('title')!;
const urlEl = document.getElementById('url')!;
const loadBtn = document.getElementById('load')!;

if (title) {
  document.title = title;
  titleEl.textContent = title;
}
try {
  urlEl.textContent = real ? new URL(real).host : rawReal;
} catch {
  urlEl.textContent = rawReal;
}

let navigated = false;
function load(): void {
  if (navigated || !real) return;
  navigated = true;
  location.replace(real);
}

loadBtn.addEventListener('click', load);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load();
});
// If we're already foreground (e.g. a restored active tab), load right away.
if (document.visibilityState === 'visible') load();
