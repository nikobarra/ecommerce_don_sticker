// Facturación electrónica: Factura C a consumidor final, enviada por mail con el PDF, y Notas de Crédito C.
//
// Cómo se factura:
//  - Pagos de Mercado Pago: solo, apenas Mercado Pago acredita el pago (origen «automatica»).
//  - Transferencias: a mano, cuando el dueño toca «Facturar» en el panel después de verificar que el dinero ingresó
//    (origen «manual»). El botón también reintenta una factura que ARCA había rechazado.
//  - Notas de Crédito: a mano, desde el panel, para anular una factura emitida (devolución o error). Siempre por el total.
//
// Garantías (valen igual para facturas y notas de crédito):
//  - Una sola factura por pedido y una sola nota por factura (UNIQUE en las tablas), aunque el aviso de pago llegue
//    repetido o haya dos procesos a la vez.
//  - Mientras un proceso emite, un bloqueo corto impide que otro lo haga a la vez.
//  - El número se anota ANTES de pedir el CAE. Si se corta la conexión, al reintentar se consulta a ARCA si ese número
//    ya fue autorizado: no se emite dos veces ni se saltea un número.
//  - Si ARCA está caída, el comprobante queda pendiente y se reintenta solo. Si ARCA lo rechaza, queda en «error» y se
//    avisa al dueño; el pedido y el cobro no se tocan nunca.
//  - Todo se activa con FACTURACION_ACTIVA = "1" (y con los secretos de ARCA cargados).

import { ahora, error, json, leerJson, limpiarTexto } from "./util.js";
import { usuarioActual } from "./auth.js";
import { exigirAdmin } from "./admin.js";
import { facturacionActiva, ambienteDe, ultimoAutorizado, consultarComprobante, solicitarCae } from "./arca.js";
import { generarFacturaPdf, nroFmtDe } from "./factura-pdf.js";
import { enviarMail, enviarSinFallar, mailFactura, mailNotaCredito, mailAvisoFactura, urlSitio } from "./mail.js";

const TIPO_FACTURA_C = 11;
const TIPO_NOTA_CREDITO_C = 13;
const BLOQUEO_MS = 5 * 60 * 1000;
const MAX_INTENTOS = 12;
// ARCA exige identificar al consumidor final (DNI, CUIT, etc.) desde este importe (página oficial de ARCA, 23/11/2026).
// Es un valor y no una constante fija por si ARCA lo actualiza: FACTURA_TOPE_IDENTIFICAR lo reemplaza.
const TOPE_IDENTIFICAR = 10000000;
const ESTADOS_FACTURABLES = new Set(["pago_confirmado", "preparando", "despachado", "entregado"]);

const EMISOR_BASE = {
  nombreFantasia: "Don Sticker",
  razonSocial: "BARRA PELECANO NICOLAS MATIAS",   // tal como figura en ARCA (copiado de una factura emitida el 05/11/2026)
  domicilio: "21 700 - Balcarce, Buenos Aires",
  condicionIva: "Responsable Monotributo",
  ingresosBrutos: "20274973022",                  // número de inscripción: coincide con el CUIT, como en las facturas anteriores
  inicioActividades: "01/12/2017",
};
export const emisorDe = (env) => ({ ...EMISOR_BASE, cuit: String(env.ARCA_CUIT) });

// Fecha de hoy en Argentina (UTC-3), como AAAAMMDD.
const hoyAr = (dias = 0) => new Date(Date.now() - 3 * 3600 * 1000 + dias * 86400000).toISOString().slice(0, 10).replace(/-/g, "");

const pedidoCompleto = async (env, orderId) => {
  const fila = await env.DB.prepare("SELECT o.*, u.email AS email FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ?").bind(orderId).first();
  return fila ? { ...fila, items: JSON.parse(fila.items_json) } : null;
};

const datosDeComprobante = (r) => ({ tipo: r.cbte_tipo, ptoVta: r.pto_vta, nro: r.cbte_nro, fecha: r.cbte_fecha, total: r.total, cae: r.cae, caeVto: r.cae_vto });

