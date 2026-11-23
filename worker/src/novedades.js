// Mail semanal de novedades.
//
// - Se arma una vez por semana (por defecto los jueves desde las 13 UTC = 10 h de Argentina), solo si hay
//   diseños nuevos que todavía no se mandaron. Sin novedades, esa semana no sale nada.
// - Destinatarios: quienes aceptaron novedades Y confirmaron su mail. Se vuelve a revisar justo antes de
//   mandarle a cada uno (si se dio de baja en el medio, no le llega).
// - Se manda por tandas desde el cron (cada 15 minutos): hasta NOVEDADES_LOTE por corrida y hasta
//   NOVEDADES_TOPE_DIARIO por día, para dejar lugar a los avisos de pedidos dentro del límite de Resend.
// - Apagado salvo NOVEDADES_ACTIVO = "1". La vista previa y la prueba del panel funcionan igual.
//
// Los diseños salen de /novedades.json (lo genera catalogo/herramientas/importar_nuevos.py) y las imágenes
// de /assets/mail/<id>.png (PNG chico: los programas de mail no siempre muestran WebP).

import { json, error, ahora } from "./util.js";
import { usuarioActual, usuarioPublico } from "./auth.js";
import { enviarMail, urlSitio } from "./mail.js";

const MAX_EN_MAIL = 12;
const INTENTOS_MAX = 3;

const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const numero = (v, def) => (Number.isFinite(Number(v)) && String(v ?? "").trim() !== "" ? Number(v) : def);

export const config = (env) => ({
  activo: env.NOVEDADES_ACTIVO === "1",
  dia: numero(env.NOVEDADES_DIA, 4), // 0 = domingo … 4 = jueves
  horaUtc: numero(env.NOVEDADES_HORA_UTC, 13),
  lote: numero(env.NOVEDADES_LOTE, 15),
  topeDiario: numero(env.NOVEDADES_TOPE_DIARIO, 80),
});

