// Carga automática del envío en MiCorreo (Correo Argentino) cuando un pedido con envío tiene el pago confirmado.
//
// Qué hace y qué NO hace: la API de MiCorreo solo permite IMPORTAR el envío (POST /shipping/import). El pago del envío
// (con el saldo de tu cuenta) y el rótulo en PDF se hacen desde el panel de MiCorreo, en «Mis envíos». Acá se ahorra
// cargar a mano destinatario, dirección, peso y medidas de cada pedido.
//
// Se enciende con MICORREO_IMPORTAR = "1", solo en el ambiente de producción y con las credenciales cargadas. Un fallo
// nunca afecta al pedido ni al cobro: queda anotado y el panel lo muestra.

import { json, error, ahora, leerJson } from "./util.js";
import { exigirAdmin } from "./admin.js";
import { ENVIO } from "./precios.js";
import { ambienteCorreo, correoConfigurado, idCliente, baseApi, obtenerToken, fetchCorreo, CAJA_ENVIO } from "./envio.js";

export const importacionActiva = (env) => correoConfigurado(env) && ambienteCorreo(env) === "produccion" && String(env.MICORREO_IMPORTAR || "") === "1";
const ESTADOS_CON_PAGO = ["pago_confirmado", "preparando", "despachado", "entregado"];
const MAX_INTENTOS = 8;
const VALOR_DECLARADO_MINIMO = 1;

// ---------- Provincias: letra que usa el Correo ----------
const sinTildes = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const CODIGOS_PROVINCIA = {
  "salta": "A", "buenos aires": "B", "ciudad autonoma de buenos aires": "C", "capital federal": "C", "caba": "C", "san luis": "D",
  "entre rios": "E", "la rioja": "F", "santiago del estero": "G", "chaco": "H", "san juan": "J", "catamarca": "K", "la pampa": "L",
  "mendoza": "M", "misiones": "N", "formosa": "P", "neuquen": "Q", "rio negro": "R", "santa fe": "S", "tucuman": "T", "chubut": "U",
  "tierra del fuego": "V", "corrientes": "W", "cordoba": "X", "jujuy": "Y", "santa cruz": "Z",
};
export const codigoProvincia = (nombre) => CODIGOS_PROVINCIA[sinTildes(nombre)] || null;

// ---------- Calle y altura ----------
// El formulario tiene un solo campo («calle y número»); el Correo pide la calle y la altura por separado.
// Solo se separa cuando no hay duda; si no, devuelve null y el pedido queda para cargar a mano (nunca se adivina).
const MARCA_NUMERO = /(?<![\p{L}])(?:n[°º.]?|nro\.?|num\.?|n[uú]mero)\s*(\d{1,6})\b/iu;
const TIPO_VIA = /^(?:calle|av\.?|avenida|diagonal|diag\.?|pasaje|pje\.?|ruta|camino)\s+\d{1,3}$/i;
export function separarCalle(texto) {
  const t = String(texto || "").replace(/\s+/g, " ").trim();
  if (t.length < 3) return null;
  let calle, altura, resto;
  const marca = t.match(MARCA_NUMERO);
  if (marca) {
    calle = t.slice(0, marca.index).replace(/[,\s]+$/, "");
    altura = marca[1];
    resto = t.slice(marca.index + marca[0].length);
  } else {
    // Números sueltos, sin los que acompañan a piso/depto/planta.
    const numeros = [...t.matchAll(/\d{1,6}/g)].filter((m) => !/(?:piso|p\.?|dpto\.?|depto\.?|dto\.?|dep\.?|oficina|of\.?|planta|torre|bloque|manzana|mza\.?|casa|lote)\s*$/i.test(t.slice(0, m.index)));
    if (!numeros.length) return null;
    let elegido = numeros[0];
    // «Calle 12 1234»: el primer número es parte del nombre de la calle y el último es la altura.
    if (numeros.length >= 2 && TIPO_VIA.test(t.slice(0, numeros[0].index + numeros[0][0].length).trim())) elegido = numeros[1];
    calle = t.slice(0, elegido.index).replace(/[,\s]+$/, "");
    altura = elegido[0];
    resto = t.slice(elegido.index + elegido[0].length);
  }
  if (calle.length < 2 || !/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(calle)) return null;
  // Piso y departamento, si los escribieron (opcionales; el Correo los trunca a 3 caracteres).
  const piso = (resto.match(/\b(?:piso|p)\.?\s*(\w{1,3})/i) || resto.match(/(\d{1,2})\s*[°º]/) || [])[1] || "";
  let depto = (resto.match(/\b(?:dpto|depto|dto|departamento|dep|of|oficina)\.?\s*(\w{1,3})/i) || [])[1] || "";
  if (!piso && !depto) {
    const corto = resto.trim().match(/^[,\s]*(\d{1,2})\s*([A-Za-z])$/); // «5 B»
    if (corto) return { calle, altura, piso: corto[1], depto: corto[2].toUpperCase() };
  }
  return { calle, altura, piso: piso.slice(0, 3), depto: depto.slice(0, 3) };
}