// PDF de una factura ya emitida (se vuelve a armar cada vez: no se guarda el archivo).
export async function pdfDeFactura(env, orderId) {
  const inv = await env.DB.prepare("SELECT * FROM invoices WHERE order_id = ? AND status = 'emitida'").bind(orderId).first();
  const pedido = await pedidoCompleto(env, orderId);
  if (!inv || !pedido) return null;
  return { pdf: generarFacturaPdf({ emisor: emisorDe(env), pedido, factura: datosDeComprobante(inv) }), numero: nroFmtDe(inv.pto_vta, inv.cbte_nro), pedido };
}

// PDF de la nota de crédito de un pedido (anula su factura).
export async function pdfDeNota(env, orderId) {
  const nota = await env.DB.prepare("SELECT * FROM credit_notes WHERE order_id = ? AND status = 'emitida'").bind(orderId).first();
  const inv = nota && await env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(nota.invoice_id).first();
  const pedido = await pedidoCompleto(env, orderId);
  if (!nota || !inv || !pedido) return null;
  const factura = { ...datosDeComprobante(nota), asociado: { ptoVta: inv.pto_vta, nro: inv.cbte_nro }, motivo: nota.motivo };
  return { pdf: generarFacturaPdf({ emisor: emisorDe(env), pedido, factura }), numero: nroFmtDe(nota.pto_vta, nota.cbte_nro), numeroFactura: nroFmtDe(inv.pto_vta, inv.cbte_nro), pedido };
}

const aBase64 = (b) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

// Manda el comprobante por mail al cliente. Solo se marca como enviado si Resend lo aceptó.
async function enviarPorMail(env, sitio, orderId, nota = false) {
  const hecho = nota ? await pdfDeNota(env, orderId) : await pdfDeFactura(env, orderId);
  if (!hecho || !hecho.pedido.email) return false;
  const adjunto = { nombre: `${nota ? "Nota-de-credito-C" : "Factura-C"}-${hecho.numero}.pdf`, base64: aBase64(hecho.pdf) };
  const datos = nota ? mailNotaCredito(hecho.pedido, hecho.numero, hecho.numeroFactura, `${sitio}/cuenta.html`) : mailFactura(hecho.pedido, hecho.numero, `${sitio}/cuenta.html`);
  await enviarMail(env, { to: hecho.pedido.email, ...datos, adjuntos: [adjunto] });
  await env.DB.prepare(`UPDATE ${nota ? "credit_notes" : "invoices"} SET mail_enviado_en = ?, updated_at = ? WHERE order_id = ?`).bind(ahora(), ahora(), orderId).run();
  return true;
}

async function avisarAlDueno(env, ctx, sitio, orderId, motivo, que = "factura") {
  const pedido = await pedidoCompleto(env, orderId);
  const dueno = String(env.ADMIN_EMAILS || "").split(",")[0]?.trim();
  if (pedido && dueno) await enviarSinFallar(env, ctx, { to: dueno, ...mailAvisoFactura(pedido, motivo, `${sitio}/admin.html`, que) });
}

