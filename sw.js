
const CACHE = "interview-helper-v1";
const ASSETS = ["./","index.html","styles.css","app.js","manifest.webmanifest","icons/icon-192.png","icons/icon-512.png"];
self.addEventListener("install",e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))));
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET") return;
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
});
