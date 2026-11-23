// Pruebas de la parte ESTÁTICA (web/): SEO técnico, cabeceras, enlaces, caché y HTML inicial.
// No levantan nada: leen los archivos tal como se van a publicar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prerender, cargarDatos } from "../scripts/prerender.mjs";

const WEB = fileURLToPath(new URL("../../web/", import.meta.url));
const leer = (ruta) => readFileSync(WEB + ruta, "utf8");
const paginas = readdirSync(WEB).filter((f) => f.endsWith(".html"));
const SITIO = "https://donsticker.com.ar";

// URL pública limpia (como las sirve Cloudflare) -> archivo.
const archivoDe = (ruta) => {
  const limpia = ruta.split("#")[0].split("?")[0];
  if (limpia === "/" || limpia === "") return "index.html";
  const sinBarra = limpia.replace(/^\//, "");
  if (existsSync(WEB + sinBarra) && !sinBarra.endsWith("/")) return sinBarra;
  if (existsSync(WEB + sinBarra + ".html")) return sinBarra + ".html";
  return null;
};

// ---------- HTML inicial (pre-render) ----------

test("el HTML inicial de la portada coincide con lo que generan los datos de data.js", () => {
  const datos = cargarDatos(leer("js/data.js"));
  const original = leer("index.html");
  assert.equal(prerender(original, datos), original, "Corré `npm run prerender` en worker/ y revisá el cambio");
});

test("la portada trae los precios y los packs en el HTML, sin ejecutar JavaScript", () => {
  const html = leer("index.html");
  const datos = cargarDatos(leer("js/data.js"));
  // La portada trae un acceso por tamaño (a packs.html) con el precio desde el que arranca cada uno.
  for (const g of ["10", "25", "50", "100", "tematicos"]) {
    const lista = datos.PACKS.filter((p) => p.grupo === g);
    assert.ok(lista.length > 0, g);
    assert.ok(html.includes(`href="/packs#${g}"`), `acceso a /packs#${g}`);
    assert.ok(html.includes("$" + Math.min(...lista.map((p) => p.precio)).toLocaleString("es-AR")), `precio de los packs ${g}`);
  }
  assert.ok(!/envío gratis|revend|mayorista|desde 51/i.test(html), "no debe quedar nada del precio mayorista ni del envío gratis");
  assert.ok(html.includes("$" + datos.CONFIG.precioUnitario.toLocaleString("es-AR")));
  assert.match(html, /<noscript>[\s\S]*WhatsApp[\s\S]*<\/noscript>/);
});

test("el catálogo de ejemplo NO se escribe en el HTML: no se presentan ejemplos como productos reales", () => {
  const html = leer("index.html");
  for (const ejemplo of ["El gato del patrón", "Carpincho jefe", "Mate lavado"]) assert.ok(!html.includes(ejemplo), ejemplo);
});

test("la portada no contiene datos de producto inventados: ni Product, ni valoraciones, ni stock", () => {
  const html = leer("index.html");
  assert.doesNotMatch(html, /"@type"\s*:\s*"(Product|Offer|AggregateRating|Review|Rating)"/);
  assert.doesNotMatch(html, /ratingValue|reviewCount|availability|InStock/i);
});

// ---------- SEO técnico ----------

const PUBLICAS = { "/": "index.html", "/terminos": "terminos.html", "/privacidad": "privacidad.html", "/arrepentimiento": "arrepentimiento.html", "/packs": "packs.html" };

test("cada página pública tiene canonical https absoluto, título, descripción y metadatos sociales", () => {
  for (const [ruta, archivo] of Object.entries(PUBLICAS)) {
    const h = leer(archivo);
    const esperado = SITIO + (ruta === "/" ? "/" : ruta);
    assert.match(h, new RegExp(`<link rel="canonical" href="${esperado}">`), `canonical de ${archivo}`);
    assert.match(h, /<title>[^<]{10,}<\/title>/, archivo);
    assert.match(h, /<meta name="description" content="[^"]{40,}"/, archivo);
    assert.match(h, new RegExp(`<meta property="og:url" content="${esperado}">`), archivo);
    assert.match(h, /<meta property="og:title" content="[^"]+"/, archivo);
    assert.match(h, /<meta property="og:image" content="https:\/\/donsticker\.com\.ar\/assets\/[^"]+"/, archivo);
    assert.match(h, /<meta name="twitter:card" content="summary_large_image">/, archivo);
    assert.match(h, /<html lang="es-AR">/, archivo);
  }
});

test("las imágenes sociales apuntan a archivos que existen", () => {
  for (const archivo of Object.values(PUBLICAS)) {
    for (const m of leer(archivo).matchAll(/content="https:\/\/donsticker\.com\.ar(\/assets\/[^"]+)"/g)) assert.ok(existsSync(WEB + m[1].slice(1)), m[1]);
  }
});

test("la portada tiene un solo h1 y dice «stickers de vinilo»", () => {
  const h = leer("index.html");
  assert.equal((h.match(/<h1[ >]/g) || []).length, 1);
  assert.match(h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)[1], /stickers de vinilo/i);
});

