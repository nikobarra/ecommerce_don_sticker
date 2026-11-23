// HTML inicial indexable: precios, packs y datos de contacto escritos en la portada desde web/js/data.js.
//
// Por qué: el catálogo y los precios los arma JavaScript al cargar la página. Google ejecuta JavaScript, pero un
// buscador, una vista previa o un navegador sin scripts ven antes el HTML. Acá se escribe ese HTML a partir de los
// MISMOS datos (data.js), así las reglas de precios siguen en un solo lugar y nada se copia a mano.
//
// Uso (desde worker/):
//   npm run prerender          reescribe web/index.html
//   npm run prerender:check    falla si web/index.html no coincide con lo que generaría (lo corre la suite de pruebas)
//
// Solo se pre-renderiza lo que es información comercial real y estable: reglas de precio y packs. El catálogo de
// diseños a elección NO se pre-renderiza: hoy son ejemplos, y no deben figurar como productos de la tienda.

import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../../web/", import.meta.url));

// Mismo formato que web/js/app.js (pesos).
const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");

export function cargarDatos(codigo) {
  return JSON.parse(JSON.stringify(vm.runInNewContext(`${codigo}\n({ CONFIG, PACKS })`)));
}

// Misma fórmula que web/js/app.js y worker/src/precios.js.
const redondear10 = (n) => Math.round(n / 10) * 10;
const aTransferencia = (CONFIG, lista) => redondear10(lista * (1 - CONFIG.descuentoTransferencia));

// Lo que app.js escribe en cada [data-...] (se mantiene igual que allá).
function textosFijos({ CONFIG }) {
  return {
    "data-lugares": CONFIG.puntosDeEntrega.join(" o "),
    "data-unitario": pesos(CONFIG.precioUnitario),
    "data-unitario-transferencia": pesos(aTransferencia(CONFIG, CONFIG.precioUnitario)),
    "data-tramo-minimo": pesos(CONFIG.tramos[CONFIG.tramos.length - 1].precio),
  };
}

function escalones({ CONFIG }) {
  const filas = [{ desde: 1, hasta: 9, precio: CONFIG.precioUnitario }, ...CONFIG.tramos.map((t, i, a) => ({ desde: t.desde, hasta: i < a.length - 1 ? a[i + 1].desde - 1 : null, precio: t.precio }))];
  return filas.map((t, i, todos) => `
    <div class="escalon${i === todos.length - 1 ? " escalon--destacado" : ""}">
      <p class="escalon__cant">${t.hasta === null ? `${t.desde} o más` : t.desde === t.hasta ? `${t.desde}` : `${t.desde} a ${t.hasta}`} a elección</p>
      <p class="escalon__precio">${pesos(t.precio)}</p>
      <p class="escalon__nota">cada uno. Elegís los diseños.</p>
      <p class="escalon__transferencia">${pesos(t.precio * (1 - CONFIG.descuentoTransferencia))} por transferencia</p>
    </div>`).join("");
}

// Accesos a packs.html (los mismos que arma app.js). Son enlaces comunes: andan sin JavaScript.
const GRUPOS_PACKS = [
  { g: "10", titulo: "Packs de 10", unidades: 10 },
  { g: "25", titulo: "Packs de 25", unidades: 25 },
  { g: "50", titulo: "Packs de 50", unidades: 50 },
  { g: "100", titulo: "Packs de 100", unidades: 100 },
  { g: "tematicos", titulo: "Packs temáticos", unidades: 0 },
];
function packs({ CONFIG, PACKS }) {
  return GRUPOS_PACKS.map((gr, i) => {
    const lista = PACKS.filter((p) => p.grupo === gr.g);
    if (!lista.length) return "";
    const desde = Math.min(...lista.map((p) => p.precio));
    const arte = `<img src="assets/packs/${gr.unidades ? "tramo-" + gr.unidades : "tema-simpson-10"}.webp" alt="" loading="lazy" width="320" height="320">`;
    const detalle = gr.unidades ? `${lista.length} packs prearmados de ${gr.unidades} stickers` : `${lista.length} packs de una sola temática`;
    return `<a class="tarjeta tarjeta--pack tarjeta--enlace" href="/packs#${gr.g}" data-id="grupo-${gr.g}" style="--r:${i % 2 ? 1.5 : -1.5}deg">
        <div class="tarjeta__arte">${arte}</div>
        <h3>${gr.titulo}</h3>
        <p class="tarjeta__dato">${detalle}</p>
        <div class="tarjeta__pie">
          <span class="tarjeta__precio">${gr.unidades ? "" : "Desde "}${pesos(desde)}<small>${pesos(aTransferencia(CONFIG, desde))} transfiriendo</small></span>
          <span class="agregar agregar--ver" aria-hidden="true">Ver packs</span>
        </div>
      </a>`;
  }).join("");
}

function sinJs({ CONFIG }) {
  const wa = String(CONFIG.whatsapp || "");
  const telefono = wa.replace(/^(\d{2})(\d)(\d{4})(\d+)$/, "+$1 $2 $3 $4");
  return `Para elegir diseños y armar el pedido hace falta JavaScript. Si no lo tenés activado, escribinos por WhatsApp al <a href="https://wa.me/${wa}">${telefono}</a> o por mail a <a href="mailto:${CONFIG.email}">${CONFIG.email}</a> y te ayudamos con el pedido.`;
}

export function prerender(html, datos) {
  let salida = html;
  const region = (nombre, contenido) => {
    const re = new RegExp(`(<!--pre:${nombre}-->)[\\s\\S]*?(<!--/pre:${nombre}-->)`);
    if (!re.test(salida)) throw new Error(`Falta el marcador pre:${nombre} en index.html`);
    salida = salida.replace(re, (_m, a, b) => `${a}${contenido}${b}`);
  };
  region("escalones", escalones(datos));
  region("packs", packs(datos));
  region("sinjs", sinJs(datos));

  // [data-xxx] con texto: <span data-xxx>…</span> o <strong data-xxx>…</strong>.
  for (const [atributo, texto] of Object.entries(textosFijos(datos))) {
    const re = new RegExp(`(<(span|strong)\\s+${atributo}>)[^<]*(</\\2>)`, "g");
    salida = salida.replace(re, (_m, a, _t, c) => `${a}${texto}${c}`);
  }
  // Enlaces de contacto de las preguntas frecuentes.
  const wa = String(datos.CONFIG.whatsapp || "");
  salida = salida.replace(/<a data-whatsapp href="[^"]*"[^>]*>[^<]*<\/a>/g,
    `<a data-whatsapp href="https://wa.me/${wa}" target="_blank" rel="noopener">${wa.replace(/^(\d{2})(\d)(\d{4})(\d+)$/, "+$1 $2 $3 $4")}</a>`);
  salida = salida.replace(/<a data-email-enlace href="[^"]*"[^>]*>[^<]*<\/a>/g,
    `<a data-email-enlace href="mailto:${datos.CONFIG.email}">${datos.CONFIG.email}</a>`);
  return salida;
}

// ---- Uso desde la línea de comandos ----
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ruta = RAIZ + "index.html";
  const original = readFileSync(ruta, "utf8");
  const generado = prerender(original, cargarDatos(readFileSync(RAIZ + "js/data.js", "utf8")));
  if (process.argv.includes("--check")) {
    if (generado !== original) { console.error("web/index.html no coincide con data.js. Corré: npm run prerender"); process.exit(1); }
    console.log("web/index.html está al día con data.js");
  } else {
    writeFileSync(ruta, generado);
    console.log(generado === original ? "Sin cambios." : "web/index.html actualizado desde data.js.");
  }
}
