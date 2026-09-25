// Navigation-only, and caches nothing, on purpose. Every page here is live
// data (workouts, notes, ticks), so a cached page is a stale
// program. All this does is show a "no signal" screen instead of the
// browser's error page when a page load fails in the gym. Nothing else —
// Supabase calls, fonts, the SDK — is touched.
const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;
font-family:system-ui,sans-serif;background:#08080f;color:#f2f2f6;text-align:center;padding:24px}
@media (prefers-color-scheme:light){body{background:#f5f6f8;color:#111111}}
button{margin-top:20px;min-height:44px;padding:0 24px;border:0;border-radius:999px;
font:inherit;font-weight:600;background:#f2f2f6;color:#1b1c22}
@media (prefers-color-scheme:light){button{background:#1b1c22;color:#eceef2}}
p{opacity:.6}</style></head><body><div>
<h1>No connection</h1><p>Your training needs the internet to load.</p>
<button onclick="location.reload()">Try again</button>
</div></body></html>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.mode !== "navigate" || req.method !== "GET") return;
  e.respondWith(
    fetch(req).catch(
      () => new Response(OFFLINE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    ),
  );
});