// ---------- Armado del envío ----------
const stickersDe = (items) => items.reduce((a, i) => a + (i.tipo === "pack" ? (i.unidades || 0) * i.cantidad : i.cantidad), 0);

export function armarEnvio(env, orden, mail) {
  const dir = separarCalle(orden.street);
  if (!dir) return { ok: false, permanente: true, mensaje: `No pude separar la calle y la altura de «${orden.street || ""}». Cargalo a mano en MiCorreo.` };
  const provincia = codigoProvincia(orden.province);
  if (!provincia) return { ok: false, permanente: true, mensaje: `No reconozco la provincia «${orden.province || ""}». Cargalo a mano en MiCorreo.` };
  if (!/^\d{4}$/.test(String(orden.postal_code || ""))) return { ok: false, permanente: true, mensaje: "El código postal del pedido no es válido. Cargalo a mano en MiCorreo." };
  if (!mail) return { ok: false, permanente: true, mensaje: "El cliente ya no tiene cuenta (falta su mail). Cargalo a mano en MiCorreo." };
  const items = JSON.parse(orden.items_json || "[]");
  const gramos = Math.max(1, stickersDe(items) * ENVIO.gramosPorSticker + ENVIO.gramosEmbalaje);
  return {
    ok: true,
    cuerpo: {
      customerId: idCliente(env),
      extOrderId: orden.number,
      orderNumber: orden.number,
      sender: { name: null, phone: null, cellPhone: null, email: null, originAddress: { streetName: null, streetNumber: null, floor: null, apartment: null, city: null, provinceCode: null, postalCode: null } },
      recipient: { name: String(orden.customer_name || "").slice(0, 60), phone: "", cellPhone: "", email: mail },
      shipping: {
        deliveryType: "D",
        agency: null,
        address: { streetName: dir.calle.slice(0, 60), streetNumber: dir.altura, floor: dir.piso, apartment: dir.depto, city: String(orden.locality || "").slice(0, 60), provinceCode: provincia, postalCode: String(orden.postal_code) },
        weight: gramos,
        declaredValue: Math.max(VALOR_DECLARADO_MINIMO, (orden.subtotal || 0) - (orden.discount || 0)),
        height: CAJA_ENVIO.height,
        length: CAJA_ENVIO.length,
        width: CAJA_ENVIO.width,
      },
    },
  };
}

// ---------- Importación ----------
async function anotar(env, orderId, { estado, mensaje = "", permanente = 0, importado = false }) {
  const t = ahora();
  await env.DB.prepare(
    `INSERT INTO micorreo_envios (order_id, estado, error, permanente, intentos, creado_en, actualizado_en, importado_en) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5, ?6)
     ON CONFLICT(order_id) DO UPDATE SET estado = ?2, error = ?3, permanente = ?4, intentos = micorreo_envios.intentos + 1, actualizado_en = ?5, importado_en = COALESCE(?6, micorreo_envios.importado_en)`,
  ).bind(orderId, estado, String(mensaje).slice(0, 300), permanente ? 1 : 0, t, importado ? t : null).run();
}

