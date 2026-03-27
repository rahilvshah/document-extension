// Runs in the MAIN world (same JS environment as the page).
// Patches MutationObserver and suppresses dismissal events during theme toggles
// so popups, dropdowns, and menus stay open across dual-theme screenshot captures.

if (!(window as any).__docext_mo_patched) {
  (window as any).__docext_mo_patched = true;
  const DEBUG = false;
  const log = (...args: unknown[]) => {
    if (!DEBUG) return;
    const t = Math.round(performance.now());
    console.log('[docext][main-world]', t, ...args);
  };

  const Native = window.MutationObserver;
  const tracked = new Set<MutationObserver>();
  let paused = false;
  let clickGateActive = false;

  class PatchedObserver extends Native {
    constructor(callback: MutationCallback) {
      super((mutations: MutationRecord[], obs: MutationObserver) => {
        if (paused) return;
        callback(mutations, obs);
      });
      tracked.add(this);
    }
    disconnect() {
      tracked.delete(this);
      super.disconnect();
    }
  }

  window.MutationObserver = PatchedObserver as any;

  // Radix UI's DismissableLayer listens for focusin/pointerdown on document
  // to detect outside interactions and close popups. Theme toggling can trigger
  // focus movement (from colorScheme changes) which Radix interprets as dismissal.
  const SUPPRESSED_EVENTS = ['focusin', 'focusout', 'blur', 'pointerdown', 'pointerup', 'mousedown', 'mouseup'];

  function blockEvent(e: Event) {
    e.stopImmediatePropagation();
  }

  function blockTrustedInteraction(e: Event) {
    if (!clickGateActive) return;
    const target = e.target as Element | null;
    // Allow our synthetic replay events through (isTrusted=false),
    // but block real user events while capture is in progress.
    if ((e as Event).isTrusted) {
      log('blocked-trusted-event', e.type, target?.tagName?.toLowerCase(), target?.getAttribute?.('role') || '');
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  function addEventBlocks() {
    for (const evt of SUPPRESSED_EVENTS) {
      document.addEventListener(evt, blockEvent, true);
    }
  }

  function removeEventBlocks() {
    for (const evt of SUPPRESSED_EVENTS) {
      document.removeEventListener(evt, blockEvent, true);
    }
  }

  for (const evt of ['pointerdown', 'pointerup', 'click', 'mousedown', 'mouseup']) {
    document.addEventListener(evt, blockTrustedInteraction, true);
  }

  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window) return;
    const data = ev.data as { __docextClickGate?: boolean } | null;
    if (!data || typeof data !== 'object') return;
    if ('__docextClickGate' in data) {
      clickGateActive = !!data.__docextClickGate;
      log('gate', clickGateActive ? 'ON' : 'OFF');
    }
  }, true);

  (window as any).__docext_pauseObservers = () => {
    paused = true;
    addEventBlocks();
  };

  (window as any).__docext_resumeObservers = () => {
    removeEventBlocks();
    for (const obs of tracked) {
      try { obs.takeRecords(); } catch {}
    }
    paused = false;
  };
}
