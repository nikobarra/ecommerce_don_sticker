// Conteo de visitas. La página avisa que se abrió y acá se suma uno a un contador.
// No se guarda NADA de quien visita: ni IP, ni navegador, ni identificador.
// Para que nadie infle los números a fuerza de recargar hay un tope por hora, que se cuenta con una HUELLA
// diaria de la IP (SHA-256, ver util.huella): la IP en sí no se guarda en ningún lado.

import { leerJson, limitarPor, ipDe } from "./util.js";

// Rutas que contamos. Cualquier otra entra como "otra", así nadie puede
// llenar la tabla inventando direcciones.
const RUTAS = new Set(["/", "/cuenta", "/pago", "/terminos", "/privacidad", "/arrepentimiento", "/verificar", "/restablecer", "/baja"]);

export function normalizarRuta(ruta) {
  let r = String(ruta || "/").split("?")[0].split("#")[0].toLowerCase();
  r = r.replace(/\.html$/, "");
  if (r.length > 1) r = r.replace(/\/+$/, "");
  if (r === "" || r === "/index") r = "/";
  return RUTAS.has(r) ? r : "otra";
}

export async function registrarVisita(request, env) {
  const lectura = await leerJson(request, 400);
  const datos = lectura.ok ? lectura.datos : {};
  const ruta = normalizarRuta(datos.ruta);
  const nueva = datos.nueva === true;

  // Tope: hasta 120 páginas por hora por visitante (huella diaria, no la IP).
  if (!(await limitarPor(env, "visita", ipDe(request), 120, 3600))) return new Response(null, { status: 204 });

  const dia = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    "INSERT INTO page_views (day, path, views, visits) VALUES (?, ?, 1, ?) ON CONFLICT(day, path) DO UPDATE SET views = views + 1, visits = visits + ?",
  ).bind(dia, ruta, nueva ? 1 : 0, nueva ? 1 : 0).run();

  return new Response(null, { status: 204 });
}
