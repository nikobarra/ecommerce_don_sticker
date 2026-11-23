// Pedidos del cliente: crear, listar, ver y cancelar.

import { json, error, ahora, leerJson, uuid, sha256, limpiarTexto, limitar, mercadoPagoActivo } from "./util.js";
import { TIENDA, ENVIO, ESTADOS, MEDIOS_DE_PAGO, armarDetalle } from "./precios.js";
import { costoEnvioPedido, envioDefinitivo } from "./envio.js";
import { usuarioActual } from "./auth.js";
import { enviarSinFallar, mailPedidoRecibido, mailAvisoDueno, mailPedidoCancelado, mailAvisoCancelacion, urlSitio } from "./mail.js";

const LETRAS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sin letras que se confunden (0/O, 1/I/L)
const numeroDePedido = () => "DS-" + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => LETRAS[b % LETRAS.length]).join("");

export function pedidoPublico(fila, eventos) {
  const p = {
    id: fila.id,
    numero: fila.number,
    estado: fila.status,
    estadoTexto: ESTADOS[fila.status] || fila.status,
    items: JSON.parse(fila.items_json),
    subtotal: fila.subtotal,
    descuento: fila.discount || 0,
    pago: fila.payment_method || "transferencia",
    pagoEstado: fila.payment_status || "",
    envio: fila.shipping,
    envioFuente: fila.shipping_source,
    total: fila.total,
    entrega: fila.delivery,
    provincia: fila.province,
    cp: fila.postal_code,
    calle: fila.street || null,
    localidad: fila.locality,
    nombre: fila.customer_name,
    notas: fila.notes,
    seguimiento: fila.tracking_number,
    creado: fila.created_at,
    actualizado: fila.updated_at,
  };
  if (eventos) p.historial = eventos.map((e) => ({ estado: e.status, estadoTexto: ESTADOS[e.status] || e.status, nota: e.note, fecha: e.created_at }));
  return p;
}

// Atribución de campaña (UTM e identificadores de clic). Se acepta solo una lista fija de claves,
// con largo y caracteres acotados: es un dato que viene del navegador y no se le cree a ciegas.
const CLAVES_UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
const CLAVES_CLIC = ["gclid", "gbraid", "wbraid"];
export function limpiarAtribucion(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const salida = {};
  for (const k of CLAVES_UTM) {
    const v = typeof a[k] === "string" ? a[k].trim().slice(0, 100) : "";
    if (v && /^[\w.\-+ %]+$/.test(v)) salida[k] = v;
  }
  for (const k of CLAVES_CLIC) {
    const v = typeof a[k] === "string" ? a[k].trim().slice(0, 150) : "";
    if (v && /^[\w-]+$/.test(v)) salida[k] = v;
  }
  return Object.keys(salida).length ? JSON.stringify(salida) : null;
}

const CLAVE_IDEMPOTENCIA = /^[A-Za-z0-9_-]{16,64}$/;

