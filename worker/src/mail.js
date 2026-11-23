// Envío de mails y plantillas.
// MAIL_PROVIDER: "log" (por defecto: se guardan en la tabla mail_log para poder verlos, no se envían)
//                "resend" (usa RESEND_API_KEY, MAIL_FROM, MAIL_FROM_NEWS y MAIL_REPLY_TO).
// Para cambiar de servicio solo hay que tocar enviarMail().

import { ahora, limpiarTexto, fetchExterno } from "./util.js";
import { ESTADOS } from "./precios.js";
import { PACKS_CONTENIDO } from "./packs-contenido.js";

const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Sin petición (tareas periódicas) solo se puede usar SITE_URL.
export function urlSitio(env, request) {
  return (env.SITE_URL || (request ? new URL(request.url).origin : "")).replace(/\/+$/, "");
}

// «Calle 123, Localidad». Los pedidos viejos tienen todo junto en la localidad y no tienen calle.
export const direccionDe = (pedido) => [pedido.street, pedido.locality].filter(Boolean).join(", ");

const URL_RESEND = "https://api.resend.com/emails";
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Un solo envío a Resend. Se reintenta ante fallas de red, errores 5xx y 429 (respetando retry-after);
// los demás errores 4xx no se reintentan. La clave de idempotencia es la misma en todos los reintentos,
// así que si el primer intento llegó pero no recibimos la respuesta, no se manda el mail dos veces.
async function enviarPorResend(env, cuerpo) {
  const claveIdempotencia = crypto.randomUUID();
  let ultimoError;
  for (let intento = 0; intento < 3; intento++) {
    let espera = 400 * 2 ** intento;
    try {
      const r = await fetchExterno(env, URL_RESEND, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": claveIdempotencia },
        body: JSON.stringify(cuerpo),
      });
      if (r.ok) return r.json().catch(() => ({}));
      ultimoError = new Error(`mail ${r.status}`);
      if (r.status !== 429 && r.status < 500) throw Object.assign(ultimoError, { noReintentar: true });
      const retryAfter = Number(r.headers.get("retry-after"));
      if (retryAfter > 0) espera = Math.min(retryAfter * 1000, 3000);
    } catch (e) {
      if (e.noReintentar) throw e;
      ultimoError = e;
    }
    if (intento < 2) await dormir(espera);
  }
  throw ultimoError;
}

