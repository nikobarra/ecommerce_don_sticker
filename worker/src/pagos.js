// Cobro con Mercado Pago (Checkout Pro: el cliente paga en el sitio de ellos y vuelve).
//
// Claves, que son SECRETOS del Worker (nunca van en el código):
//   MP_ACCESS_TOKEN   token de la aplicación de Mercado Pago
//   MP_WEBHOOK_SECRET clave para validar la firma de los avisos de pago
//
// Mientras falte alguna de las dos, la web no ofrece Mercado Pago y solo se paga por transferencia.
//
// QUÉ GARANTIZA ESTE MÓDULO
//  1. Un pedido solo pasa a «Pago confirmado» si Mercado Pago, consultado directamente por nosotros, dice
//     que hay un pago APROBADO, en ARS, por el total exacto del pedido, y el pedido sigue esperando el pago.
//     El aviso (webhook) solo dispara esa consulta: nunca se le cree por sí mismo.
//  2. Confirmar el pago y anotar el evento en el historial son UNA sola operación atómica (un lote D1).
//     Repetirla no hace nada. Dos avisos simultáneos no duplican el evento ni el mail.
//  3. Si Mercado Pago no responde (red, 429, 5xx) el aviso NO se acusa: se responde 503 y Mercado Pago
//     reintenta. Una respuesta 200 solo se da cuando el aviso quedó procesado o no hay nada que procesar.
//  4. Aunque ningún aviso llegue, la CONCILIACIÓN busca los pagos de los pedidos pendientes: la tarea
//     periódica (scheduled), el botón del panel y la página de vuelta del comprador usan el mismo código.
//  5. Lo que no se puede decidir solo (pago en un pedido cancelado, pago duplicado, importe distinto,
//     devolución, contracargo) NO se resuelve automáticamente: queda marcado en el pedido, anotado en el
//     historial y se avisa al dueño por mail.

import { json, error, ahora, leerJson, mercadoPagoActivo, fetchExterno, limitar } from "./util.js";
import { usuarioActual, usuarioPublico } from "./auth.js";
import { pedidoPublico } from "./pedidos.js";
import { envioDefinitivo } from "./envio.js";
import { enviarSinFallar, mailCambioEstado, mailAvisoPago, urlSitio } from "./mail.js";
import { facturarSinFallar } from "./facturacion.js";
import { avisarCambioDePedido } from "./push.js";
import { importarSinFallar } from "./micorreo.js";

const API = "https://api.mercadopago.com";
const vacio = (status = 200, extra = {}) => new Response(null, { status, headers: extra });

// ---------- Utilidades ----------

// Mensaje del proveedor sin nada que pueda ser un token ni un dato personal, y acotado.
export function sanear(texto) {
  return String(texto ?? "")
    .replace(/(APP_USR|TEST)-[\w-]+/gi, "[clave]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[mail]")
    .replace(/[\u0000-\u001f]/g, " ")
    .slice(0, 160);
}