export async function crearPedido(request, env, ctx) {
  const u = await usuarioActual(env, request);
  if (!u) return error("sin_sesion", "Ingresá o creá tu cuenta para hacer el pedido.", 401);
  const lectura = await leerJson(request, 30000);
  if (!lectura.ok) return lectura.respuesta;
  const d = lectura.datos;

  // Idempotencia: si el cliente reintenta el mismo pedido porque no le llegó la respuesta, se le devuelve
  // el pedido que ya se creó en vez de crear otro. La clave la genera el navegador, una por pedido.
  const claveIdem = request.headers.get("idempotency-key") || (typeof d.claveIdempotencia === "string" ? d.claveIdempotencia : "");
  if (claveIdem && !CLAVE_IDEMPOTENCIA.test(claveIdem)) return error("clave_invalida", "La clave del pedido no es válida.");
  const huella = await sha256(JSON.stringify({
    i: (Array.isArray(d.items) ? d.items : []).map((x) => [String(x?.id), Number(x?.cantidad)]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    e: d.entrega, p: d.provincia, c: d.cp, k: d.calle, l: d.localidad, g: d.pago || "transferencia",
  }));
  if (claveIdem) {
    const previo = await env.DB.prepare("SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ?").bind(u.id, claveIdem).first();
    if (previo) {
      if (previo.request_fingerprint !== huella) return error("clave_reutilizada", "Ese pedido ya se hizo con otros datos. Recargá la página para empezar uno nuevo.", 409);
      return json({ pedido: pedidoPublico(previo), repetido: true }, 200);
    }
  }

  if (!(await limitar(env, `pedido:${u.id}`, 10, 3600))) return error("demasiados_intentos", "Hiciste varios pedidos seguidos. Probá de nuevo en un rato.", 429);

  const pago = String(d.pago || "transferencia");
  if (!MEDIOS_DE_PAGO.includes(pago)) return error("pago_invalido", "Elegí cómo querés pagar.");
  if (pago === "mercadopago" && !mercadoPagoActivo(env)) return error("pago_no_disponible", "El pago con Mercado Pago no está disponible por ahora. Elegí transferencia.");

  const detalle = armarDetalle(d.items, pago);
  if (!detalle.ok) return error("pedido_invalido", detalle.mensaje);

  const entrega = String(d.entrega || "");
  const conEnvio = entrega === "envio";
  if (!conEnvio && !TIENDA.puntosDeEntrega.includes(entrega)) return error("entrega_invalida", "Elegí cómo querés recibir tu pedido.");

  const nombre = limpiarTexto(d.nombre, 80) || u.name;
  if (nombre.length < 2) return error("nombre_invalido", "Decime tu nombre.");
  let provincia = null, cp = null, calle = null, localidad = null, envio = 0, fuente = "";
  if (conEnvio) {
    provincia = String(d.provincia || "");
    cp = String(d.cp || "").trim();
    localidad = limpiarTexto(d.localidad, 120);
    if (!ENVIO.provincias.some((p) => p.nombre === provincia)) return error("provincia_invalida", "Elegí tu provincia.");
    if (!/^\d{4}$/.test(cp)) return error("cp_invalido", "Escribí tu código postal de 4 números.");
    if (d.calle !== undefined) {
      // Formulario nuevo: calle y localidad por separado.
      calle = limpiarTexto(d.calle, 120);
      if (calle.length < 3) return error("calle_invalida", "Escribí tu calle y número.");
      if (localidad.length < 2) return error("localidad_invalida", "Escribí tu localidad.");
    } else if (localidad.length < 3) {
      // Compatibilidad con la versión anterior del formulario, que mandaba todo junto en «localidad».
      return error("direccion_invalida", "Escribí tu localidad y dirección.");
    }
    // No hay envío gratis: el envío se cobra siempre (tarifa por zona o cotización del Correo).
    const c = await costoEnvioPedido(env, ctx, { cp, provincia, stickers: detalle.stickers });
    if (!c) return error("envio_no_disponible", "No pudimos calcular el envío. Escribinos por WhatsApp y lo resolvemos.", 502);
    envio = c.precio;
    fuente = c.fuente;
  }
  // Con Mercado Pago el cliente paga en el momento, así que el total tiene que estar cerrado:
  // un envío estimado se confirma después y ya no se podría ajustar lo cobrado.
  // Tampoco si la tarifa viene del ambiente de PRUEBA del Correo: no es un precio real.
  if (pago === "mercadopago" && !envioDefinitivo(fuente)) {
    return error("envio_estimado", "Para pagar con Mercado Pago necesitamos el costo exacto del envío, y el Correo no nos lo está dando en este momento. Elegí transferencia y lo coordinamos, o retiralo en un punto de entrega.");
  }
  const notas = limpiarTexto(d.notas, 300);
  const total = detalle.subtotal + envio;
  const atribucion = limpiarAtribucion(d.atribucion);

  let fila = null;
  for (let intento = 0; intento < 5 && !fila; intento++) {
    const id = uuid();
    const numero = numeroDePedido();
    const t = ahora();
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO orders (id, number, user_id, status, items_json, subtotal, shipping, shipping_source, total, delivery, province, postal_code, street, locality, customer_name, notes, payment_method, discount, idempotency_key, request_fingerprint, attribution_json, created_at, updated_at) VALUES (?, ?, ?, 'recibido', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(id, numero, u.id, JSON.stringify(detalle.items), detalle.subtotal, envio, fuente, total, entrega, provincia, cp, calle, localidad, nombre, notas, pago, detalle.descuento, claveIdem || null, claveIdem ? huella : null, atribucion, t, t),
        env.DB.prepare("INSERT INTO order_events (order_id, status, note, created_at) VALUES (?, 'recibido', 'Pedido recibido', ?)").bind(id, t),
      ]);
      fila = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
    } catch (e) {
      if (!String(e.message).includes("UNIQUE")) throw e;
      // Dos pedidos iguales llegaron a la vez con la misma clave: gana el primero y el otro recibe ese mismo pedido.
      if (claveIdem) {
        const previo = await env.DB.prepare("SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ?").bind(u.id, claveIdem).first();
        if (previo) return json({ pedido: pedidoPublico(previo), repetido: true }, 200);
      }
      // Si no, fue un número de pedido repetido: se reintenta con otro.
    }
  }
  if (!fila) return error("error_interno", "No pudimos guardar el pedido. Probá de nuevo.", 500);

  const sitio = urlSitio(env, request);
  const pedido = { ...fila, items: detalle.items };
  await enviarSinFallar(env, ctx, { to: u.email, ...mailPedidoRecibido(pedido, `${sitio}/cuenta.html`) });
  const dueno = String(env.ADMIN_EMAILS || "").split(",")[0].trim();
  if (dueno) await enviarSinFallar(env, ctx, { to: dueno, ...mailAvisoDueno(pedido, `${sitio}/admin.html`) });

  return json({ pedido: pedidoPublico(fila) }, 201);
}

