// Copia el contenido de los packs (qué diseños lleva cada uno) de worker/src/packs-contenido.js a web/js/packs-contenido.js,
// para que la ventana «Qué trae este pack» lo muestre. La fuente es el archivo del servidor (lo genera armar_packs.py).
// Uso: node scripts/sincronizar-packs-web.mjs        (escribe)   |   --check   (falla si están distintos; lo usa un test)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PACKS_CONTENIDO } from "../src/packs-contenido.js";

const destino = fileURLToPath(new URL("../../web/js/packs-contenido.js", import.meta.url));
export const generar = () =>
  "// Qué diseños lleva cada pack prearmado (para la ventana «Qué trae este pack»).\n" +
  "// GENERADO por worker/scripts/sincronizar-packs-web.mjs desde worker/src/packs-contenido.js: no editar a mano.\n" +
  "const PACKS_CONTENIDO = " + JSON.stringify(PACKS_CONTENIDO) + ";\n";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    let actual = "";
    try { actual = readFileSync(destino, "utf8"); } catch { /* no existe */ }
    if (actual !== generar()) { console.error("web/js/packs-contenido.js está desactualizado: correr node scripts/sincronizar-packs-web.mjs"); process.exit(1); }
    console.log("web/js/packs-contenido.js al día");
  } else {
    writeFileSync(destino, generar());
    console.log("escrito web/js/packs-contenido.js");
  }
}
