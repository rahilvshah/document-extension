// Runs in the page MAIN world. Injected as a file so strict
// script-src policies do not block it the way an inline script is blocked.

type Scheme = 'light' | 'dark' | null;

const win = window as Window & { __docextSetColorScheme?: (next: Scheme) => void };
if (!win.__docextSetColorScheme) {
  const native = window.matchMedia.bind(window);
  let scheme: Scheme = null;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  function schemeMatches(query: string): boolean | null {
    const q = String(query);
    const darkQ = q.includes('prefers-color-scheme') && q.includes('dark');
    const lightQ = q.includes('prefers-color-scheme') && q.includes('light');
    if (!darkQ && !lightQ) return null;
    if (scheme === 'dark') return darkQ;
    if (scheme === 'light') return lightQ;
    return null;
  }

  window.matchMedia = function (query: string): MediaQueryList {
    const list = native(query);
    const wrapped = {
      media: String(query),
      onchange: null as ((this: MediaQueryList, ev: MediaQueryListEvent) => void) | null,
      addListener(fn: (event: MediaQueryListEvent) => void) {
        listeners.add(fn);
        list.addListener(fn);
      },
      removeListener(fn: (event: MediaQueryListEvent) => void) {
        listeners.delete(fn);
        list.removeListener(fn);
      },
      addEventListener(type: string, fn: EventListener) {
        if (type === 'change') listeners.add(fn as (event: MediaQueryListEvent) => void);
        list.addEventListener(type, fn);
      },
      removeEventListener(type: string, fn: EventListener) {
        listeners.delete(fn as (event: MediaQueryListEvent) => void);
        list.removeEventListener(type, fn);
      },
      dispatchEvent(ev: Event) {
        return list.dispatchEvent(ev);
      },
    };
    Object.defineProperty(wrapped, 'matches', {
      get() {
        const next = schemeMatches(query);
        return next === null ? list.matches : next;
      },
    });
    return wrapped as unknown as MediaQueryList;
  };

  win.__docextSetColorScheme = (next: Scheme) => {
    scheme = next === 'dark' || next === 'light' ? next : null;
    const event = {
      matches: scheme === 'dark',
      media: `(prefers-color-scheme: ${scheme || 'light'})`,
    } as MediaQueryListEvent;
    listeners.forEach((fn) => {
      try { fn(event); } catch { /* page listener */ }
    });
  };

  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window || !ev.data || ev.data.__docextColorScheme === undefined) return;
    const theme = ev.data.__docextColorScheme;
    win.__docextSetColorScheme?.(theme === 'dark' || theme === 'light' ? theme : null);
  });
}
