// Pruebas de las mejoras de experiencia de la web: contenido de packs para la vista rápida, app instalable y modo oscuro.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generar } from "../scripts/sincronizar-packs-web.mjs";

const WEB = fileURLToPath(new URL("../../web/", import.meta.url));
const leer = (r) => readFileSync(WEB + r, "utf8");
const web = vm.runInNewContext(`${leer("js/data.js")}\n${leer("js/catalogo.js")}\n${leer("js/packs-contenido.js")}\n({ PACKS, PRODUCTOS, PACKS_CONTENIDO })`);

test("web/js/packs-contenido.js es copia fiel del contenido que usa el servidor", () => {
  assert.equal(leer("js/packs-contenido.js"), generar(), "Corré: node scripts/sincronizar-packs-web.mjs");
});

test("cada pack prearmado tiene su contenido, con tantos diseños como unidades y todos existentes en el catálogo", () => {
  const ids = new Set(web.PRODUCTOS.map((p) => p.id));
  for (const p of web.PACKS) {
    const lista = web.PACKS_CONTENIDO[p.id];
    assert.ok(Array.isArray(lista), `${p.id} sin contenido`);
    assert.equal(lista.length, p.unidades, `${p.id}: ${lista.length} diseños y dice ${p.unidades}`);
    for (const d of lista) assert.ok(ids.has(d), `${p.id} lleva ${d}, que no está en el catálogo`);
  }
});

test("la app instalable: manifest válido, íconos existentes y service worker presente", () => {
  const m = JSON.parse(leer("manifest.webmanifest"));
  assert.equal(m.display, "standalone");
  assert.ok(m.start_url.startsWith("/"));
  for (const i of m.icons) assert.ok(existsSync(WEB + i.src.replace(/^\//, "")), `falta ${i.src}`);
  assert.ok(m.icons.some((i) => i.purpose === "maskable"));
  assert.ok(m.icons.some((i) => i.sizes === "512x512"));
  assert.ok(existsSync(WEB + "sw.js") && existsSync(WEB + "offline.html"));
});

test("el service worker no guarda la API, el panel ni páginas con datos de la persona", () => {
  const sw = leer("sw.js");
  for (const ruta of ["api\\/", "admin", "cuenta", "pago"]) assert.ok(sw.includes(ruta), `sw.js debe excluir ${ruta}`);
});

test("todas las páginas cargan el modo del dispositivo antes de pintar y declaran el manifest", () => {
  for (const f of readdirSync(WEB).filter((x) => x.endsWith(".html"))) {
    const h = leer(f);
    assert.ok(h.includes('src="js/tema-inicial.js"') || h.includes('src="/js/tema-inicial.js"'), `${f} sin tema-inicial.js`);
    if (f !== "offline.html") assert.ok(h.includes('rel="manifest"'), `${f} sin manifest`);
    assert.ok(h.indexOf("tema-inicial.js") < h.indexOf("styles.css"), `${f}: tema-inicial.js debe ir antes del CSS`);
  }
});

test("el modo oscuro define sus colores y no deja el rojo de texto sin versión clara", () => {
  const css = leer("css/styles.css");
  assert.ok(css.includes('[data-tema="oscuro"]') && css.includes("prefers-color-scheme: dark"));
  assert.ok(css.includes("--rojo-fondo"), "debe existir --rojo-fondo para los fondos rojos");
});

test("los avisos breves (toast) existen, van en la capa superior y respetan reducir movimiento", () => {
  const ux = leer("js/ux.js");
  assert.ok(ux.includes("window.Aviso") && ux.includes('setAttribute("popover", "manual")'));
  assert.ok(ux.includes('"offline"') && ux.includes('"online"'));
  const css = leer("css/styles.css");
  assert.ok(css.includes(".aviso-toast") && /prefers-reduced-motion[^}]*\n?[^}]*aviso-toast/.test(css));
  assert.ok(leer("js/app.js").includes("avisarAlSumar") && leer("js/packs.js").includes("Aviso.mostrar"));
});