test("los datos estructurados son JSON válido, con URLs absolutas y referencias que se resuelven", () => {
  const bloque = leer("index.html").match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(bloque, "falta el JSON-LD");
  const datos = JSON.parse(bloque[1]);
  const nodos = datos["@graph"];
  const ids = new Set(nodos.map((n) => n["@id"]));
  assert.ok(nodos.some((n) => n["@type"] === "Organization"));
  assert.ok(nodos.some((n) => n["@type"] === "WebSite"));
  for (const n of nodos) {
    assert.match(n.url, /^https:\/\/donsticker\.com\.ar\//);
    if (n.logo) assert.ok(existsSync(WEB + n.logo.replace(SITIO + "/", "")), "el logo existe");
    if (n.publisher) assert.ok(ids.has(n.publisher["@id"]));
  }
  assert.equal(nodos.find((n) => n["@type"] === "Organization").address.addressLocality, "Balcarce");
});

test("el sitemap lista solo páginas públicas que existen, con la misma URL que su canonical", () => {
  const xml = leer("sitemap.xml");
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(urls.sort(), Object.keys(PUBLICAS).map((r) => SITIO + r).sort());
  for (const u of urls) {
    const ruta = u.replace(SITIO, "") || "/";
    const archivo = archivoDe(ruta);
    assert.ok(archivo, `no existe ${ruta}`);
    assert.match(leer(archivo), new RegExp(`<link rel="canonical" href="${u}">`), u);
    assert.doesNotMatch(leer(archivo), /name="robots" content="[^"]*noindex/, `${u} es noindex y está en el sitemap`);
  }
  for (const privada of ["cuenta", "admin", "pago", "verificar", "restablecer", "baja", "api"]) assert.ok(!xml.includes(`/${privada}`), privada);
});

test("robots.txt declara el sitemap y no bloquea contenido ni las páginas noindex", () => {
  const r = leer("robots.txt");
  assert.match(r, /^Sitemap: https:\/\/donsticker\.com\.ar\/sitemap\.xml$/m);
  const disallows = [...r.matchAll(/^Disallow:\s*(\S*)/gim)].map((m) => m[1]);
  assert.deepEqual(disallows, ["/api/"], "solo la API; si se bloquea una página noindex el buscador no puede leer su noindex");
  assert.match(r, /^Allow: \/$/m);
  for (const bloqueado of ["/assets", "/css", "/js", "/fonts"]) assert.ok(!disallows.some((d) => d.startsWith(bloqueado)), bloqueado);
});

test("las páginas privadas llevan noindex en la etiqueta Y en la cabecera", () => {
  const cabeceras = leer("_headers");
  for (const p of ["admin", "cuenta", "pago", "verificar", "restablecer"]) {
    assert.match(leer(`${p}.html`), /<meta name="robots" content="[^"]*noindex/, `${p}.html sin meta noindex`);
    assert.match(cabeceras, new RegExp(`/${p}\\.html\\n(  [^\\n]+\\n)*  X-Robots-Tag: [^\\n]*noindex`), `${p}.html sin cabecera noindex`);
  }
});

// ---------- Cabeceras estáticas ----------

function reglas() {
  const salida = [];
  let actual = null;
  for (const linea of leer("_headers").split(/\r?\n/)) {
    if (!linea.trim() || linea.trim().startsWith("#")) continue;
    if (!linea.startsWith(" ")) { actual = { ruta: linea.trim(), cabeceras: {} }; salida.push(actual); continue; }
    const i = linea.indexOf(":");
    actual.cabeceras[linea.slice(0, i).trim().toLowerCase()] = linea.slice(i + 1).trim();
  }
  return salida;
}

