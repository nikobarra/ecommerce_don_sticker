// Panel del dueño: ver pedidos y cambiar su estado.

import { json, error, ahora, leerJson, limpiarTexto } from "./util.js";
import { ESTADOS } from "./precios.js";
import { PACKS_CONTENIDO } from "./packs-contenido.js";
import { usuarioActual, usuarioPublico } from "./auth.js";
import { pedidoPublico } from "./pedidos.js";
import { enviarSinFallar, mailCambioEstado, urlSitio } from "./mail.js";
import { usuarioTaller } from "./taller-acceso.js";
import { facturacionPorPedido } from "./facturacion.js";
import { facturacionActiva } from "./arca.js";

// Devuelve el usuario administrador o una respuesta de error.
export async function exigirAdmin(request, env) {
  const taller = /^\/api\/taller\/pedidos\/[0-9a-f-]{36}$/.test(new URL(request.url).pathname);
  const u = taller ? await usuarioTaller(request, env) : await usuarioActual(env, request);
  if (!u) return { respuesta: error("sin_sesion", "Ingresá a tu cuenta.", 401) };
  if (!usuarioPublico(env, u).admin) return { respuesta: error("prohibido", "No tenés permiso para ver esto.", 403) };
  return { usuario: u };
}

// El dueño ve qué diseños lleva cada pack prearmado que tiene que preparar.
const conContenidoDePacks = (p) => ({ ...p, items: p.items.map((i) => (i.tipo === "pack" && PACKS_CONTENIDO[i.id] ? { ...i, disenos: PACKS_CONTENIDO[i.id].map((d) => d.toUpperCase()) } : i)) });

export async function listarPedidos(request, env) {
  const a = await exigirAdmin(request, env);
  if (a.respuesta) return a.respuesta;
  const estado = new URL(request.url).searchParams.get("estado") || "todos";
  const filtra = estado !== "todos" && ESTADOS[estado];
  const sql = `SELECT o.*, u.email AS customer_email, u.email_verified AS customer_verified FROM orders o LEFT JOIN users u ON u.id = o.user_id ${filtra ? "WHERE o.status = ?" : ""} ORDER BY o.created_at DESC LIMIT 200`;
  const { results } = await (filtra ? env.DB.prepare(sql).bind(estado) : env.DB.prepare(sql)).all();
  const facturacion = await facturacionPorPedido(env);
  return json({
    facturacionActiva: facturacionActiva(env),
    pedidos: results.map((f) => ({ ...conContenidoDePacks(pedidoPublico(f)), problemaPago: f.payment_issue || "", clienteMail: f.customer_email || null, clienteMailVerificado: Boolean(f.customer_verified), facturacion: facturacion.get(f.id) || null })),
  });
}

export async function resumen(request, env) {
  const a = await exigirAdmin(request, env);
  if (a.respuesta) return a.respuesta;
  const porEstado = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM orders GROUP BY status").all();
  const clientes = await env.DB.prepare(
    "SELECT COUNT(*) AS total, SUM(marketing_consent) AS con_consentimiento, SUM(CASE WHEN marketing_consent = 1 AND email_verified = 1 THEN 1 ELSE 0 END) AS destinatarios FROM users",
  ).first();
  return json({
    pedidosPorEstado: Object.fromEntries(porEstado.results.map((r) => [r.status, r.n])),
    clientes: { total: clientes.total || 0, conConsentimiento: clientes.con_consentimiento || 0, destinatariosNovedades: clientes.destinatarios || 0 },
  });
}

export async function actualizarPedido(request, env, ctx, id) {
  const a = await exigirAdmin(request, env);
  if (a.respuesta) return a.respuesta;
  const lectura = await leerJson(request);
  if (!lectura.ok) return lectura.respuesta;
  const { estado, seguimiento, nota } = lectura.datos;
  const resolverProblema = lectura.datos.resolverProblemaPago === true;

  const fila = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
  if (!fila) return error("no_encontrado", "No encontré ese pedido.", 404);
  if (estado !== undefined && !ESTADOS[estado]) return error("estado_invalido", "Ese estado no existe.");
  const seg = seguimiento === undefined ? fila.tracking_number : limpiarTexto(seguimiento, 40);
  if (seg && !/^[A-Za-z0-9 -]+$/.test(seg)) return error("seguimiento_invalido", "El número de seguimiento solo puede tener letras, números y guiones.");

  const nuevoEstado = estado ?? fila.status;
  const cambioEstado = nuevoEstado !== fila.status;
  const cambioSeg = seg !== fila.tracking_number;
  const cierraProblema = resolverProblema && Boolean(fila.payment_issue);
  if (!cambioEstado && !cambioSeg && !cierraProblema) return json({ pedido: pedidoPublico(fila) });

  const t = ahora();
  const textoNota = limpiarTexto(nota, 200) || (cambioSeg && !cambioEstado ? `Seguimiento: ${seg}` : "");
  const sentencias = [
    env.DB.prepare("UPDATE orders SET status = ?, tracking_number = ?, updated_at = ? WHERE id = ?").bind(nuevoEstado, seg, t, id),
    env.DB.prepare("INSERT INTO order_events (order_id, status, note, created_at) VALUES (?, ?, ?, ?)").bind(id, nuevoEstado, textoNota || (cierraProblema ? "Cobro revisado por el dueño" : ""), t),
  ];
  if (cierraProblema) sentencias.push(env.DB.prepare("UPDATE orders SET payment_issue = '' WHERE id = ?").bind(id));
  await env.DB.batch(sentencias);
  const nueva = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();

  const cliente = nueva.user_id ? await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(nueva.user_id).first() : null;
  if (cliente && (cambioEstado || cambioSeg)) {
    await enviarSinFallar(env, ctx, { to: cliente.email, ...mailCambioEstado({ ...nueva, items: JSON.parse(nueva.items_json) }, `${urlSitio(env, request)}/cuenta.html`) });
  }
  return json({ pedido: pedidoPublico(nueva) });
}