// Núcleo común: lleva un comprobante (factura o nota de crédito) de «pendiente» a «emitida».
// `tabla` es siempre una constante interna («invoices» o «credit_notes»). Devuelve «emitida» o por qué no.
async function completar(env, ctx, sitio, tabla, reg, { asoc = null, que = "factura" } = {}) {
  if (reg.ambiente !== ambienteDe(env)) return "otro_ambiente";   // un comprobante de pruebas no se completa con la clave de producción
  if (!asoc && reg.total >= (Number(env.FACTURA_TOPE_IDENTIFICAR) || TOPE_IDENTIFICAR)) {
    // No se emite una factura anónima por un monto que obliga a identificar al cliente: se avisa para hacerla a mano.
    const motivo = "El total alcanza el monto desde el cual ARCA exige identificar al cliente (DNI o CUIT). Hay que pedirle el dato y emitir la factura a mano.";
    await env.DB.prepare(`UPDATE ${tabla} SET status = 'error', ultimo_error = ?, updated_at = ? WHERE id = ? AND status = 'pendiente'`).bind(motivo, ahora(), reg.id).run();
    await avisarAlDueno(env, ctx, sitio, reg.order_id, motivo, que);
    return "requiere_identificacion";
  }

  // Bloqueo: solo un proceso a la vez.
  const t = ahora();
  const bloqueo = await env.DB.prepare(`UPDATE ${tabla} SET bloqueo_hasta = ?, intentos = intentos + 1, updated_at = ? WHERE id = ? AND status = 'pendiente' AND (bloqueo_hasta IS NULL OR bloqueo_hasta < ?)`)
    .bind(new Date(Date.now() + BLOQUEO_MS).toISOString(), t, reg.id, t).run();
  if (!bloqueo.meta?.changes) return "ocupada";
  const inv = await env.DB.prepare(`SELECT * FROM ${tabla} WHERE id = ?`).bind(reg.id).first();

  const soltar = (estado, motivo) =>
    env.DB.prepare(`UPDATE ${tabla} SET status = ?, ultimo_error = ?, bloqueo_hasta = NULL, updated_at = ? WHERE id = ?`).bind(estado, String(motivo).slice(0, 500), ahora(), inv.id).run();

  try {
    let { cbte_nro: nro, cbte_fecha: fecha } = inv;
    let cae = "", vto = "";

    if (nro) {  // un intento anterior se cortó: ¿ARCA llegó a autorizar ese número?
      const ya = await consultarComprobante(env, inv.pto_vta, inv.cbte_tipo, nro);
      if (ya && ya.cae && ya.total === inv.total) { cae = ya.cae; vto = ya.vto; fecha = ya.fecha || fecha; }
      else nro = null;                                   // no existe (o es otro): se vuelve a pedir un número libre
    }
    if (!cae) {
      if (!fecha || fecha < hoyAr(-4)) fecha = hoyAr();     // ARCA acepta fechas de hasta unos pocos días atrás
      for (let vuelta = 0; vuelta < 3 && !cae; vuelta++) {
        if (!nro) {
          nro = (await ultimoAutorizado(env, inv.pto_vta, inv.cbte_tipo)) + 1;
          await env.DB.prepare(`UPDATE ${tabla} SET cbte_nro = ?, cbte_fecha = ?, updated_at = ? WHERE id = ?`).bind(nro, fecha, ahora(), inv.id).run();
        }
        try {
          ({ cae, vto } = await solicitarCae(env, { ptoVta: inv.pto_vta, tipo: inv.cbte_tipo, nro, fecha, total: inv.total, asoc }));
        } catch (e) {
          if (e.numeroOcupado) { nro = null; continue; }   // otra emisión se adelantó: se toma el número siguiente
          throw e;
        }
      }
      if (!cae) throw Object.assign(new Error("No se pudo tomar un número libre"), { transitorio: true });
    }
    await env.DB.prepare(`UPDATE ${tabla} SET status = 'emitida', cae = ?, cae_vto = ?, cbte_nro = ?, cbte_fecha = ?, ultimo_error = '', bloqueo_hasta = NULL, updated_at = ? WHERE id = ?`)
      .bind(cae, vto, nro, fecha, ahora(), inv.id).run();
    return "emitida";
  } catch (e) {
    const agotada = inv.intentos >= MAX_INTENTOS;
    if (e.transitorio && !agotada) { await soltar("pendiente", e.message); return "reintentar"; }
    await soltar("error", e.message);
    await avisarAlDueno(env, ctx, sitio, reg.order_id, e.transitorio ? `ARCA no respondió después de ${inv.intentos} intentos (${e.message})` : e.message, que);
    return "error";
  }
}

// ---------- Factura ----------