test("cada regla de _headers es válida para Cloudflare: un solo comodín por regla", () => {
  for (const r of reglas()) assert.ok((r.ruta.match(/\*/g) || []).length <= 1, `«${r.ruta}» tiene más de un comodín y Cloudflare la ignoraría`);
});

test("la CSP de los estáticos no se abre de más y prohíbe ser embebida", () => {
  const csp = reglas().find((r) => r.ruta === "/*").cabeceras["content-security-policy"];
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  const scripts = csp.match(/script-src ([^;]+)/)[1];
  assert.doesNotMatch(scripts, /unsafe-inline|unsafe-eval|\*(?!\.)/, "los scripts solo de 'self' y de Google Identity");
  assert.equal(scripts.trim(), "'self' https://accounts.google.com/gsi/client");
  assert.doesNotMatch(csp, /googletagmanager|google-analytics/, "la analítica está apagada: su dominio no se habilita hasta que se use (ver Docs/ANALITICA.md)");
});

test("HSTS en los estáticos, sin includeSubDomains ni preload", () => {
  const h = reglas().find((r) => r.ruta === "/*").cabeceras["strict-transport-security"];
  assert.equal(h, "max-age=15552000");
});

test("los videos permiten pedir por tramos (Accept-Ranges)", () => {
  const r = reglas().find((x) => x.ruta === "/assets/*.mp4");
  assert.equal(r.cabeceras["accept-ranges"], "bytes");
});

test("solo los archivos con versión en el nombre se guardan «para siempre» (immutable)", () => {
  for (const r of reglas()) {
    if (!/immutable/.test(r.cabeceras["cache-control"] || "")) continue;
    assert.match(r.ruta, /-hq-v\d+\.(mp4|webp)$/, `«${r.ruta}» es immutable pero su nombre no lleva versión`);
    assert.ok(existsSync(WEB + r.ruta.slice(1)), `«${r.ruta}» no existe`);
  }
});

test("la portada ya no usa la escena de inicio (se quitó del diseño)", () => {
  const html = leer("index.html");
  assert.ok(!html.includes("escena.js"), "sigue cargándose escena.js");
  assert.ok(!html.includes('id="escena"'), "sigue la sección de la escena");
  assert.ok(existsSync(WEB + "js/banda.js"), "falta js/banda.js");
  assert.ok(html.includes('src="js/banda.js"'), "la portada no carga la banda");
});

test("las tipografías y los estáticos sin versión no quedan guardados de por vida", () => {
  for (const r of reglas()) {
    const cc = r.cabeceras["cache-control"] || "";
    const m = cc.match(/max-age=(\d+)/);
    if (m && !/-hq-v\d+/.test(r.ruta)) assert.ok(Number(m[1]) <= 2592000, `${r.ruta}: ${cc}`);
  }
});

// ---------- Enlaces y recursos ----------

test("todos los enlaces, imágenes, scripts y estilos internos de cada página existen", () => {
  for (const archivo of paginas) {
    const h = leer(archivo);
    for (const m of h.matchAll(/(?:href|src|srcset)="([^"]+)"/g)) {
      for (const crudo of m[1].split(",")) {
        const ref = crudo.trim().split(/\s+/)[0];
        if (!ref || ref.startsWith("#") || /^(https?:|mailto:|tel:|data:|javascript:)/.test(ref)) continue;
        if (ref.startsWith("/api/") || ref.startsWith("/baja")) continue; // rutas dinámicas del Worker, no archivos
        const ruta = ref.startsWith("/") ? ref : "/" + ref;
        assert.ok(archivoDe(ruta), `${archivo}: «${ref}» no existe`);
      }
    }
  }
});

