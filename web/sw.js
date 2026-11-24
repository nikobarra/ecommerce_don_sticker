// Service worker de Don Sticker. Hace dos cosas y nada más:
//  1) Permite instalar el sitio como app.
//  2) Si no hay conexión, muestra lo último que el cliente ya vio (red primero, copia guardada de respaldo).
// Red PRIMERO a propósito: precios, packs y código siempre salen frescos cuando hay conexión; la copia solo
// aparece cuando la red falla. Nunca guarda la API, el panel ni las páginas con datos de la persona.
const VERSION = "ds-v1";
const PAGINAS = `${VERSION}-paginas`;
const ARCHIVOS = `${VERSION}-archivos`;
const MAX_IMAGENES = 250;
const NO_GUARDAR = /^\/(api\/|admin|cuenta|pago|verificar|restablecer|arrepentimiento|baja)/;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(PAGINAS).then((c) => c.addAll(["/", "/offline"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function recortar(cache) {
  const claves = await cache.keys();
  const imagenes = claves.filter((r) => /\/assets\/catalogo\//.test(r.url));
  for (const r of imagenes.slice(0, Math.max(0, imagenes.length - MAX_IMAGENES))) await cache.delete(r);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || NO_GUARDAR.test(url.pathname)) return;
  // Los videos se piden por tramos (Range): se dejan pasar sin tocar.
  if (req.headers.has("range")) return;

  const esPagina = req.mode === "navigate";
  const nombre = esPagina ? PAGINAS : ARCHIVOS;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic" && !res.redirected) {
        const copia = res.clone();
        caches.open(nombre).then(async (c) => { await c.put(req, copia); if (!esPagina) await recortar(c); }).catch(() => {});
      }
      return res;
    } catch (err) {
      const guardado = await caches.match(req);
      if (guardado) return guardado;
      if (esPagina) return (await caches.match("/offline")) || (await caches.match("/")) || Response.error();
      return Response.error();
    }
  })());
});