// Emite (o continúa) la factura de un pedido. `manual` = la pidió el dueño con el botón «Facturar».
// Devuelve un texto que describe lo que pasó; sirve para las pruebas, los registros y el panel.
export async function emitirFactura(env, ctx, sitio, orderId, { manual = false } = {}) {
  if (!facturacionActiva(env)) return "inactiva";
  const pedido = await pedidoCompleto(env, orderId);
  if (!pedido) return "sin_pedido";
  const previa = await env.DB.prepare("SELECT origen FROM invoices WHERE order_id = ?").bind(orderId).first();
  const esManual = manual || previa?.origen === "manual";     // si arrancó a mano, los reintentos automáticos también valen
  const facturable = pedido.payment_method === "mercadopago"
    ? ESTADOS_FACTURABLES.has(pedido.status)                 // Mercado Pago: solo con el pago ya acreditado
    : esManual && pedido.status !== "cancelado";             // transferencia: solo si el dueño lo pidió, y no cancelada
  if (!facturable) return "no_facturable";

  const t = ahora();
  await env.DB.prepare("INSERT INTO invoices (order_id, status, ambiente, pto_vta, cbte_tipo, total, origen, created_at, updated_at) VALUES (?, 'pendiente', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(order_id) DO NOTHING")
    .bind(orderId, ambienteDe(env), Number(env.ARCA_PTO_VTA), TIPO_FACTURA_C, pedido.total, esManual ? "manual" : "automatica", t, t).run();
  let inv = await env.DB.prepare("SELECT * FROM invoices WHERE order_id = ?").bind(orderId).first();

  if (inv.status === "error" && manual) {   // el dueño vuelve a intentar una factura rechazada
    await env.DB.prepare("UPDATE invoices SET status = 'pendiente', intentos = 0, ultimo_error = '', bloqueo_hasta = NULL, updated_at = ? WHERE id = ? AND status = 'error'").bind(ahora(), inv.id).run();
    inv = await env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(inv.id).first();
  }
  if (inv.status === "error") return "error_previo";
  if (inv.status === "emitida") {
    if (!inv.mail_enviado_en) { try { await enviarPorMail(env, sitio, orderId); return "mail_reenviado"; } catch (e) { console.error("Factura: mail fallido:", e.message); return "mail_pendiente"; } }
    return "ya_emitida";
  }

  const resultado = await completar(env, ctx, sitio, "invoices", inv);
  if (resultado !== "emitida") return resultado;
  try { await enviarPorMail(env, sitio, orderId); } catch (e) { console.error("Factura: mail fallido:", e.message); return "emitida_sin_mail"; }
  return "emitida";
}

// ---------- Nota de crédito ----------

// Anula por el total la factura de un pedido. Pedida siempre a mano por el dueño.
export async function emitirNotaCredito(env, ctx, sitio, orderId, motivo = "", { reintentar = false } = {}) {
  if (!facturacionActiva(env)) return "inactiva";
  const inv = await env.DB.prepare("SELECT * FROM invoices WHERE order_id = ? AND status = 'emitida'").bind(orderId).first();
  if (!inv) return "sin_factura";
  if (inv.ambiente !== ambienteDe(env)) return "otro_ambiente";

  const t = ahora();
  await env.DB.prepare("INSERT INTO credit_notes (invoice_id, order_id, status, ambiente, pto_vta, cbte_tipo, total, motivo, created_at, updated_at) VALUES (?, ?, 'pendiente', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(invoice_id) DO NOTHING")
    .bind(inv.id, orderId, inv.ambiente, inv.pto_vta, TIPO_NOTA_CREDITO_C, inv.total, limpiarTexto(motivo, 120), t, t).run();
  let nota = await env.DB.prepare("SELECT * FROM credit_notes WHERE invoice_id = ?").bind(inv.id).first();

  if (nota.status === "error" && reintentar) {
    await env.DB.prepare("UPDATE credit_notes SET status = 'pendiente', intentos = 0, ultimo_error = '', bloqueo_hasta = NULL, updated_at = ? WHERE id = ? AND status = 'error'").bind(ahora(), nota.id).run();
    nota = await env.DB.prepare("SELECT * FROM credit_notes WHERE id = ?").bind(nota.id).first();
  }
  if (nota.status === "error") return "error_previo";
  if (nota.status === "emitida") {
    if (!nota.mail_enviado_en) { try { await enviarPorMail(env, sitio, orderId, true); return "mail_reenviado"; } catch (e) { console.error("Nota de crédito: mail fallido:", e.message); return "mail_pendiente"; } }
    return "ya_emitida";
  }

  const resultado = await completar(env, ctx, sitio, "credit_notes", nota, { asoc: { tipo: inv.cbte_tipo, ptoVta: inv.pto_vta, nro: inv.cbte_nro }, que: "nota" });
  if (resultado !== "emitida") return resultado;
  try { await enviarPorMail(env, sitio, orderId, true); } catch (e) { console.error("Nota de crédito: mail fallido:", e.message); return "emitida_sin_mail"; }
  return "emitida";
}