// Devuelve { estado: "importado" | "error", mensaje, permanente }.
export async function importarEnvio(env, orderId) {
  const orden = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
  if (!orden) return { estado: "error", mensaje: "No encontré ese pedido.", permanente: true };
  if (orden.delivery !== "envio") return { estado: "error", mensaje: "Este pedido se retira en un punto de entrega: no lleva envío.", permanente: true };
  if (!ESTADOS_CON_PAGO.includes(orden.status)) return { estado: "error", mensaje: "El pedido todavía no tiene el pago confirmado.", permanente: true };
  const previo = await env.DB.prepare("SELECT estado FROM micorreo_envios WHERE order_id = ?").bind(orderId).first();
  if (previo?.estado === "importado") return { estado: "importado", mensaje: "Ya estaba cargado en MiCorreo." };

  const cliente = orden.user_id ? await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(orden.user_id).first() : null;
  const envio = armarEnvio(env, orden, cliente?.email);
  if (!envio.ok) { await anotar(env, orderId, { estado: "error", mensaje: envio.mensaje, permanente: 1 }); return { estado: "error", mensaje: envio.mensaje, permanente: true }; }

  try {
    const token = await obtenerToken(env);
    const r = await fetchCorreo(env, `${baseApi(env)}/shipping/import`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(envio.cuerpo) });
    const texto = await r.text().catch(() => "");
    let motivo = texto;
    try { motivo = JSON.parse(texto).message || texto; } catch { /* no era JSON */ }
    motivo = String(motivo).replace(/\s+/g, " ").slice(0, 200);
    // Si ya estaba importada (por ejemplo, un reintento tras un corte), es un éxito.
    if (r.ok || /ya fue importada/i.test(motivo)) { await anotar(env, orderId, { estado: "importado", importado: true }); return { estado: "importado", mensaje: "Cargado en MiCorreo." }; }
    const transitorio = r.status >= 500 || r.status === 429;
    const mensaje = /remitente|origen/i.test(motivo)
      ? `El Correo pide configurar el origen en tu cuenta de MiCorreo (${motivo}).`
      : `El Correo no aceptó el envío (${r.status}): ${motivo || "sin detalle"}. Cargalo a mano en MiCorreo.`;
    await anotar(env, orderId, { estado: "error", mensaje: transitorio ? `El Correo no respondió (${r.status}). Se reintenta solo.` : mensaje, permanente: transitorio ? 0 : 1 });
    return { estado: "error", mensaje: transitorio ? `El Correo no respondió (${r.status}). Se reintenta solo.` : mensaje, permanente: !transitorio };
  } catch (e) {
    await anotar(env, orderId, { estado: "error", mensaje: "No pude conectarme con el Correo. Se reintenta solo.", permanente: 0 });
    return { estado: "error", mensaje: "No pude conectarme con el Correo. Se reintenta solo.", permanente: false };
  }
}

// Desde el aviso de pago y el panel: nunca frena ni rompe lo que lo llamó.
export function importarSinFallar(env, ctx, orderId) {
  if (!importacionActiva(env)) return;
  const tarea = importarEnvio(env, orderId).catch((e) => console.error("Importación a MiCorreo fallida:", e.message));
  if (ctx?.waitUntil) ctx.waitUntil(tarea);
}

// Tarea periódica: reintenta los que fallaron por un corte del Correo (hasta 8 veces).
export async function reintentarImportaciones(env) {
  if (!importacionActiva(env)) return 0;
  const { results } = await env.DB.prepare("SELECT order_id FROM micorreo_envios WHERE estado = 'error' AND permanente = 0 AND intentos < ? ORDER BY actualizado_en LIMIT 10").bind(MAX_INTENTOS).all();
  for (const f of results || []) await importarEnvio(env, f.order_id).catch((e) => console.error("Reintento a MiCorreo fallido:", e.message));
  return (results || []).length;
}

// Estado por pedido, para el panel.
export async function estadoPorPedido(env) {
  const { results } = await env.DB.prepare("SELECT order_id, estado, error, permanente FROM micorreo_envios").all();
  return new Map((results || []).map((f) => [f.order_id, { estado: f.estado, error: f.error, permanente: Boolean(f.permanente) }]));
}

// POST /api/admin/pedidos/:id/micorreo — el botón «Enviar a MiCorreo» del panel.
export async function importarDesdePanel(request, env, ctx, id) {
  const a = await exigirAdmin(request, env);
  if (a.respuesta) return a.respuesta;
  const lectura = await leerJson(request);
  if (!lectura.ok) return lectura.respuesta;
  if (!importacionActiva(env)) return error("micorreo_apagado", "La carga automática en MiCorreo está apagada.", 409);
  const r = await importarEnvio(env, id);
  return json({ estado: r.estado, mensaje: r.mensaje });
}
