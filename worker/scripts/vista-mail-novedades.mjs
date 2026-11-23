// Vista previa local del mail de novedades (no manda nada).
// Uso, desde worker/: node scripts/vista-mail-novedades.mjs  -> escribe vista-mail-novedades.html junto a web/
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { armarMail, semanaIso } from "../src/novedades.js";

const web = fileURLToPath(new URL("../../web/", import.meta.url));
const items = JSON.parse(readFileSync(web + "novedades.json", "utf8"));
const sitio = pathToFileURL(web).href.replace(/\/$/, "");
const { subject, html } = armarMail({ items, semana: semanaIso(new Date()), sitio, nombre: "Nico", bajaUrl: "#baja" });
// Las imágenes van incrustadas para que la vista previa se vea igual en cualquier visor.
const conImagenes = html.replace(new RegExp(`${sitio.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/assets/mail/(ds-\\d+)\\.png`, "g"),
  (_, id) => "data:image/png;base64," + readFileSync(`${web}assets/mail/${id}.png`).toString("base64"));
const salida = fileURLToPath(new URL("../vista-mail-novedades.html", import.meta.url));
writeFileSync(salida, conImagenes);
console.log(`${subject}\n${salida}`);