// Qué forma tiene el token cargado, SIN revelar nada de su valor. Sirve para detectar el error más
// común: pegar la Public Key (44 caracteres) donde va el Access Token.
export function formatoDeToken(token) {
  const t = String(token || "");
  if (!t) return "vacío";
  if (/^TEST-/.test(t)) return "de_prueba";
  if (/^APP_USR-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return "parece_public_key";
  if (/^APP_USR-\d+-\d+-[0-9a-f]+-\d+$/i.test(t)) return "access_token";
  return "desconocido";
}

// Llamada a la API de Mercado Pago. Los errores llevan `transitorio` para decidir si se reintenta:
// red, plazo vencido, 408, 429 y 5xx se reintentan; 401/403 también (es la configuración, que se arregla
// y el aviso no debe perderse); 400/404 no (el pedido no existe o es una prueba).
async function mpGet(env, ruta) {
  let r;
  try {
    r = await fetchExterno(env, `${API}${ruta}`, { headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` } });
  } catch (e) {
    throw Object.assign(new Error(`red: ${e.message}`), { transitorio: true });
  }
  if (r.ok) return r.json();
  const transitorio = r.status === 408 || r.status === 429 || r.status >= 500 || r.status === 401 || r.status === 403;
  throw Object.assign(new Error(`mercadopago ${r.status}`), { transitorio, status: r.status });
}

// ---------- Crear el link de pago ----------

// Arma los productos tal como los espera Mercado Pago. El envío va como una línea más,
// así el total que cobra Mercado Pago es exactamente el total del pedido.
function itemsPreferencia(fila) {
  const items = JSON.parse(fila.items_json).map((i) => ({
    id: i.id,
    title: i.nombre,
    quantity: i.cantidad,
    unit_price: i.precio,
    currency_id: "ARS",
  }));
  if (fila.shipping > 0) {
    items.push({ id: "envio", title: "Envío por Correo Argentino", quantity: 1, unit_price: fila.shipping, currency_id: "ARS" });
  }
  return items;
}

export async function crearPreferencia(request, env, ctx, id) {
  if (!mercadoPagoActivo(env)) return error("pago_no_disponible", "El pago con Mercado Pago no está disponible por ahora. Elegí transferencia.", 503);
  const u = await usuarioActual(env, request);
  if (!u) return error("sin_sesion", "Ingresá a tu cuenta.", 401);

  const fila = await env.DB.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").bind(id, u.id).first();
  if (!fila) return error("no_encontrado", "No encontré ese pedido.", 404);
  if (fila.payment_method !== "mercadopago") return error("otro_medio", "Este pedido se paga por transferencia.", 409);
  if (fila.status !== "recibido") return error("no_pagable", "Este pedido ya no está esperando el pago.", 409);
  if (!envioDefinitivo(fila.shipping_source)) return error("envio_estimado", "El costo del envío todavía no es el definitivo. Escribinos y lo coordinamos por transferencia.", 409);

  const sitio = urlSitio(env, request);
  const cuerpo = {
    items: itemsPreferencia(fila),
    external_reference: fila.id,
    statement_descriptor: "DON STICKER",
    notification_url: `${sitio}/api/pagos/mercadopago`,
    back_urls: {
      success: `${sitio}/pago.html?pedido=${fila.number}`,
      pending: `${sitio}/pago.html?pedido=${fila.number}`,
      failure: `${sitio}/pago.html?pedido=${fila.number}&estado=error`,
    },
    auto_return: "approved",
    metadata: { numero: fila.number },
  };

  let datos;
  try {
    let r;
    try {
      r = await fetchExterno(env, `${API}/checkout/preferences`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          // Si se repite el pedido, Mercado Pago devuelve la misma preferencia en vez de crear otra.
          "X-Idempotency-Key": `pref-${fila.id}`,
        },
        body: JSON.stringify(cuerpo),
      });
    } catch (e) {
      throw Object.assign(new Error(`red: ${e.message}`), { transitorio: true });
    }
    datos = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`mercadopago ${r.status}: ${sanear(datos.message || datos.error)}`), { status: r.status });
  } catch (e) {
    // Solo del lado del servidor: motivo y forma del token, nunca su valor.
    console.error(`Preferencia fallida: ${e.message} · token ${formatoDeToken(env.MP_ACCESS_TOKEN)}`);
    // Al cliente, el mensaje general. El motivo técnico solo lo ve el administrador, o quien hizo el
    // pedido mientras MP_DIAGNOSTICO sea "1" (se enciende para configurar y se apaga después).
    const detalle = usuarioPublico(env, u).admin || env.MP_DIAGNOSTICO === "1" ? ` (${e.message})` : "";
    return error("pago_no_disponible", `No pudimos abrir el pago. Probá de nuevo o elegí transferencia.${detalle}`, 502);
  }

  const url = datos.init_point || datos.sandbox_init_point;
  if (!url) return error("pago_no_disponible", "No pudimos abrir el pago. Probá de nuevo o elegí transferencia.", 502);

  await env.DB.prepare("UPDATE orders SET payment_preference_id = ?, updated_at = ? WHERE id = ?")
    .bind(String(datos.id || ""), ahora(), fila.id).run();

  return json({ url });
}

// ---------- Firma del aviso ----------

// Comparación que tarda lo mismo acierte o no, para no filtrar la firma correcta.
function igualSinFugas(a, b) {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

const aHex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

// Mercado Pago firma cada aviso: x-signature trae "ts=...,v1=..." y se valida sobre
// "id:<id del pago>;request-id:<x-request-id>;ts:<ts>;" con la clave del panel.
export async function firmaValida(env, request, idDato) {
  const firma = request.headers.get("x-signature") || "";
  const pedidoId = request.headers.get("x-request-id") || "";
  const partes = Object.fromEntries(firma.split(",").map((p) => {
    const i = p.indexOf("=");
    return i < 0 ? ["", ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  if (!partes.ts || !partes.v1 || !idDato) return false;

  const clave = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.MP_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const manifiesto = `id:${idDato};request-id:${pedidoId};ts:${partes.ts};`;
  const esperado = aHex(await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(manifiesto)));
  return igualSinFugas(esperado, partes.v1.toLowerCase());
}

// ---------- Aplicar un pago a su pedido ----------

const dineroIgual = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

const TEXTOS_PROBLEMA = {
  pago_en_pedido_cancelado: "Mercado Pago acreditó un pago por un pedido que estaba CANCELADO. El pedido no se reactivó solo. Hay que devolver el dinero desde Mercado Pago, o reactivar el pedido desde el panel si el cliente igual lo quiere.",
  pago_duplicado: "Se acreditó un SEGUNDO pago por un pedido que ya estaba pagado. Hay que devolver uno desde Mercado Pago.",
  importe_distinto: "Hay un pago aprobado cuyo importe o moneda no coincide con el total del pedido. El pedido NO se confirmó. Revisá el cobro en Mercado Pago antes de decidir.",
  pago_devuelto: "Un pago de este pedido figura como devuelto en Mercado Pago. El estado del pedido no cambió solo: revisalo.",
  contracargo: "Un pago de este pedido tiene un CONTRACARGO en Mercado Pago. El estado del pedido no cambió solo: revisalo y no despaches si todavía no salió.",
};

// Marca un problema de cobro en el pedido, anota el historial y avisa al dueño. Solo lo hace una vez por
// problema: el UPDATE entra únicamente si el pedido todavía no tenía ESE mismo problema marcado, y el
// evento solo se anota si el UPDATE cambió algo (changes() > 0), todo dentro del mismo lote atómico.
async function marcarProblema(env, ctx, sitio, fila, codigo, pago) {
  const t = ahora();
  const nota = `Cobro a revisar (${TEXTOS_PROBLEMA[codigo] ? codigo : "otro"}): pago ${pago.id} de Mercado Pago, estado ${pago.status}`;
  const r = await env.DB.batch([
    // Todas las expresiones del SET miran el valor ANTERIOR de la fila. Si el pedido no tenía pago asociado,
    // se asocia este (hace falta para detectar después una devolución); si ya tenía otro, no se pisa.
    env.DB.prepare(
      `UPDATE orders SET payment_issue = ?1,
         payment_id = CASE WHEN payment_id = '' THEN ?2 ELSE payment_id END,
         payment_status = CASE WHEN payment_id = '' OR payment_id = ?2 THEN ?3 ELSE payment_status END,
         updated_at = ?4
       WHERE id = ?5 AND payment_issue != ?1`,
    ).bind(codigo, String(pago.id), String(pago.status), t, fila.id),
    env.DB.prepare("INSERT INTO order_events (order_id, status, note, created_at) SELECT ?, status, ?, ? FROM orders WHERE id = ? AND changes() > 0")
      .bind(fila.id, nota, t, fila.id),
  ]);
  if (!r[0].meta?.changes) return "ya_marcado";
  const dueno = String(env.ADMIN_EMAILS || "").split(",")[0].trim();
  if (dueno) {
    const nueva = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(fila.id).first();
    await enviarSinFallar(env, ctx, { to: dueno, ...mailAvisoPago({ ...nueva, items: JSON.parse(nueva.items_json) }, TEXTOS_PROBLEMA[codigo], pago, `${sitio}/admin.html`) });
  }
  return codigo;
}

// Aplica UN pago de Mercado Pago (ya consultado a su API) al pedido que corresponde.
// Devuelve qué pasó: confirmado | sin_cambios | pendiente | rechazado | problema:<codigo> | ignorado:<motivo>.
export async function aplicarPago(env, ctx, sitio, pago) {
  if (!pago || !pago.id) return "ignorado:sin_pago";
  const fila = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(String(pago.external_reference || "")).first();
  if (!fila) return "ignorado:sin_pedido";
  if (fila.payment_method !== "mercadopago") return "ignorado:otro_medio";

  // Un pago de prueba solo vale si se está trabajando con credenciales de prueba.
  if (pago.live_mode === false && !String(env.MP_ACCESS_TOKEN).startsWith("TEST-")) return "ignorado:pago_de_prueba";

  const id = String(pago.id);
  const estado = String(pago.status || "");

  if (estado === "approved") {
    const coincide = pago.currency_id === "ARS" && dineroIgual(pago.transaction_amount, fila.total);
    if (!coincide) return `problema:${await marcarProblema(env, ctx, sitio, fila, "importe_distinto", pago)}`;

    if (fila.status === "cancelado") return `problema:${await marcarProblema(env, ctx, sitio, fila, "pago_en_pedido_cancelado", pago)}`;

    if (fila.status !== "recibido") {
      // Ya estaba confirmado (o más adelante). Si es el MISMO pago, es una repetición: no pasa nada.
      if (fila.payment_id === id) return "sin_cambios";
      return `problema:${await marcarProblema(env, ctx, sitio, fila, "pago_duplicado", pago)}`;
    }

    // Confirmación atómica: el UPDATE solo entra si el pedido sigue en «recibido»; el evento solo se anota
    // si el UPDATE cambió una fila. Si el proceso se corta, no queda un estado sin su evento ni al revés.
    const t = ahora();
    const nota = `Pago acreditado por Mercado Pago (${id})`;
    const r = await env.DB.batch([
      env.DB.prepare("UPDATE orders SET status = 'pago_confirmado', payment_id = ?, payment_status = ?, payment_issue = '', updated_at = ? WHERE id = ? AND status = 'recibido'")
        .bind(id, estado, t, fila.id),
      env.DB.prepare("INSERT INTO order_events (order_id, status, note, created_at) SELECT ?, 'pago_confirmado', ?, ? WHERE changes() > 0")
        .bind(fila.id, nota, t),
    ]);
    if (!r[0].meta?.changes) {
      // Otro aviso, o una cancelación, se adelantó entre la lectura y la escritura: se vuelve a mirar.
      const ahoraFila = await env.DB.prepare("SELECT status, payment_id FROM orders WHERE id = ?").bind(fila.id).first();
      if (ahoraFila?.status === "cancelado") return `problema:${await marcarProblema(env, ctx, sitio, fila, "pago_en_pedido_cancelado", pago)}`;
      return "sin_cambios";
    }

    const nueva = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(fila.id).first();
    const cliente = nueva.user_id ? await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(nueva.user_id).first() : null;
    if (cliente) await enviarSinFallar(env, ctx, { to: cliente.email, ...mailCambioEstado({ ...nueva, items: JSON.parse(nueva.items_json) }, `${sitio}/cuenta.html`) });
    await avisarCambioDePedido(env, ctx, nueva, { cambioEstado: true, cambioSeg: false });
    importarSinFallar(env, ctx, fila.id); // carga el envío en MiCorreo (si está activado)
    // Factura oficial (ARCA). Está apagada hasta que se active a propósito; si falla, el cobro y el pedido no se tocan.
    facturarSinFallar(env, ctx, sitio, fila.id);
    return "confirmado";
  }

  if (estado === "refunded" || estado === "charged_back") {
    // Solo importa si es el pago con el que se confirmó el pedido.
    if (fila.payment_id !== id) return "ignorado:pago_ajeno";
    return `problema:${await marcarProblema(env, ctx, sitio, fila, estado === "refunded" ? "pago_devuelto" : "contracargo", pago)}`;
  }

  // pending, in_process, authorized, rejected, cancelled: se anota el estado mientras el pedido espera.
  if (fila.status === "recibido") {
    await env.DB.prepare("UPDATE orders SET payment_id = ?, payment_status = ?, updated_at = ? WHERE id = ? AND status = 'recibido'")
      .bind(id, estado, ahora(), fila.id).run();
  }
  return estado === "rejected" || estado === "cancelled" ? "rechazado" : "pendiente";
}

// ---------- Aviso de pago (webhook) ----------

// Mercado Pago avisa acá cuando pasa algo con un pago. El aviso NO se cree por sí solo: se valida la firma y
// después se le pregunta a Mercado Pago qué pasó de verdad.
//   200 -> el aviso quedó procesado, o no hay nada que procesar (otro tipo de evento, pago de otro negocio).
//   401 -> la firma no coincide: aviso falso o clave mal cargada (se ve en el panel de Mercado Pago).
//   503 -> Mercado Pago no respondió o rechazó nuestra credencial: NO se acusa recibo, así que reintenta.
export async function webhookMercadoPago(request, env, ctx) {
  if (!mercadoPagoActivo(env)) return vacio(503, { "retry-after": "300" });

  const url = new URL(request.url);
  const lectura = await leerJson(request, 20000);
  const cuerpo = lectura.ok ? lectura.datos : {};
  const tipo = cuerpo.type || url.searchParams.get("type") || url.searchParams.get("topic") || "";
  const idPago = String(cuerpo.data?.id || url.searchParams.get("data.id") || url.searchParams.get("id") || "");

  if (tipo !== "payment" || !idPago) return vacio(200);
  if (!(await firmaValida(env, request, idPago))) {
    console.error("Aviso de pago con firma inválida");
    return vacio(401);
  }

  let pago;
  try {
    pago = await mpGet(env, `/v1/payments/${encodeURIComponent(idPago)}`);
  } catch (e) {
    console.error(`No pude consultar el pago: ${e.message}`);
    if (e.transitorio) return vacio(503, { "retry-after": "60" });
    return vacio(200); // 400/404: no existe ese pago (típico de las notificaciones de prueba del panel)
  }

  const resultado = await aplicarPago(env, ctx, urlSitio(env, request), pago);
  console.log(`Aviso de pago procesado: ${resultado}`); // sin datos del cliente
  return vacio(200);
}

// ---------- Conciliación ----------

// Busca en Mercado Pago los pagos de UN pedido y los aplica, del más viejo al más nuevo (así el primero
// aprobado confirma y uno posterior queda como duplicado). Sirve aunque nunca haya llegado el aviso.
export async function conciliarPedido(env, ctx, sitio, fila) {
  await env.DB.prepare("UPDATE orders SET payment_checked_at = ? WHERE id = ?").bind(ahora(), fila.id).run();
  const datos = await mpGet(env, `/v1/payments/search?external_reference=${encodeURIComponent(fila.id)}&sort=date_created&criteria=asc&limit=20`);
  const resultados = Array.isArray(datos.results) ? datos.results : [];
  const salida = [];
  for (const pago of resultados) salida.push(await aplicarPago(env, ctx, sitio, { ...pago, external_reference: pago.external_reference || fila.id }));
  return salida;
}

// Revisa los pedidos con Mercado Pago que siguen esperando el pago (o que se cancelaron y quizás cobraron).
// `forzar` ignora el descanso entre revisiones del mismo pedido.
export async function conciliarPendientes(env, ctx, { limite = 25, forzar = false } = {}) {
  if (!mercadoPagoActivo(env) || !env.DB) return { revisados: 0, confirmados: 0, problemas: 0, errores: 0 };
  const DIA = 24 * 3600 * 1000;
  const desde = new Date(Date.now() - 14 * DIA).toISOString();
  // «Se revisó hace menos de X» se resuelve con una fecha de corte. Forzar la lleva al futuro, así cualquier
  // pedido califica aunque se haya revisado hace un instante (si no, dos revisiones en el mismo milisegundo
  // se saltearían la segunda).
  const descansoRecibido = new Date(Date.now() + (forzar ? 60_000 : -10 * 60 * 1000)).toISOString();
  const descansoCancelado = new Date(Date.now() + (forzar ? 60_000 : -6 * 3600 * 1000)).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT * FROM orders
     WHERE payment_method = 'mercadopago' AND payment_preference_id != '' AND created_at > ?
       AND ((status = 'recibido' AND (payment_checked_at IS NULL OR payment_checked_at < ?))
         OR (status = 'cancelado' AND payment_issue = '' AND (payment_checked_at IS NULL OR payment_checked_at < ?)))
     ORDER BY created_at LIMIT ?`,
  ).bind(desde, descansoRecibido, descansoCancelado, limite).all();

  const sitio = urlSitio(env, null);
  const cuenta = { revisados: 0, confirmados: 0, problemas: 0, errores: 0 };
  for (const fila of results) {
    try {
      const salida = await conciliarPedido(env, ctx, sitio, fila);
      cuenta.revisados++;
      cuenta.confirmados += salida.filter((x) => x === "confirmado").length;
      cuenta.problemas += salida.filter((x) => x.startsWith("problema:") && x !== "problema:ya_marcado").length;
    } catch (e) {
      cuenta.errores++;
      console.error(`Conciliación fallida: ${e.message}`);
    }
  }
  return cuenta;
}

// POST /api/admin/conciliar — el botón «Revisar pagos» del panel.
export async function conciliarAdmin(request, env, ctx) {
  const u = await usuarioActual(env, request);
  if (!u) return error("sin_sesion", "Ingresá a tu cuenta.", 401);
  if (!usuarioPublico(env, u).admin) return error("prohibido", "No tenés permiso para hacer esto.", 403);
  if (!mercadoPagoActivo(env)) return error("pago_no_disponible", "Mercado Pago no está configurado.", 503);
  if (!(await limitar(env, `conciliar:${u.id}`, 6, 600))) return error("demasiados_intentos", "Ya revisaste hace poco. Esperá unos minutos.", 429);
  return json(await conciliarPendientes(env, ctx, { limite: 50, forzar: true }));
}

// ---------- Página de vuelta del comprador ----------

// GET /api/pedidos/numero/DS-XXXXXX. Además de mostrar el estado, si el pedido sigue pendiente se le
// pregunta UNA vez cada 20 segundos a Mercado Pago, así el comprador no depende de que el aviso haya llegado.
export async function estadoPago(request, env, ctx, numero) {
  const u = await usuarioActual(env, request);
  if (!u) return error("sin_sesion", "Ingresá a tu cuenta.", 401);
  let fila = await env.DB.prepare("SELECT * FROM orders WHERE number = ? AND user_id = ?").bind(numero, u.id).first();
  if (!fila) return error("no_encontrado", "No encontré ese pedido.", 404);

  if (fila.status === "recibido" && fila.payment_method === "mercadopago" && fila.payment_preference_id && mercadoPagoActivo(env)
      && (await limitar(env, `concilia:${fila.id}`, 1, 20))) {
    try {
      await conciliarPedido(env, ctx, urlSitio(env, request), fila);
      fila = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(fila.id).first();
    } catch (e) {
      console.error(`Conciliación al volver: ${e.message}`); // se muestra el estado que ya tenemos
    }
  }
  return json({ pedido: pedidoPublico(fila) });
}
