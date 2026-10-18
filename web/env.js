// Where the app is running and where its data lives.
//  - Android app (Capacitor): code is bundled, data comes from GitHub Pages and is cached for offline reading.
//  - Local dev server: everything relative, plus /api/* helpers (state sync, Read more proxy, Load more).
//  - GitHub Pages in a browser: everything relative, no /api/*.
// (Also imported by the Node agent through model.js, where there is no window.)
const w = typeof window === "undefined" ? {} : window;
export const isNative = !!w.Capacitor?.isNativePlatform?.();
export const REMOTE = "https://luisstock.github.io/myscroll/";
export const isLocalDev = !isNative && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(w.location?.hostname ?? "");

// URL for a data file or image path like "editions/index.json".
export const dataUrl = (path) => (isNative && !/^https?:/.test(path) ? REMOTE + path : path);

const CACHE = "myscroll-data-v1";

// Network first (so new editions show up), cached copy when offline.
export async function getJSON(path, { optional = false } = {}) {
  const url = dataUrl(path);
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    const data = await res.json();
    try { (await caches.open(CACHE)).put(url, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } })); } catch {}
    return data;
  } catch (err) {
    try {
      const hit = await (await caches.open(CACHE)).match(url);
      if (hit) return hit.json();
    } catch {}
    // In the Android app, fall back to the copy bundled at build time (taxonomy, catalog).
    if (isNative && !path.startsWith("editions/")) {
      try { const r = await fetch(path); if (r.ok) return r.json(); } catch {}
    }
    if (optional) return null;
    throw err;
  }
}

// Android system bar icons follow the theme (light icons on dark themes).
export function setSystemBars(theme) {
  try { window.Capacitor?.Plugins?.SystemBars?.setStyle({ style: theme === "light" ? "LIGHT" : "DARK" }); } catch {}
}

// Android back button: let the app handle it (close Settings, go back to All) before exiting.
export function onBackButton(handler) {
  try {
    window.Capacitor?.Plugins?.App?.addListener("backButton", () => {
      if (!handler()) window.Capacitor.Plugins.App.exitApp();
    });
  } catch {}
}