// ---------- Automatismos ----------

// Se usa desde el aviso de pago: nunca frena ni rompe la confirmación del pedido.
export function facturarSinFallar(env, ctx, sitio, orderId) {
  if (!facturacionActiva(env)) return;
  const tarea = emitirFactura(env, ctx, sitio, orderId).catch((e) => console.error("Facturación fallida:", e.message));
  if (ctx?.waitUntil) ctx.waitUntil(tarea);
}

// Tarea periódica: reintenta las pendientes (facturas y notas de crédito) y los mails que no salieron.
export async function reintentarFacturas(env, ctx, sitio) {
  if (!facturacionActiva(env)) return 0;
  const ahoraIso = ahora();
  const { results } = await env.DB.prepare(
    "SELECT order_id FROM invoices WHERE ((status = 'pendiente' AND (bloqueo_hasta IS NULL OR bloqueo_hasta < ?1)) OR (status = 'emitida' AND mail_enviado_en IS NULL)) AND ambiente = ?2 ORDER BY updated_at LIMIT 5",
  ).bind(ahoraIso, ambienteDe(env)).all();
  for (const f of results || []) await emitirFactura(env, ctx, sitio, f.order_id).catch((e) => console.error("Reintento de factura fallido:", e.message));
  const { results: notas } = await env.DB.prepare(
    "SELECT order_id, motivo FROM credit_notes WHERE ((status = 'pendiente' AND (bloqueo_hasta IS NULL OR bloqueo_hasta < ?1)) OR (status = 'emitida' AND mail_enviado_en IS NULL)) AND ambiente = ?2 ORDER BY updated_at LIMIT 5",
  ).bind(ahoraIso, ambienteDe(env)).all();
  for (const n of notas || []) await emitirNotaCredito(env, ctx, sitio, n.order_id, n.motivo).catch((e) => console.error("Reintento de nota de crédito fallido:", e.message));
  return (results || []).length + (notas || []).length;
}

// ---------- Cliente: descarga de su factura ----------

// Descarga del PDF por el cliente: solo el dueño del pedido, y solo si la factura ya fue emitida.
export async function miFactura(request, env, orderId) {
  const u = await usuarioActual(env, request);
  if (!u) return error("sin_sesion", "Ingresá a tu cuenta.", 401);
  const fila = await env.DB.prepare("SELECT id FROM orders WHERE id = ? AND user_id = ?").bind(orderId, u.id).first();
  if (!fila) return error("no_encontrado", "No encontré ese pedido.", 404);
  const hecho = await pdfDeFactura(env, orderId);
  if (!hecho) return error("sin_factura", "Este pedido todavía no tiene factura.", 404);
  return pdf(hecho.pdf, `Factura-C-${hecho.numero}.pdf`);
}

const pdf = (bytes, nombre) => new Response(bytes, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${nombre}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });

