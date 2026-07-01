// ISOLATED-world relay. Runs in EVERY frame (allFrames) so it can detect editors
// that live inside iframes (e.g. some site composers). Frame-specific duties
// (the MAIN-world bridge, relay-config, JS-heap reporting) only run in the top
// frame; unsaved-text detection runs in every frame and is aggregated per-frame
// by the service worker.
import {
  BRIDGE_KEY,
  type BackgroundToContent,
  type ContentToBackground,
  type HeapInfo,
} from '@/lib/types';
import { getSettings } from '@/lib/settings';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  allFrames: true,
  main() {
    const isTop = window === window.top;

    // ---- unsaved-text detection (all frames) --------------------------------
    const SKIP_INPUT_TYPES = new Set([
      'button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color',
      'file', 'image', 'hidden',
    ]);
    // textContent (not innerText): layout-independent, so it still works on a
    // backgrounded tab (innerText returns '' without a rendered layout).
    const hasText = (el: Element): boolean => (el.textContent || '').trim() !== '';
    // Only genuinely editable rich-text counts (a role="textbox" display element
    // that isn't contenteditable is not user input).
    const editableHasText = (el: Element): boolean =>
      (el as HTMLElement).isContentEditable && hasText(el);
    const fieldHasValue = (el: Element): boolean => {
      const f = el as HTMLInputElement & HTMLTextAreaElement;
      if (f.disabled || f.readOnly) return false; // not user-editable -> ignore
      if (el.tagName === 'INPUT' && SKIP_INPUT_TYPES.has(f.type)) return false;
      return (f.value || '').trim() !== '';
    };

    // Is this element a text-editable field (the only thing whose contents we'd
    // lose on discard)? Excludes checkboxes/radios/selects/buttons etc.
    const isTextTarget = (el: Element | null): boolean => {
      if (!el || el.nodeType !== 1) return false;
      if (el.tagName === 'TEXTAREA') return true;
      if (el.tagName === 'INPUT') return !SKIP_INPUT_TYPES.has((el as HTMLInputElement).type);
      return (el as HTMLElement).isContentEditable;
    };
    const targetHasText = (el: Element): boolean =>
      el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? fieldHasValue(el) : editableHasText(el);

    // Protect ONLY fields the user has actually edited (a trusted input/keyup/
    // paste/change whose target is a text field). A whole-document scan
    // false-positives on pages that ship pre-filled/readonly fields, search
    // boxes, or selection checkboxes the user never touched (e.g. apollo.io) —
    // and clicking a checkbox/row must not count as "edited text".
    const editedEls = new Set<Element>();
    function computeHasInput(): boolean {
      for (const el of editedEls) {
        if (!el.isConnected) {
          editedEls.delete(el);
          continue;
        }
        if (targetHasText(el)) return true;
      }
      return false;
    }

    let lastHasInput: boolean | undefined;
    let inputTimer: ReturnType<typeof setTimeout> | undefined;
    function reportInput(): void {
      const h = computeHasInput();
      if (h === lastHasInput) return;
      lastHasInput = h;
      browser.runtime.sendMessage({ type: 'INPUT_STATE', hasInput: h }).catch(() => {});
    }
    function scheduleReport(): void {
      if (inputTimer) clearTimeout(inputTimer);
      inputTimer = setTimeout(reportInput, 400);
    }
    function onEdit(e: Event): void {
      // composedPath()[0] pierces open shadow DOM to the real inner target;
      // e.target is retargeted to the shadow host at the document level.
      const t = (e.composedPath?.()[0] as Element | undefined) ?? (e.target as Element | null);
      if (e.isTrusted && isTextTarget(t)) editedEls.add(t!); // real edit of a text field
      scheduleReport();
    }
    for (const ev of ['input', 'change', 'keyup', 'paste'] as const) {
      document.addEventListener(ev, onEdit, true);
    }

    // ---- playback detection (all frames) ------------------------------------
    // Protect media the user explicitly started: audio/video that's UNMUTED with
    // real volume and is playing OR paused part-way. Muted/zero-volume media is
    // ignored — that's autoplay background decoration (which requires muted), not
    // something the user chose to watch. Walks light DOM + open shadow roots.
    const isActiveMedia = (m: HTMLMediaElement): boolean =>
      !m.ended && !m.muted && m.volume > 0 && (!m.paused || (m.currentTime > 0 && m.readyState > 0));
    function mediaInRoot(root: Document | ShadowRoot): boolean {
      for (const el of root.querySelectorAll('video, audio')) {
        if (isActiveMedia(el as HTMLMediaElement)) return true;
      }
      for (const el of root.querySelectorAll('*')) {
        const sr = (el as HTMLElement).shadowRoot;
        if (sr && mediaInRoot(sr)) return true;
      }
      return false;
    }
    let lastPlayback: boolean | undefined;
    let playbackTimer: ReturnType<typeof setTimeout> | undefined;
    function reportPlayback(): void {
      const p = mediaInRoot(document);
      if (p === lastPlayback) return;
      lastPlayback = p;
      browser.runtime.sendMessage({ type: 'PLAYBACK_STATE', active: p }).catch(() => {});
    }
    function schedulePlayback(): void {
      if (playbackTimer) clearTimeout(playbackTimer);
      playbackTimer = setTimeout(reportPlayback, 400);
    }
    // Media events don't bubble, but capture-phase listeners on document see them.
    for (const ev of ['play', 'pause', 'ended', 'loadeddata', 'emptied', 'seeked'] as const) {
      document.addEventListener(ev, schedulePlayback, true);
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        reportInput();
        reportPlayback();
      }
    });
    // Poll as a catch-all: editors/media are created lazily and some intercept
    // events. Cheap selectors; throttled by the browser on backgrounded tabs.
    setInterval(() => {
      reportInput();
      reportPlayback();
    }, 3000);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        reportInput();
        reportPlayback();
      });
    } else {
      reportInput();
      reportPlayback();
    }

    if (!isTop) return; // remaining duties are top-frame only

    // ---- MAIN (dir:'up') -> background bridge -------------------------------
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data as { [k: string]: unknown } | null;
      if (!data || data[BRIDGE_KEY] !== true || data.dir !== 'up') return;
      const payload = data.payload as ContentToBackground | undefined;
      if (!payload) return;
      browser.runtime.sendMessage(payload).catch(() => {});
    });

    // Push the relay setting down to the MAIN hook (dir:'down').
    getSettings().then((s) => {
      window.postMessage(
        { [BRIDGE_KEY]: true, dir: 'down', payload: { type: 'CONFIG', relay: s.relayNotifications } },
        '*',
      );
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        browser.runtime.sendMessage({ type: 'NOTIFICATION_CAPABLE' }).catch(() => {});
      }
    });

    // background -> page: this tab's JS heap (Chrome's performance.memory).
    browser.runtime.onMessage.addListener((message: BackgroundToContent) => {
      if (message.type === 'GET_HEAP') {
        const m = (performance as unknown as { memory?: HeapInfo }).memory;
        return Promise.resolve(
          m
            ? {
                usedJSHeapSize: m.usedJSHeapSize,
                totalJSHeapSize: m.totalJSHeapSize,
                jsHeapSizeLimit: m.jsHeapSizeLimit,
              }
            : null,
        );
      }
    });
  },
});