// Semana ISO: «2026-W47».
export function semanaIso(fecha) {
  const d = new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate()));
  const dia = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dia);
  const inicioAnio = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const semana = Math.ceil(((d - inicioAnio) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(semana).padStart(2, "0")}`;
}

// ---------- Diseños ----------
async function leerNovedades(env) {
  try {
    const r = await env.ASSETS.fetch(new Request(`${urlSitio(env) || "https://donsticker.com.ar"}/novedades.json`));
    if (!r.ok) return [];
    const datos = await r.json();
    return Array.isArray(datos) ? datos.filter((d) => d && typeof d.id === "string" && typeof d.nombre === "string") : [];
  } catch {
    return [];
  }
}

async function idsYaEnviados(env) {
  const { results } = await env.DB.prepare("SELECT items_json FROM newsletters WHERE estado != 'sin_novedades'").all();
  const ids = new Set();
  for (const r of results || []) for (const d of JSON.parse(r.items_json || "[]")) ids.add(d.id);
  return ids;
}

// Los diseños nuevos que todavía no salieron en ningún mail, del más nuevo al más viejo.
export async function disenosPendientes(env) {
  const enviados = await idsYaEnviados(env);
  return (await leerNovedades(env))
    .filter((d) => !enviados.has(d.id))
    .sort((a, b) => String(b.fecha || "").localeCompare(String(a.fecha || "")) || (b.numero || 0) - (a.numero || 0));
}

// ---------- El mail ----------
export function armarMail({ items, semana, sitio, nombre, bajaUrl }) {
  const visibles = items.slice(0, MAX_EN_MAIL);
  const resto = items.length - visibles.length;
  const n = items.length;
  const campania = `utm_source=novedades&utm_medium=email&utm_campaign=novedades-${encodeURIComponent(semana)}`;
  const urlCatalogo = `${sitio}/?${campania}#catalogo`;
  const subject = n === 1 ? "Novedades en Don Sticker: 1 diseño nuevo" : `Novedades en Don Sticker: ${n} diseños nuevos`;
  const hola = nombre ? `Hola, ${nombre}.` : "Hola.";
  const intro = n === 1 ? "Esta semana entró un diseño nuevo a la casa." : `Esta semana entraron ${n} diseños nuevos a la casa.`;

  const texto = [
    hola, "", intro, "",
    ...visibles.map((d) => `• ${d.nombre} (${d.codigo || String(d.id).toUpperCase()})`),
    ...(resto > 0 ? [`… y ${resto} más.`] : []),
    "", `Velos en el catálogo: ${urlCatalogo}`,
    "", "Don Sticker. No es personal, son solo stickers.",
    `Para no recibir más estos mails: ${bajaUrl}`,
  ].join("\n");

  // Tabla de dos columnas: es lo que mejor se ve en todos los programas de mail.
  const celda = (d) => {
    const codigo = d.codigo || String(d.id).toUpperCase();
    return `<td width="50%" valign="top" style="padding:8px;text-align:center">
<a href="${esc(urlCatalogo)}" style="text-decoration:none;color:#160000">
<img src="${esc(`${sitio}/assets/mail/${d.id}.png`)}" width="200" alt="${esc(d.nombre)}" style="display:block;margin:0 auto 8px;max-width:100%;height:auto;border:0">
<span style="display:block;font-weight:700;font-size:15px">${esc(d.nombre)}</span>
<span style="display:block;font-size:13px;color:#812120">Código ${esc(codigo)}</span></a></td>`;
  };
  const filas = [];
  for (let i = 0; i < visibles.length; i += 2) {
    filas.push(`<tr>${celda(visibles[i])}${visibles[i + 1] ? celda(visibles[i + 1]) : '<td width="50%"></td>'}</tr>`);
  }
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#FDF4E6;font-family:Arial,Helvetica,sans-serif;color:#160000">
<div style="max-width:560px;margin:0 auto;padding:28px 16px">
<h1 style="font-size:26px;margin:0 0 6px;color:#FD0000">Novedades de la semana</h1>
<p style="margin:0 0 18px">${esc(hola)} ${esc(intro)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${filas.join("")}</table>
${resto > 0 ? `<p style="margin:14px 0 0;text-align:center">Y ${resto} más en el catálogo.</p>` : ""}
<p style="margin:24px 0;text-align:center"><a href="${esc(urlCatalogo)}" style="background:#160000;color:#FDF4E6;padding:13px 22px;border-radius:999px;text-decoration:none;font-weight:700">Ver el catálogo</a></p>
<p style="font-size:13px;color:#812120;margin:28px 0 6px">Don Sticker. No es personal, son solo stickers.</p>
<p style="font-size:12px;color:#812120;margin:0">Te llega porque aceptaste recibir novedades. <a href="${esc(bajaUrl)}" style="color:#812120">Darme de baja</a></p>
</div></body></html>`;
  return { subject, text: texto, html };
}

// Mails del dueño (ADMIN_EMAILS), en minúsculas.
const mailsDuenos = (env) => String(env.ADMIN_EMAILS || "").split(",").map((m) => m.trim().toLowerCase()).filter(Boolean);

// ---------- Armado semanal (cron) ----------
export async function crearSemanal(env, fecha = new Date()) {
  const c = config(env);
  if (!c.activo) return null;
  if (fecha.getUTCDay() !== c.dia || fecha.getUTCHours() < c.horaUtc) return null;
  const semana = semanaIso(fecha);
  if (await env.DB.prepare("SELECT 1 FROM newsletters WHERE semana = ?").bind(semana).first()) return null;

  const items = await disenosPendientes(env);
  const id = crypto.randomUUID();
  const t = ahora();
  const lista = items.map((d) => ({ id: d.id, nombre: d.nombre, codigo: d.codigo || d.id.toUpperCase(), fecha: d.fecha }));
  if (!items.length) {
    await env.DB.prepare("INSERT OR IGNORE INTO newsletters (id, semana, subject, items_json, estado, total, enviados, created_at, updated_at) VALUES (?, ?, '', '[]', 'sin_novedades', 0, 0, ?, ?)")
      .bind(id, semana, t, t).run();
    return { semana, estado: "sin_novedades", total: 0 };
  }
  const sitio = urlSitio(env);
  const { subject } = armarMail({ items: lista, semana, sitio, nombre: "", bajaUrl: "" });
  const alta = await env.DB.prepare("INSERT OR IGNORE INTO newsletters (id, semana, subject, items_json, estado, total, enviados, created_at, updated_at) VALUES (?, ?, ?, ?, 'enviando', 0, 0, ?, ?)")
    .bind(id, semana, subject, JSON.stringify(lista), t, t).run();
  if (!alta.meta?.changes) return null; // otra corrida la creó al mismo tiempo

  // El dueño recibe siempre su copia, primero y aunque no esté suscripto. Por eso queda fuera de la lista
  // de suscriptores (así no le llega dos veces) y del tope diario.
  const duenos = mailsDuenos(env);
  for (const mail of duenos) {
    try {
      const copia = armarMail({ items: lista, semana, sitio, nombre: "", bajaUrl: `${sitio}/admin.html` });
      await enviarMail(env, { to: mail, subject: copia.subject, text: copia.text, html: copia.html, tipo: "novedades" });
    } catch (e) {
      console.error("Novedades: copia al dueño fallida:", e.message);
    }
  }
  const excluir = duenos.length ? ` AND lower(email) NOT IN (${duenos.map(() => "?").join(", ")})` : "";
  await env.DB.prepare(
    `INSERT OR IGNORE INTO newsletter_envios (newsletter_id, user_id) SELECT ?, id FROM users WHERE marketing_consent = 1 AND email_verified = 1${excluir}`,
  ).bind(id, ...duenos).run();
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM newsletter_envios WHERE newsletter_id = ?").bind(id).first();
  await env.DB.prepare("UPDATE newsletters SET total = ?, estado = CASE WHEN ? = 0 THEN 'terminado' ELSE estado END WHERE id = ?").bind(n, n, id).run();
  return { semana, estado: n ? "enviando" : "terminado", total: n, disenos: lista.length };
}

// ---------- Envío por tandas (cron) ----------
export async function enviarLote(env, fecha = new Date()) {
  const c = config(env);
  if (!c.activo) return { enviados: 0 };
  const boletin = await env.DB.prepare("SELECT * FROM newsletters WHERE estado = 'enviando' ORDER BY created_at LIMIT 1").first();
  if (!boletin) return { enviados: 0 };

  const inicioDia = new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate())).toISOString();
  const { hoy } = await env.DB.prepare("SELECT COUNT(*) AS hoy FROM newsletter_envios WHERE estado = 'enviado' AND enviado_at >= ?").bind(inicioDia).first();
  const cupo = Math.max(0, Math.min(c.lote, c.topeDiario - hoy));
  if (!cupo) return { enviados: 0, tope: true };

  const { results } = await env.DB.prepare(
    `SELECT e.user_id, e.intentos, u.email, u.name, u.unsubscribe_token, u.marketing_consent, u.email_verified
     FROM newsletter_envios e LEFT JOIN users u ON u.id = e.user_id
     WHERE e.newsletter_id = ? AND e.estado = 'pendiente' ORDER BY e.user_id LIMIT ?`,
  ).bind(boletin.id, cupo).all();

  const sitio = urlSitio(env);
  const items = JSON.parse(boletin.items_json);
  let enviados = 0;
  for (const r of results || []) {
    // Se revisa de nuevo: puede haberse dado de baja (o borrado la cuenta) desde que se armó el envío.
    if (!r.email || r.marketing_consent !== 1 || r.email_verified !== 1) {
      await env.DB.prepare("UPDATE newsletter_envios SET estado = 'omitido' WHERE newsletter_id = ? AND user_id = ?").bind(boletin.id, r.user_id).run();
      continue;
    }
    const bajaUrl = `${sitio}/baja?t=${encodeURIComponent(r.unsubscribe_token)}`;
    const mail = armarMail({ items, semana: boletin.semana, sitio, nombre: r.name || "", bajaUrl });
    try {
      await enviarMail(env, { to: r.email, subject: mail.subject, text: mail.text, html: mail.html, bajaUrl, tipo: "novedades" });
      // Con la misma fecha con la que se cuenta el tope del día.
      await env.DB.prepare("UPDATE newsletter_envios SET estado = 'enviado', intentos = intentos + 1, enviado_at = ? WHERE newsletter_id = ? AND user_id = ?")
        .bind(fecha.toISOString(), boletin.id, r.user_id).run();
      enviados++;
    } catch (e) {
      console.error("Novedades: envío fallido:", e.message); // sin datos personales
      const estado = r.intentos + 1 >= INTENTOS_MAX ? "error" : "pendiente";
      await env.DB.prepare("UPDATE newsletter_envios SET estado = ?, intentos = intentos + 1 WHERE newsletter_id = ? AND user_id = ?")
        .bind(estado, boletin.id, r.user_id).run();
    }
  }

  const { quedan } = await env.DB.prepare("SELECT COUNT(*) AS quedan FROM newsletter_envios WHERE newsletter_id = ? AND estado = 'pendiente'").bind(boletin.id).first();
  const { listos } = await env.DB.prepare("SELECT COUNT(*) AS listos FROM newsletter_envios WHERE newsletter_id = ? AND estado = 'enviado'").bind(boletin.id).first();
  await env.DB.prepare("UPDATE newsletters SET enviados = ?, estado = CASE WHEN ? = 0 THEN 'terminado' ELSE estado END, updated_at = ? WHERE id = ?")
    .bind(listos, quedan, ahora(), boletin.id).run();
  return { enviados, quedan };
}

export async function tareaNovedades(env) {
  await crearSemanal(env);
  await enviarLote(env);
}

// ---------- Panel ----------
async function soloDueno(env, request) {
  const u = await usuarioActual(env, request);
  if (!u) return { respuesta: error("sin_sesion", "Ingresá a tu cuenta.", 401) };
  if (!usuarioPublico(env, u).admin) return { respuesta: error("prohibido", "No tenés permiso para ver esto.", 403) };
  return { u };
}

export async function estadoNovedades(request, env) {
  const { u, respuesta } = await soloDueno(env, request);
  if (!u) return respuesta;
  const c = config(env);
  const pendientes = await disenosPendientes(env);
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE marketing_consent = 1 AND email_verified = 1").first();
  const { results } = await env.DB.prepare("SELECT semana, subject, estado, total, enviados, created_at FROM newsletters ORDER BY created_at DESC LIMIT 8").all();
  return json({
    activo: c.activo, dia: c.dia, horaUtc: c.horaUtc, topeDiario: c.topeDiario,
    suscriptores: n, disenosPendientes: pendientes.length,
    envios: (results || []).map((r) => ({ semana: r.semana, asunto: r.subject, estado: r.estado, total: r.total, enviados: r.enviados, creado: r.created_at })),
  });
}

async function mailDePrueba(env, nombre) {
  const sitio = urlSitio(env);
  let items = await disenosPendientes(env);
  // Si no hay nada pendiente, se muestran los últimos diseños nuevos para ver cómo queda.
  if (!items.length) items = (await leerNovedades(env)).slice(0, 4);
  const lista = items.map((d) => ({ id: d.id, nombre: d.nombre, codigo: d.codigo || d.id.toUpperCase() }));
  return { lista, mail: armarMail({ items: lista, semana: semanaIso(new Date()), sitio, nombre, bajaUrl: `${sitio}/baja?t=prueba` }) };
}

// La vista previa necesita mostrar las imágenes del propio sitio y los estilos del mail (que van en línea).
// Nada más: ni scripts, ni otros orígenes, ni formularios.
const CSP_VISTA_PREVIA = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export async function vistaPreviaNovedades(request, env) {
  const { u, respuesta } = await soloDueno(env, request);
  if (!u) return respuesta;
  const { lista, mail } = await mailDePrueba(env, u.name || "");
  const cabeceras = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": CSP_VISTA_PREVIA };
  if (!lista.length) return new Response("<p>Todavía no hay diseños nuevos para mostrar.</p>", { headers: cabeceras });
  return new Response(mail.html, { headers: cabeceras });
}

export async function pruebaNovedades(request, env) {
  const { u, respuesta } = await soloDueno(env, request);
  if (!u) return respuesta;
  const { lista, mail } = await mailDePrueba(env, u.name || "");
  if (!lista.length) return error("sin_novedades", "Todavía no hay diseños nuevos para mostrar.", 409);
  await enviarMail(env, { to: u.email, subject: `[Prueba] ${mail.subject}`, text: mail.text, html: mail.html, tipo: "novedades" });
  return json({ ok: true, para: u.email, disenos: lista.length });
}