// ---------- Panel del dueño ----------

const MENSAJES = {
  emitida: "Listo: la factura quedó emitida y se la mandé al cliente por mail.",
  emitida_sin_mail: "La factura quedó emitida, pero el mail al cliente no salió. Se reintenta solo; mientras tanto podés bajar el PDF.",
  mail_reenviado: "La factura ya estaba emitida; le mandé el mail al cliente de nuevo.",
  mail_pendiente: "La factura ya estaba emitida; el mail al cliente no salió y se reintenta solo.",
  ya_emitida: "Este pedido ya tiene factura.",
  reintentar: "ARCA no respondió. La factura quedó pendiente y se reintenta sola en unos minutos.",
  ocupada: "Ya hay otra emisión en curso para este pedido. Esperá un momento y actualizá.",
  no_facturable: "Este pedido no se puede facturar: está cancelado o su pago todavía no se acreditó.",
  inactiva: "La facturación está apagada.",
  otro_ambiente: "Este comprobante se creó en otro ambiente de ARCA (pruebas o producción) y no se puede completar acá.",
  sin_factura: "Este pedido no tiene una factura emitida para anular.",
  error_previo: "ARCA rechazó este comprobante antes. Revisá el motivo y volvé a intentar.",
};

// Información de facturación de cada pedido, para la lista del panel.
export async function facturacionPorPedido(env) {
  const { results: f } = await env.DB.prepare("SELECT order_id, status, pto_vta, cbte_nro, ultimo_error, origen FROM invoices").all();
  const { results: n } = await env.DB.prepare("SELECT order_id, status, pto_vta, cbte_nro, ultimo_error FROM credit_notes").all();
  const mapa = new Map();
  const info = (r) => ({ estado: r.status, numero: r.cbte_nro ? nroFmtDe(r.pto_vta, r.cbte_nro) : null, error: r.ultimo_error || "" });
  for (const r of f || []) mapa.set(r.order_id, { factura: { ...info(r), origen: r.origen }, nota: null });
  for (const r of n || []) { const m = mapa.get(r.order_id) || { factura: null, nota: null }; m.nota = info(r); mapa.set(r.order_id, m); }
  return mapa;
}

export async function facturarDesdePanel(request, env, ctx, orderId) {
  const a = await exigirAdmin(request, env);
  if (a.respuesta) return a.respuesta;
  if (!facturacionActiva(env)) return error("facturacion_apagada", MENSAJES.inactiva, 409);
  const r = await emitirFactura(env, ctx, urlSitio(env, request), orderId, { manual: true });
  if (r === "sin_pedido") return error("no_encontrado", "No encontré ese pedido.", 404);
  const fila = await env.DB.prepare("SELECT status, ultimo_error FROM invoices WHERE order_id = ?").bind(orderId).first();
  const detalle = r === "error" || r === "requiere_identificacion" ? ` Motivo: ${fila?.ultimo_error || ""}` : "";
  const ok = ["emitida", "emitida_sin_mail", "mail_reenviado", "mail_pendiente", "ya_emitida", "reintentar"].includes(r);
  return json({ resultado: r, ok, mensaje: r === "requiere_identificacion" ? `No se emitió.${detalle}` : (r === "error" ? `ARCA no la aceptó.${detalle}` : (MENSAJES[r] || "No pude facturar.")) });
}