// tipo: "aviso" (confirmaciones, recuperación, estados) o "novedades" (mail semanal, sale de otro subdominio).
export async function enviarMail(env, { to, subject, text, html, bajaUrl, tipo = "aviso", replyTo, adjuntos }) {
  const proveedor = env.MAIL_PROVIDER || "log";
  if (proveedor === "resend") {
    const encabezados = bajaUrl
      ? { "List-Unsubscribe": `<${bajaUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
      : undefined;
    const desde = tipo === "novedades" ? env.MAIL_FROM_NEWS || env.MAIL_FROM : env.MAIL_FROM;
    const r = await enviarPorResend(env, { from: desde, to: [to], subject, text, html, reply_to: replyTo || env.MAIL_REPLY_TO || undefined, headers: encabezados, attachments: adjuntos?.length ? adjuntos.map((x) => ({ filename: x.nombre, content: x.base64 })) : undefined });
    return r.id || null;
  }
  await env.DB.prepare("INSERT INTO mail_log (to_addr, subject, body, created_at) VALUES (?, ?, ?, ?)").bind(to, subject, adjuntos?.length ? `${text}
[adjunto: ${adjuntos.map((x) => x.nombre).join(", ")}]` : text, ahora()).run();
  console.log("[mail simulado]", subject); // sin datos personales
  return null;
}

// Los mails no deben frenar la operación principal: si fallan, se registra y se sigue.
export async function enviarSinFallar(env, ctx, datos) {
  const tarea = enviarMail(env, datos).catch((e) => console.error("Mail fallido:", e.message));
  if (ctx?.waitUntil) ctx.waitUntil(tarea);
  else await tarea;
}

function envolver(titulo, parrafos, boton) {
  const cuerpo = parrafos.map((p) => `<p style="margin:0 0 14px">${p}</p>`).join("");
  const b = boton
    ? `<p style="margin:22px 0"><a href="${esc(boton.url)}" style="background:#160000;color:#FDF4E6;padding:13px 22px;border-radius:999px;text-decoration:none;font-weight:700">${esc(boton.texto)}</a></p>`
    : "";
  return `<!doctype html><html lang="es"><body style="margin:0;background:#FDF4E6;font-family:Arial,Helvetica,sans-serif;color:#160000">
<div style="max-width:560px;margin:0 auto;padding:28px 20px">
<h1 style="font-size:24px;margin:0 0 18px;color:#FD0000">${esc(titulo)}</h1>${cuerpo}${b}
<p style="font-size:13px;color:#812120;margin-top:28px">Don Sticker · No es personal, son solo stickers.</p></div></body></html>`;
}

export function mailVerificacion(url, nombre) {
  const hola = nombre ? `Hola, ${esc(nombre)}.` : "Hola.";
  return {
    subject: "Confirmá tu mail en Don Sticker",
    text: `${nombre ? `Hola, ${nombre}.` : "Hola."}\n\nPara confirmar tu mail y activar tu cuenta, entrá a este enlace (vence en 24 horas):\n${url}\n\nSi no creaste una cuenta, ignorá este mensaje.\n\nDon Sticker`,
    html: envolver("Confirmá tu mail", [hola, "Para activar tu cuenta, confirmá tu mail. El enlace vence en 24 horas.", "Si no creaste una cuenta, ignorá este mensaje."], { url, texto: "Confirmar mi mail" }),
  };
}

export function mailRestablecer(url) {
  return {
    subject: "Restablecé tu contraseña de Don Sticker",
    text: `Pediste restablecer tu contraseña. Entrá a este enlace para elegir una nueva (vence en 1 hora):\n${url}\n\nSi no fuiste vos, ignorá este mensaje: tu contraseña no cambia.\n\nDon Sticker`,
    html: envolver("Restablecé tu contraseña", ["Pediste restablecer tu contraseña. El enlace vence en 1 hora.", "Si no fuiste vos, ignorá este mensaje: tu contraseña no cambia."], { url, texto: "Elegir una contraseña nueva" }),
  };
}

const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");
// Cada diseño lleva su código (DS-0001): es el nombre del archivo para imprimir.
// Para el dueño: los packs prearmados traen la lista de diseños que hay que preparar.
const codigosDePack = (id) => (PACKS_CONTENIDO[id] || []).map((d) => d.toUpperCase()).join(", ");
const lineasParaDueno = (items) => items.flatMap((i) => [`• ${i.cantidad} × ${i.nombre}${i.codigo ? ` (${i.codigo})` : ""}`, ...(i.tipo === "pack" && PACKS_CONTENIDO[i.id] ? [`   Lleva: ${codigosDePack(i.id)}`] : [])]);
const lineasPedido = (items) => items.map((i) => `• ${i.cantidad} × ${i.nombre}${i.codigo ? ` (${i.codigo})` : ""}`);

export function mailPedidoRecibido(pedido, urlCuenta) {
  const lineas = lineasPedido(pedido.items);
  const ahorro = pedido.discount > 0 ? `Descuento por transferencia: −${pesos(pedido.discount)}` : "";
  const comoPagar = pedido.payment_method === "mercadopago"
    ? "Lo pagás con Mercado Pago. Si el pago quedó pendiente o se cortó, podés retomarlo desde tu cuenta."
    : "Te escribimos con los datos para la transferencia.";
  return {
    subject: `Recibí tu pedido ${pedido.number}`,
    text: `Recibí tu pedido ${pedido.number}. Quedate tranquilo: de esto me ocupo yo.\n\n${lineas.join("\n")}\n${ahorro ? ahorro + "\n" : ""}\nTotal: ${pesos(pedido.total)}\n\n${comoPagar} Podés seguir el estado de tu pedido acá:\n${urlCuenta}\n\nDon Sticker`,
    html: envolver(`Recibí tu pedido ${pedido.number}`, ["Quedate tranquilo: de esto me ocupo yo.", ...lineas.map(esc), ahorro, `<strong>Total: ${pesos(pedido.total)}</strong>`, comoPagar].filter(Boolean), { url: urlCuenta, texto: "Ver mi pedido" }),
  };
}

// Único recordatorio para un pedido de Mercado Pago que quedó sin pagar.
export function mailRecordatorioPago(pedido, urlCuenta) {
  return {
    subject: `Tu pedido ${pedido.number} sigue esperando el pago`,
    text: `Tu pedido ${pedido.number} quedó guardado, pero todavía no recibimos el pago.\n\nSi lo querés, lo pagás con Mercado Pago desde tu cuenta:\n${urlCuenta}\n\nSi ya no lo querés, no hace falta que hagas nada; también lo podés cancelar desde ahí. Este es el único recordatorio que te mandamos.\n\nDon Sticker`,
    html: envolver(`Tu pedido ${pedido.number} te espera`, [
      "Quedó guardado, pero todavía no recibimos el pago.",
      ...lineasPedido(pedido.items).map(esc),
      `<strong>Total: ${pesos(pedido.total)}</strong>`,
      "Si ya no lo querés, no hace falta que hagas nada; también lo podés cancelar desde tu cuenta. Este es el único recordatorio que te mandamos.",
    ], { url: urlCuenta, texto: "Pagar mi pedido" }),
  };
}

export function mailCambioEstado(pedido, urlCuenta) {
  const estado = ESTADOS[pedido.status] || pedido.status;
  const seguimiento = pedido.tracking_number ? `\nNúmero de seguimiento: ${pedido.tracking_number}` : "";
  return {
    subject: `Tu pedido ${pedido.number}: ${estado}`,
    text: `Tu pedido ${pedido.number} cambió de estado: ${estado}.${seguimiento}\n\nPodés verlo acá:\n${urlCuenta}\n\nDon Sticker`,
    html: envolver(`Tu pedido ${pedido.number}`, [`Estado: <strong>${esc(estado)}</strong>`, pedido.tracking_number ? `Número de seguimiento: <strong>${esc(pedido.tracking_number)}</strong>` : ""].filter(Boolean), { url: urlCuenta, texto: "Ver mi pedido" }),
  };
}

export function mailAvisoDueno(pedido, urlAdmin) {
  const donde = pedido.delivery === "envio" ? `envío a ${direccionDe(pedido)}, CP ${pedido.postal_code}, ${pedido.province}` : `punto de entrega en ${pedido.delivery}`;
  const comoPaga = pedido.payment_method === "mercadopago"
    ? "Paga con Mercado Pago: el estado pasa solo a «Pago confirmado» cuando se acredita."
    : "Paga por transferencia: hay que mandarle los datos y confirmar el pago a mano.";
  return {
    subject: `Pedido nuevo ${pedido.number} por ${pesos(pedido.total)}`,
    text: `Pedido ${pedido.number} de ${pedido.customer_name}\n${lineasParaDueno(pedido.items).join("\n")}\nTotal: ${pesos(pedido.total)}\nEntrega: ${donde}\n${comoPaga}\n\nPanel: ${urlAdmin}`,
    html: envolver(`Pedido nuevo ${pedido.number}`, [esc(pedido.customer_name), ...lineasParaDueno(pedido.items).map(esc), `<strong>Total: ${pesos(pedido.total)}</strong>`, `Entrega: ${esc(donde)}`, esc(comoPaga)], { url: urlAdmin, texto: "Abrir el panel" }),
  };
}

// Sugerencia de diseño de una persona con cuenta: llega al dueño y se puede responder directo (reply-to).
export function mailSugerencia({ nombre, mail, idea, referencia }) {
  const quien = nombre ? `${nombre} (${mail})` : mail;
  return {
    subject: "Sugerencia de diseño en Don Sticker",
    text: [`${quien} sugiere un diseño:`, idea, referencia ? `Referencia: ${referencia}` : "", "Podés responderle a este mismo mail."].filter(Boolean).join("\n\n"),
    html: envolver("Sugerencia de diseño", [`<strong>${esc(quien)}</strong> sugiere un diseño:`, esc(idea), ...(referencia ? [`Referencia: ${esc(referencia)}`] : []), "Podés responderle a este mismo mail."]),
  };
}

// Aviso al dueño: un cobro de Mercado Pago necesita su decisión (no se resolvió solo).
export function mailAvisoPago(pedido, explicacion, pago, urlAdmin) {
  return {
    subject: `Cobro a revisar: pedido ${pedido.number} (${pesos(pedido.total)})`,
    text: `Pedido ${pedido.number}, total ${pesos(pedido.total)}.\n\n${explicacion}\n\nPago de Mercado Pago: ${pago.id} · estado ${pago.status} · ${pago.currency_id || "?"} ${pago.transaction_amount ?? "?"}\n\nPanel: ${urlAdmin}`,
    html: envolver(`Cobro a revisar: ${pedido.number}`, [esc(explicacion), `Pago de Mercado Pago: <strong>${esc(pago.id)}</strong> · estado ${esc(pago.status)} · ${esc(pago.currency_id || "?")} ${esc(pago.transaction_amount ?? "?")}`, `Total del pedido: ${pesos(pedido.total)}`], { url: urlAdmin, texto: "Abrir el panel" }),
  };
}

// Aviso de seguridad: se vinculó un Google a la cuenta. Si la persona no lo hizo, tiene que enterarse.
export function mailGoogleVinculado(sePerdioLaClave, urlCuenta) {
  const clave = sePerdioLaClave
    ? 'Por seguridad, la contraseña que tenías dejó de valer. Si querés volver a usarla, tocá «Olvidé mi contraseña» al ingresar.'
    : 'Tu contraseña sigue funcionando.';
  return {
    subject: 'Vinculamos tu cuenta de Google a Don Sticker',
    text: `Alguien entró a tu cuenta de Don Sticker con Google usando este mail y la dejó vinculada.\n\n${clave}\n\nSi fuiste vos, no tenés que hacer nada. Si no reconocés este movimiento, escribinos de inmediato a donsticker.ar@gmail.com.\n\nTu cuenta: ${urlCuenta}\n\nDon Sticker`,
    html: envolver("Vinculamos tu cuenta de Google", ["Alguien entró a tu cuenta con Google usando este mail y la dejó vinculada.", esc(clave), "Si fuiste vos, no tenés que hacer nada. Si no reconocés este movimiento, escribinos de inmediato a donsticker.ar@gmail.com."], { url: urlCuenta, texto: "Ver mi cuenta" }),
  };
}

export function mailPedidoCancelado(pedido, urlCuenta, pagado) {
  const devolucion = pagado
    ? "Como ya habías pagado, te devolvemos el importe: te escribimos para coordinar la devolución."
    : "Como todavía no habías pagado, no hay nada que devolver.";
  return {
    subject: `Cancelé tu pedido ${pedido.number}`,
    text: `Tu pedido ${pedido.number} quedó cancelado, como pediste.\n\n${devolucion}\n\nPodés verlo acá:\n${urlCuenta}\n\nDon Sticker`,
    html: envolver(`Cancelé tu pedido ${pedido.number}`, ["Quedó cancelado, como pediste.", esc(devolucion)], { url: urlCuenta, texto: "Ver mi pedido" }),
  };
}

export function mailAvisoCancelacion(pedido, estadoAnterior, urlAdmin) {
  const antes = ESTADOS[estadoAnterior] || estadoAnterior;
  const aviso = estadoAnterior === "recibido" ? "No había pago confirmado." : "TENÍA EL PAGO CONFIRMADO: hay que devolver el dinero.";
  return {
    subject: `Pedido ${pedido.number} cancelado por el cliente (${pesos(pedido.total)})`,
    text: `El cliente ${pedido.customer_name} canceló el pedido ${pedido.number} con el botón de arrepentimiento.\nEstado anterior: ${antes}\n${aviso}\nTotal: ${pesos(pedido.total)}\n\nPanel: ${urlAdmin}`,
    html: envolver(`Pedido ${pedido.number} cancelado`, [`${esc(pedido.customer_name)} lo canceló con el botón de arrepentimiento.`, `Estado anterior: ${esc(antes)}`, `<strong>${esc(aviso)}</strong>`, `Total: ${pesos(pedido.total)}`], { url: urlAdmin, texto: "Abrir el panel" }),
  };
}

export const textoNovedades = limpiarTexto;

// ---------- Facturación electrónica ----------

// Mail al cliente con la factura oficial (PDF adjunto).
export function mailFactura(pedido, numeroFactura, urlCuenta) {
  return {
    subject: `Tu factura de Don Sticker · pedido ${pedido.number}`,
    text: `Gracias por tu compra. Te mando la factura de tu pedido ${pedido.number}, en PDF, adjunta a este mail.

Factura C Nº ${numeroFactura}. Es un comprobante oficial autorizado por ARCA.

Podés seguir tu pedido acá:
${urlCuenta}

Don Sticker`,
    html: envolver("Tu factura", [`Gracias por tu compra. Te mando la factura de tu pedido <strong>${esc(pedido.number)}</strong>, en PDF, adjunta a este mail.`, `Factura C Nº ${esc(numeroFactura)}. Es un comprobante oficial autorizado por ARCA.`], { url: urlCuenta, texto: "Ver mi pedido" }),
  };
}

// Aviso al dueño cuando ARCA rechaza una factura o no se pudo emitir tras varios intentos.
export function mailAvisoFactura(pedido, motivo, urlAdmin, que = "factura") {
  if (que === "nota") return {
    subject: `Nota de crédito sin emitir · pedido ${pedido.number}`,
    text: `No se pudo emitir la nota de crédito del pedido ${pedido.number}.

Motivo: ${motivo}

La factura original sigue vigente. Revisalo en el panel:
${urlAdmin}`,
    html: envolver("Nota de crédito sin emitir", [`No se pudo emitir la nota de crédito del pedido <strong>${esc(pedido.number)}</strong>.`, `Motivo: ${esc(motivo)}`, "La factura original sigue vigente."], { url: urlAdmin, texto: "Abrir el panel" }),
  };
  return {
    subject: `Factura sin emitir · pedido ${pedido.number}`,
    text: `No se pudo emitir la factura del pedido ${pedido.number} (cobrado por Mercado Pago, total ${pesos(pedido.total)}).

Motivo: ${motivo}

El pedido y el cobro siguen en orden; solo falta la factura. Revisalo y emitila a mano desde ARCA si hace falta.
${urlAdmin}`,
    html: envolver("Factura sin emitir", [`No se pudo emitir la factura del pedido <strong>${esc(pedido.number)}</strong> (Mercado Pago, ${pesos(pedido.total)}).`, `Motivo: ${esc(motivo)}`, "El pedido y el cobro siguen en orden; solo falta la factura. Revisalo y emitila a mano desde ARCA si hace falta."], { url: urlAdmin, texto: "Abrir el panel" }),
  };
}

// Mail al cliente con la nota de crédito (anula la factura de su pedido), con el PDF adjunto.
export function mailNotaCredito(pedido, numeroNota, numeroFactura, urlCuenta) {
  return {
    subject: `Nota de crédito de Don Sticker · pedido ${pedido.number}`,
    text: `Te mando la nota de crédito del pedido ${pedido.number}, en PDF, adjunta a este mail.

Nota de crédito C Nº ${numeroNota}. Anula la factura Nº ${numeroFactura}. Es un comprobante oficial autorizado por ARCA.

Si tenés dudas, respondé este mail.

Don Sticker`,
    html: envolver("Tu nota de crédito", [`Te mando la nota de crédito del pedido <strong>${esc(pedido.number)}</strong>, en PDF, adjunta a este mail.`, `Nota de crédito C Nº ${esc(numeroNota)}. Anula la factura Nº ${esc(numeroFactura)}. Es un comprobante oficial autorizado por ARCA.`, "Si tenés dudas, respondé este mail."]),
  };
}
