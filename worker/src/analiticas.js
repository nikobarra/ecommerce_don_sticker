// Analíticas del panel: qué se vende, quién compra y cuánta gente entra.
// Todo sale de las tablas que ya existen; las visitas, de los contadores de page_views.

import { json, error } from "./util.js";
import { ESTADOS } from "./precios.js";
import { usuarioActual, usuarioPublico } from "./auth.js";

const DIA = /^\d{4}-\d{2}-\d{2}$/;
const hoy = () => new Date().toISOString().slice(0, 10);
const sumarDias = (dia, n) => new Date(Date.parse(dia + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// Devuelve el período pedido, acotado a algo razonable.
export function periodoDe(url) {
  const p = url.searchParams;
  const hasta = DIA.test(p.get("hasta") || "") ? p.get("hasta") : hoy();
  const porDefecto = sumarDias(hasta, -29);
  let desde = DIA.test(p.get("desde") || "") ? p.get("desde") : porDefecto;
  if (desde > hasta) desde = hasta;
  const dias = Math.round((Date.parse(hasta) - Date.parse(desde)) / 86400000) + 1;
  // El límite inferior y superior se usan contra created_at, que es una fecha ISO completa.
  return { desde, hasta, dias, inicio: desde, fin: sumarDias(hasta, 1) };
}

const filas = async (env, sql, ...params) => (await env.DB.prepare(sql).bind(...params).all()).results || [];

export async function analiticas(request, env) {
  const u = await usuarioActual(env, request);
  if (!u) return error("sin_sesion", "Ingresá a tu cuenta.", 401);
  if (!usuarioPublico(env, u).admin) return error("prohibido", "No tenés permiso para ver esto.", 403);

  const { desde, hasta, dias, inicio, fin } = periodoDe(new URL(request.url));
  const rango = [inicio, fin];

  // --- Ventas del período (sin contar los cancelados) ---
  const ventas = await env.DB.prepare(
    `SELECT COUNT(*) AS pedidos, COALESCE(SUM(total), 0) AS facturado, COALESCE(SUM(subtotal), 0) AS productos,
            COALESCE(SUM(shipping), 0) AS envios, COALESCE(SUM(discount), 0) AS descuentos
     FROM orders WHERE created_at >= ? AND created_at < ? AND status != 'cancelado'`,
  ).bind(...rango).first();

  const cancelados = await env.DB.prepare(
    "SELECT COUNT(*) AS pedidos, COALESCE(SUM(total), 0) AS facturado FROM orders WHERE created_at >= ? AND created_at < ? AND status = 'cancelado'",
  ).bind(...rango).first();

  const porEstado = await filas(env, "SELECT status, COUNT(*) AS n FROM orders WHERE created_at >= ? AND created_at < ? GROUP BY status", ...rango);

  const porMedio = await filas(
    env,
    `SELECT payment_method AS medio, COUNT(*) AS pedidos, COALESCE(SUM(total), 0) AS total
     FROM orders WHERE created_at >= ? AND created_at < ? AND status != 'cancelado' GROUP BY medio ORDER BY total DESC`,
    ...rango,
  );

  const porEntrega = await filas(
    env,
    `SELECT delivery AS entrega, COUNT(*) AS pedidos, COALESCE(SUM(total), 0) AS total
     FROM orders WHERE created_at >= ? AND created_at < ? AND status != 'cancelado' GROUP BY entrega ORDER BY pedidos DESC`,
    ...rango,
  );

  const porProvincia = await filas(
    env,
    `SELECT province AS provincia, COUNT(*) AS pedidos, COALESCE(SUM(total), 0) AS total
     FROM orders WHERE created_at >= ? AND created_at < ? AND status != 'cancelado' AND province IS NOT NULL
     GROUP BY provincia ORDER BY pedidos DESC, total DESC`,
    ...rango,
  );

  // --- Qué se vende: se abre el detalle guardado en cada pedido ---
  const productos = await filas(
    env,
    `SELECT json_extract(i.value, '$.id') AS id,
            json_extract(i.value, '$.nombre') AS nombre,
            json_extract(i.value, '$.tipo') AS tipo,
            SUM(json_extract(i.value, '$.cantidad')) AS cantidad,
            SUM(json_extract(i.value, '$.cantidad') * COALESCE(json_extract(i.value, '$.unidades'), 1)) AS stickers,
            SUM(json_extract(i.value, '$.cantidad') * json_extract(i.value, '$.precio')) AS facturado,
            COUNT(DISTINCT o.id) AS pedidos
     FROM orders o, json_each(o.items_json) i
     WHERE o.created_at >= ? AND o.created_at < ? AND o.status != 'cancelado'
     GROUP BY json_extract(i.value, '$.id') ORDER BY cantidad DESC, facturado DESC`,
    ...rango,
  );

  const mayores = await filas(
    env,
    `SELECT number AS numero, created_at AS fecha, total, status AS estado, payment_method AS pago, customer_name AS nombre, delivery AS entrega
     FROM orders WHERE created_at >= ? AND created_at < ? AND status != 'cancelado' ORDER BY total DESC LIMIT 10`,
    ...rango,
  );

  const ventasPorDia = await filas(
    env,
    `SELECT substr(created_at, 1, 10) AS dia, COUNT(*) AS pedidos, COALESCE(SUM(total), 0) AS total
     FROM orders WHERE created_at >= ? AND created_at < ? AND status != 'cancelado' GROUP BY dia ORDER BY dia`,
    ...rango,
  );

  // --- Clientes ---
  const clientes = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END), 0) AS nuevos,
            COALESCE(SUM(marketing_consent), 0) AS con_consentimiento,
            COALESCE(SUM(CASE WHEN marketing_consent = 1 AND email_verified = 1 THEN 1 ELSE 0 END), 0) AS destinatarios,
            COALESCE(SUM(email_verified), 0) AS verificados,
            COALESCE(SUM(CASE WHEN google_sub IS NOT NULL THEN 1 ELSE 0 END), 0) AS con_google
     FROM users`,
  ).bind(...rango).first();

  // Clientes que compraron más de una vez, en toda la historia.
  const repiten = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM (SELECT user_id FROM orders WHERE user_id IS NOT NULL AND status != 'cancelado' GROUP BY user_id HAVING COUNT(*) > 1)",
  ).first();

  // --- Visitas ---
  const visitas = await env.DB.prepare(
    "SELECT COALESCE(SUM(visits), 0) AS visitas, COALESCE(SUM(views), 0) AS paginas FROM page_views WHERE day >= ? AND day <= ?",
  ).bind(desde, hasta).first();

  const visitasPorDia = await filas(env, "SELECT day AS dia, SUM(visits) AS visitas, SUM(views) AS paginas FROM page_views WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day", desde, hasta);
  const visitasPorRuta = await filas(env, "SELECT path AS ruta, SUM(visits) AS visitas, SUM(views) AS paginas FROM page_views WHERE day >= ? AND day <= ? GROUP BY ruta ORDER BY paginas DESC", desde, hasta);

  const pedidos = ventas.pedidos || 0;
  return json({
    periodo: { desde, hasta, dias },
    ventas: {
      pedidos,
      facturado: ventas.facturado || 0,
      productos: ventas.productos || 0,
      envios: ventas.envios || 0,
      descuentos: ventas.descuentos || 0,
      ticket: pedidos ? Math.round((ventas.facturado || 0) / pedidos) : 0,
      cancelados: cancelados.pedidos || 0,
      facturadoCancelado: cancelados.facturado || 0,
    },
    porEstado: Object.fromEntries(porEstado.map((f) => [f.status, f.n])),
    estados: ESTADOS,
    porMedioDePago: porMedio,
    porEntrega,
    porProvincia,
    productos,
    mayoresVentas: mayores,
    ventasPorDia,
    clientes: {
      total: clientes.total || 0,
      nuevos: clientes.nuevos || 0,
      conConsentimiento: clientes.con_consentimiento || 0,
      destinatariosNovedades: clientes.destinatarios || 0,
      verificados: clientes.verificados || 0,
      conGoogle: clientes.con_google || 0,
      repiten: repiten.n || 0,
    },
    visitas: {
      visitas: visitas.visitas || 0,
      paginas: visitas.paginas || 0,
      porDia: visitasPorDia,
      porRuta: visitasPorRuta,
      // De cada 100 visitas, cuántas terminaron en pedido.
      conversion: visitas.visitas ? Math.round((pedidos / visitas.visitas) * 1000) / 10 : null,
    },
  });
}