export async function notaCreditoDesdePanel(request, env, ctx, orderId) {
  const a = await exigirAdmin(request, env);
  if (a.respuesta) return a.respuesta;
  if (!facturacionActiva(env)) return error("facturacion_apagada", MENSAJES.inactiva, 409);
  const lectura = await leerJson(request);
  const motivo = lectura.ok ? String(lectura.datos?.motivo || "") : "";
  const r = await emitirNotaCredito(env, ctx, urlSitio(env, request), orderId, motivo, { reintentar: true });
  const fila = await env.DB.prepare("SELECT ultimo_error FROM credit_notes WHERE order_id = ?").bind(orderId).first();
  const detalle = r === "error" ? ` Motivo: ${fila?.ultimo_error || ""}` : "";
  const ok = ["emitida", "emitida_sin_mail", "mail_reenviado", "mail_pendiente", "ya_emitida", "reintentar"].includes(r);
  const textos = { ...MENSAJES, emitida: "Listo: la nota de crédito quedó emitida y se la mandé al cliente por mail.", emitida_sin_mail: "La nota de crédito quedó emitida, pero el mail al cliente no salió. Podés bajar el PDF.", ya_emitida: "Este pedido ya tiene su nota de crédito.", reintentar: "ARCA no respondió. La nota quedó pendiente y se reintenta sola." };
  return json({ resultado: r, ok, mensaje: r === "error" ? `ARCA no la aceptó.${detalle}` : (textos[r] || "No pude emitir la nota de crédito.") });
}

export async function comprobanteDesdePanel(request, env, orderId) {
  const a = await exigirAdmin(request, env);
  if (a.respuesta) return a.respuesta;
  const nota = new URL(request.url).searchParams.get("tipo") === "nota";
  const hecho = nota ? await pdfDeNota(env, orderId) : await pdfDeFactura(env, orderId);
  if (!hecho) return error("sin_comprobante", "Ese comprobante todavía no está emitido.", 404);
  return pdf(hecho.pdf, `${nota ? "Nota-de-credito-C" : "Factura-C"}-${hecho.numero}.pdf`);
}

// Lista de facturas y notas de crédito, con lo facturado en el mes y en los últimos 12 meses (para vigilar el tope del monotributo).
export async function listarFacturas(request, env) {
  const a = await exigirAdmin(request, env);
  if (a.respuesta) return a.respuesta;
  const amb = ambienteDe(env);
  const { results } = await env.DB.prepare(
    `SELECT i.order_id, i.status, i.pto_vta, i.cbte_nro, i.cbte_fecha, i.total, i.origen, i.ultimo_error, i.mail_enviado_en IS NOT NULL AS mail, o.number, o.customer_name, o.payment_method,
            n.status AS nota_estado, n.cbte_nro AS nota_nro, n.pto_vta AS nota_pto, n.cbte_fecha AS nota_fecha, n.total AS nota_total, n.ultimo_error AS nota_error
     FROM invoices i JOIN orders o ON o.id = i.order_id LEFT JOIN credit_notes n ON n.invoice_id = i.id
     WHERE i.ambiente = ? ORDER BY i.created_at DESC LIMIT 300`).bind(amb).all();
  const hoy = hoyAr(), mes = hoy.slice(0, 6), desde12 = String(Number(hoy.slice(0, 4)) - 1) + hoy.slice(4);
  let delMes = 0, de12 = 0;
  const suma = (fecha, total) => { if (!fecha) return; if (fecha.slice(0, 6) === mes) delMes += total; if (fecha > desde12) de12 += total; };
  const filas = (results || []).map((r) => {
    if (r.status === "emitida") suma(r.cbte_fecha, r.total);
    if (r.nota_estado === "emitida") suma(r.nota_fecha, -r.nota_total);
    return {
      pedidoId: r.order_id, pedido: r.number, cliente: r.customer_name, pago: r.payment_method, origen: r.origen, total: r.total, fecha: r.cbte_fecha, estado: r.status, error: r.ultimo_error || "",
      numero: r.cbte_nro ? nroFmtDe(r.pto_vta, r.cbte_nro) : null, mailEnviado: Boolean(r.mail),
      nota: r.nota_estado ? { estado: r.nota_estado, numero: r.nota_nro ? nroFmtDe(r.nota_pto, r.nota_nro) : null, fecha: r.nota_fecha, error: r.nota_error || "" } : null,
    };
  });
  return json({ ambiente: amb, activa: facturacionActiva(env), facturadoMes: delMes, facturado12Meses: de12, facturas: filas });
}
