// MAIN-world hook. Runs in the page's own JS context at document_start so it can
// wrap `navigator.mediaDevices` and `window.Notification` *before* the page uses
// them. MAIN-world scripts can't use chrome.runtime, so it talks to the ISOLATED
// relay (relay.content.ts) via window.postMessage:
//   dir:'up'   -> page event the relay forwards to the service worker
//   dir:'down' -> config the relay pushes back into the page
import { BRIDGE_KEY, type ContentToBackground, type RelayToHook } from '@/lib/types';

export default defineContentScript({
  matches: ['<all_urls>'],
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: false,
  main() {
    const send = (msg: ContentToBackground) => {
      try {
        window.postMessage({ [BRIDGE_KEY]: true, dir: 'up', payload: msg }, '*');
      } catch {
        /* serialization can fail on exotic options; ignore */
      }
    };

    // Default to relaying until the relay tells us the user's setting.
    let relayOn = true;
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data as { [k: string]: unknown } | null;
      if (!data || data[BRIDGE_KEY] !== true || data.dir !== 'down') return;
      const payload = data.payload as RelayToHook | undefined;
      if (payload?.type === 'CONFIG') relayOn = payload.relay;
    });

    // NOTE: no beforeunload-guard detection. Detecting whether a page "blocks
    // refresh" reliably requires invoking its beforeunload handler, which has
    // destructive side effects (e.g. it disconnects a live Google Meet call).
    // Unsaved-text detection below covers the real data-loss case safely.

    // ---- mic / camera / screen-share detection ----------------------------
    // Once a page captures mic/cam/screen it's a media/call app and must never be
    // unloaded/OOM-killed. We do NOT track exact live-track counts: WebRTC apps
    // (Google Meet, Zoom, etc.) constantly stop/replace/clone capture tracks, so
    // the count routinely hits 0 mid-call. Instead it's sticky for the lifetime
    // of the page — released only when the page navigates/closes (fresh hook).
    let capturing = false;
    const watchStream = (_stream: MediaStream) => {
      if (capturing) return;
      capturing = true;
      console.log('[glp-ram] media capture detected -> protected');
      send({ type: 'MEDIA_STATE', active: true });
    };

    const md = navigator.mediaDevices;
    if (md) {
      for (const method of ['getUserMedia', 'getDisplayMedia'] as const) {
        const orig = md[method];
        if (typeof orig !== 'function') continue;
        md[method] = async function (this: MediaDevices, ...args: unknown[]) {
          // @ts-expect-error variadic passthrough to the native impl
          const stream: MediaStream = await orig.apply(this, args);
          try {
            watchStream(stream);
          } catch {
            /* ignore */
          }
          return stream;
        } as typeof orig;
      }
    }

    // ---- Web Push detection -----------------------------------------------
    // A tab with a push subscription keeps receiving notifications via its own
    // service worker even after we unload it, so it does NOT need to stay loaded.
    const reportPush = () => send({ type: 'PUSH_STATE', active: true });
    try {
      const PM = (window as unknown as { PushManager?: { prototype?: PushManager } }).PushManager;
      const proto = PM?.prototype;
      if (proto && typeof proto.subscribe === 'function') {
        const origSubscribe = proto.subscribe;
        proto.subscribe = function (this: PushManager, ...args: unknown[]) {
          // @ts-expect-error variadic passthrough
          const p = origSubscribe.apply(this, args) as Promise<PushSubscription>;
          Promise.resolve(p)
            .then((sub) => sub && reportPush())
            .catch(() => {});
          return p;
        } as typeof proto.subscribe;
      }
    } catch {
      /* ignore */
    }
    // Catch subscriptions made in a previous session, once the SW is controlling.
    try {
      navigator.serviceWorker?.ready
        .then((reg) => reg.pushManager?.getSubscription())
        .then((sub) => sub && reportPush())
        .catch(() => {});
    } catch {
      /* ignore */
    }

    // ---- notification interception ----------------------------------------
    const Native = window.Notification;
    if (Native) {
      if (Native.permission === 'granted') send({ type: 'NOTIFICATION_CAPABLE' });

      // Drop-in replacement. When relaying, it reports the notification to the SW
      // (which shows it via chrome.notifications) and suppresses the native one to
      // avoid duplicates, returning an API-shaped stub. When relay is off, it just
      // constructs the real Notification.
      const Glp = function (this: Notification, title: string, options?: NotificationOptions) {
        const opts = options || {};
        send({ type: 'NOTIFICATION_CAPABLE' });
        if (!relayOn) {
          return Reflect.construct(Native, [title, options]) as Notification;
        }
        send({
          type: 'SHOW_NOTIFICATION',
          title: String(title ?? ''),
          options: { body: opts.body, icon: opts.icon, tag: opts.tag },
        });
        Object.assign(this, { title, ...opts });
        return this;
      } as unknown as typeof Notification;

      // Own prototype chained to Native's, so stub instances get a no-op close()
      // without mutating the real Notification.prototype (used when relay is off).
      Glp.prototype = Object.create(Native.prototype);
      (Glp.prototype as Notification).close = function () {};
      Object.defineProperty(Glp, 'permission', { get: () => Native.permission });
      Glp.requestPermission = (...a: unknown[]) => {
        send({ type: 'NOTIFICATION_CAPABLE' });
        // @ts-expect-error passthrough to native
        return Native.requestPermission(...a);
      };

      window.Notification = Glp;
    }
  },
});