test("las anclas internas de la portada apuntan a elementos que existen", () => {
  const h = leer("index.html");
  const ids = new Set([...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of h.matchAll(/href="#([^"]+)"/g)) if (m[1] !== "") assert.ok(ids.has(m[1]), `#${m[1]}`);
});

test("los scripts de la portada se cargan en el orden en que dependen entre sí", () => {
  const orden = [...leer("index.html").matchAll(/<script src="js\/([^"]+)"/g)].map((m) => m[1]);
  const i = (n) => orden.indexOf(n);
  assert.ok(i("data.js") < i("app.js") && i("cuenta.js") < i("app.js") && i("analitica.js") < i("cuenta.js") && i("app.js") < i("banda.js") && i("catalogo.js") < i("banda.js"), orden.join(" "));
});

test("la analítica está apagada por defecto: sin identificadores no hay scripts de terceros en las páginas", () => {
  for (const archivo of paginas) assert.doesNotMatch(leer(archivo), /googletagmanager|google-analytics|gtag\(|G-[A-Z0-9]{6,}|AW-\d{6,}/, archivo);
});

test("ningún JS de la web trae identificadores de analítica ni datos personales escritos a mano", () => {
  for (const f of readdirSync(WEB + "js")) {
    const c = leer("js/" + f);
    assert.doesNotMatch(c, /\bG-[A-Z0-9]{8,}\b|\bAW-\d{8,}\b/, f);
  }
});

test("las páginas de cuenta y de pago no cargan nada de terceros salvo Google Identity (que lo hace cuenta.js)", () => {
  for (const archivo of paginas) assert.doesNotMatch(leer(archivo), /<script[^>]+src="https?:/, archivo);
});

// ---------- Sección «Emprendé con stickers»: las cifras salen de los precios reales ----------

test("la sección de emprendedores muestra cifras que coinciden con los precios de los packs", async () => {
  const { PACKS, TIENDA } = await import("../src/precios.js");
  const html = leer("index.html");
  const bloque = html.slice(html.indexOf('id="emprendedores"'), html.indexOf('id="a-medida"'));
  assert.ok(bloque.length > 500, "falta la sección #emprendedores");
  const miles = (n) => "$" + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const celdas = (tabla) => [...bloque.slice(bloque.indexOf(tabla)).matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/g)].map((c) => c[1]));
  const costo = celdas('id="emprende-tabla-costo"');
  for (const tam of [10, 25, 50, 100]) {
    const pack = PACKS.find((p) => p.id === `pack-${tam}-01`);
    const c = Math.round(pack.precioTransferencia / pack.unidades);
    const fila = costo.find((f) => f[0] === `Pack de ${tam}`);
    assert.ok(fila, `falta la fila del Pack de ${tam}`);
    assert.deepEqual(fila.slice(1), [miles(pack.precioTransferencia), miles(c), miles(1000 - c), miles(1200 - c), miles(1500 - c)], `Pack de ${tam}`);
  }
  const p100 = PACKS.find((p) => p.id === "pack-100-01").precioTransferencia;
  const metas = celdas('id="emprende-tabla-metas"');
  for (const [etq, n] of [["50 stickers", 50], ["70 stickers", 70], ["Los 100", 100]]) {
    const fila = metas.find((f) => f[0] === etq);
    assert.deepEqual(fila.slice(1), [1000, 1200, 1500].map((v) => miles(n * v - p100)), etq);
  }
  const zona1 = 14000;
  assert.match(bloque, new RegExp(String.raw`con ${Math.ceil(p100 / 1000)} stickers a \$1\.000`));
  assert.match(bloque, new RegExp(String.raw`vendiendo ${Math.ceil((p100 + zona1) / 1000)}\.`));
  assert.ok(TIENDA.puntosDeEntrega.includes("Balcarce") && TIENDA.puntosDeEntrega.includes("Mar del Plata"));
  assert.match(bloque, /Balcarce o Mar del Plata/);
  assert.ok(!/garantiz/i.test(bloque.replace(/no una promesa/i, "")), "no prometer ganancias");
});

// ---------- Que el navegador no lea campos de CONFIG que no existen (daba «$NaN») ----------

test("todo CONFIG.campo que usa la web existe en data.js", () => {
  const datos = leer("js/data.js");
  const bloque = datos.slice(datos.indexOf("const CONFIG"), datos.indexOf("};", datos.indexOf("const CONFIG")));
  const campos = new Set([...bloque.matchAll(/^\s{2}(\w+)\s*:/gm)].map((m) => m[1]));
  assert.ok(campos.size > 5, "no se pudieron leer los campos de CONFIG");
  const faltan = [];
  for (const f of readdirSync(WEB + "js").filter((n) => n.endsWith(".js") && n !== "data.js" && n !== "catalogo.js")) {
    for (const m of leer("js/" + f).matchAll(/\bCONFIG\.(\w+)/g)) if (!campos.has(m[1])) faltan.push(`${f}: CONFIG.${m[1]}`);
  }
  assert.deepEqual([...new Set(faltan)], [], "campos de CONFIG que no existen en data.js");
});