export async function misPedidos(request, env) {
  const u = await usuarioActual(env, request);
  if (!u) return error("sin_sesion", "Ingresá a tu cuenta.", 401);
  const { results } = await env.DB.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").bind(u.id).all();
  // Número de la factura de cada pedido que ya la tiene emitida (solo el número: el PDF se pide aparte).
  const { results: facts } = await env.DB.prepare("SELECT i.order_id, i.pto_vta, i.cbte_nro FROM invoices i JOIN orders o ON o.id = i.order_id WHERE o.user_id = ? AND i.status = 'emitida'").bind(u.id).all();
  const facturas = new Map(facts.map((f) => [f.order_id, `${String(f.pto_vta).padStart(5, "0")}-${String(f.cbte_nro).padStart(8, "0")}`]));
  return json({ pedidos: results.map((f) => ({ ...pedidoPublico(f), factura: facturas.get(f.id) || null })) });
}

export async function miPedido(request, env, id) {
  const u = await usuarioActual(env, request);
  if (!u) return error("sin_sesion", "Ingresá a tu cuenta.", 401);
  const fila = await env.DB.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").bind(id, u.id).first();
  if (!fila) return error("no_encontrado", "No encontré ese pedido.", 404);
  const { results } = await env.DB.prepare("SELECT * FROM order_events WHERE order_id = ? ORDER BY id").bind(id).all();
  return json({ pedido: pedidoPublico(fila, results) });
}

// Estados en los que el cliente todavía puede arrepentirse: hasta antes del despacho.
export const ESTADOS_CANCELABLES = ["recibido", "pago_confirmado", "preparando"];

// Botón de arrepentimiento: el cliente cancela su compra siempre que el pedido todavía no se haya despachado.
export async function cancelarPedido(request, env, ctx, id) {
  const u = await usuarioActual(env, request);
  if (!u) return error("sin_sesion", "Ingresá a tu cuenta.", 401);
  const fila = await env.DB.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").bind(id, u.id).first();
  if (!fila) return error("no_encontrado", "No encontré ese pedido.", 404);
  if (fila.status === "cancelado") return error("ya_cancelado", "Este pedido ya estaba cancelado.", 409);
  if (!ESTADOS_CANCELABLES.includes(fila.status)) {
    return error("no_cancelable", "Este pedido ya fue despachado, así que no se puede cancelar desde acá. Escribinos a donsticker.ar@gmail.com y lo resolvemos.", 409);
  }
  const t = ahora();
  // La condición de estado va dentro del UPDATE: si el dueño despachó el pedido justo en ese momento, no se cancela.
  const marcas = ESTADOS_CANCELABLES.map(() => "?").join(", ");
  const r = await env.DB.prepare(`UPDATE orders SET status = 'cancelado', updated_at = ? WHERE id = ? AND status IN (${marcas})`).bind(t, id, ...ESTADOS_CANCELABLES).run();
  if (!r.meta?.changes) return error("no_cancelable", "Este pedido ya fue despachado, así que no se puede cancelar desde acá. Escribinos a donsticker.ar@gmail.com y lo resolvemos.", 409);
  await env.DB.prepare("INSERT INTO order_events (order_id, status, note, created_at) VALUES (?, 'cancelado', ?, ?)")
    .bind(id, `Cancelado por el cliente (botón de arrepentimiento). Estaba: ${ESTADOS[fila.status] || fila.status}`, t).run();

  const nueva = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
  const pedido = { ...nueva, items: JSON.parse(nueva.items_json) };
  const sitio = urlSitio(env, request);
  const pagado = fila.status !== "recibido"; // si ya se confirmó el pago, hay que devolver el dinero
  await enviarSinFallar(env, ctx, { to: u.email, ...mailPedidoCancelado(pedido, `${sitio}/cuenta.html`, pagado) });
  const dueno = String(env.ADMIN_EMAILS || "").split(",")[0].trim();
  if (dueno) await enviarSinFallar(env, ctx, { to: dueno, ...mailAvisoCancelacion(pedido, fila.status, `${sitio}/admin.html`) });
  return json({ pedido: pedidoPublico(nueva), devolucion: pagado });
}
