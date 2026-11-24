// Avisos al celular (Web Push, RFC 8030) sobre el estado del pedido. Sin servicios de terceros ni librerías:
//  - Cifrado del aviso: RFC 8291 (aes128gcm), con WebCrypto.
//  - Identificación del servidor ante Google/Mozilla/Apple: VAPID, RFC 8292 (JWT firmado con ES256).
// Se enciende solo cuando están cargadas las dos claves: VAPID_PUBLIC_KEY (variable) y VAPID_PRIVATE_KEY (SECRETO).
// Sin ellas, la web ni siquiera ofrece activar los avisos y el resto del servicio funciona igual.

import { json, error, ahora, leerJson, limitarPor, fetchExterno } from "./util.js";
import { usuarioActual } from "./auth.js";

const codificador = new TextEncoder();
export const pushActivo = (env) => Boolean(env?.VAPID_PUBLIC_KEY && env?.VAPID_PRIVATE_KEY);

// ---------- Utilidades de bytes ----------
export function deBase64Url(texto) {
  const b64 = String(texto).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
export const aBase64Url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unir = (...partes) => {
  const salida = new Uint8Array(partes.reduce((a, p) => a + p.length, 0));
  let i = 0;
  for (const p of partes) { salida.set(p, i); i += p.length; }
  return salida;
};

// ---------- Qué direcciones se aceptan ----------
// El servidor le escribe a la dirección que informa el navegador: para que nadie use esta función para pedirle cosas
// a un sitio cualquiera, solo se aceptan los servicios de push de los navegadores conocidos, siempre por https.
const SERVICIOS_PUSH = [
  /^(fcm|android)\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];

export function validarSuscripcion(d) {
  try {
    const url = new URL(String(d?.endpoint || ""));
    if (url.protocol !== "https:" || url.port || url.username || url.password || String(d.endpoint).length > 1000) return null;
    if (!SERVICIOS_PUSH.some((r) => r.test(url.hostname))) return null;
    const p256dh = String(d?.keys?.p256dh || "");
    const auth = String(d?.keys?.auth || "");
    if (!/^[A-Za-z0-9_-]+$/.test(p256dh) || !/^[A-Za-z0-9_-]+$/.test(auth)) return null;
    const clave = deBase64Url(p256dh);
    if (clave.length !== 65 || clave[0] !== 4 || deBase64Url(auth).length !== 16) return null;
    return { endpoint: url.toString(), p256dh, auth };
  } catch { return null; }
}

// ---------- Cifrado del aviso (RFC 8291, aes128gcm) ----------
// «prueba» solo lo usa el test para fijar la sal y la clave efímera y comparar con el vector del propio RFC.
export async function cifrarAviso(texto, p256dh, auth, prueba = {}) {
  const ua = deBase64Url(p256dh);
  const secretoAuth = deBase64Url(auth);
  const par = prueba.par || (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
  const publicaServidor = new Uint8Array(await crypto.subtle.exportKey("raw", par.publicKey));
  const publicaUa = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const compartido = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: publicaUa }, par.privateKey, 256));
  const sal = prueba.sal || crypto.getRandomValues(new Uint8Array(16));

  const hkdf = async (material, salHkdf, info, bytes) => {
    const k = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salHkdf, info }, k, bytes * 8));
  };
  const material = await hkdf(compartido, secretoAuth, unir(codificador.encode("WebPush: info\0"), ua, publicaServidor), 32);
  const clave = await hkdf(material, sal, codificador.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(material, sal, codificador.encode("Content-Encoding: nonce\0"), 12);

  // Un solo registro: el texto y un 0x02 que marca el último registro.
  const claro = unir(codificador.encode(texto), new Uint8Array([2]));
  const aes = await crypto.subtle.importKey("raw", clave, "AES-GCM", false, ["encrypt"]);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, claro));
  // Cabecera: sal (16) + tamaño de registro 4096 (4) + largo de la clave (1) + clave pública del servidor (65).
  return unir(sal, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([publicaServidor.length]), publicaServidor, cifrado);
}

// ---------- Identificación del servidor (VAPID, RFC 8292) ----------
export async function cabeceraVapid(env, endpoint, ahoraSeg = Math.floor(Date.now() / 1000)) {
  const pub = deBase64Url(env.VAPID_PUBLIC_KEY);
  const jwk = { kty: "EC", crv: "P-256", d: env.VAPID_PRIVATE_KEY, x: aBase64Url(pub.slice(1, 33)), y: aBase64Url(pub.slice(33, 65)), ext: true };
  const clave = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const parte = (o) => aBase64Url(codificador.encode(JSON.stringify(o)));
  const cuerpo = `${parte({ typ: "JWT", alg: "ES256" })}.${parte({ aud: new URL(endpoint).origin, exp: ahoraSeg + 12 * 3600, sub: env.VAPID_SUBJECT || "mailto:donsticker.ar@gmail.com" })}`;
  const firma = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, clave, codificador.encode(cuerpo)));
  return `vapid t=${cuerpo}.${aBase64Url(firma)}, k=${env.VAPID_PUBLIC_KEY}`;
}

// ---------- Envío ----------
// Devuelve "ok", "caducada" (el dispositivo ya no existe: se borra) o "error:<estado>".
export async function enviarAviso(env, sub, aviso) {
  const cuerpo = await cifrarAviso(JSON.stringify(aviso), sub.p256dh, sub.auth);
  const cabeceras = {
    Authorization: await cabeceraVapid(env, sub.endpoint),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: "172800",
    Urgency: "normal",
  };
  // Con la misma etiqueta, un aviso nuevo reemplaza al que todavía no se entregó (el estado viejo ya no importa).
  if (aviso.etiqueta) cabeceras.Topic = aviso.etiqueta.slice(0, 32);
  const r = await fetchExterno(env, sub.endpoint, { method: "POST", headers: cabeceras, body: cuerpo });
  if (r.status === 404 || r.status === 410) {
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(sub.id).run();
    return "caducada";
  }
  if (r.ok) {
    await env.DB.prepare("UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?").bind(ahora(), sub.id).run();
    return "ok";
  }
  return `error:${r.status}`;
}

export async function enviarAUsuario(env, userId, aviso) {
  const { results } = await env.DB.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?").bind(userId).all();
  const resultados = [];
  for (const sub of results) {
    try { resultados.push(await enviarAviso(env, sub, aviso)); } catch (e) { resultados.push(`error:${e.message}`); }
  }
  return resultados;
}

// ---------- Qué se avisa (voz del Don: calmo, sin exclamaciones) ----------
export function avisoDePedido(p, { cambioEstado, cambioSeg }) {
  const n = p.number;
  const seg = p.tracking_number ? ` Seguimiento: ${p.tracking_number}.` : "";
  let texto = "";
  if (cambioEstado) {
    texto = {
      pago_confirmado: `Pedido ${n}. El pago llegó. Ya me ocupo yo.`,
      despachado: p.delivery === "envio" ? `Pedido ${n}. Salió rumbo a tu casa.${seg}` : `Pedido ${n}. Está listo. Coordinamos la entrega en ${p.delivery}.`,
      entregado: `Pedido ${n}. Entregado. Ahora, a pegarlos con criterio.`,
      cancelado: `Pedido ${n}. Quedó cancelado. Si no fuiste vos, escribinos.`,
    }[p.status] || "";
  } else if (cambioSeg && p.tracking_number && p.status === "despachado") {
    texto = `Pedido ${n}. Número de seguimiento: ${p.tracking_number}.`;
  }
  return texto ? { titulo: "Don Sticker", texto, url: "/cuenta", etiqueta: `pedido-${n}` } : null;
}

// Lo llaman el panel (admin.js) y los pagos (pagos.js) al cambiar un pedido. Nunca rompe lo que lo llamó.
export async function avisarCambioDePedido(env, ctx, pedido, cambios) {
  if (!pushActivo(env) || !pedido?.user_id) return;
  const aviso = avisoDePedido(pedido, cambios);
  if (!aviso) return;
  const trabajo = enviarAUsuario(env, pedido.user_id, aviso).catch((e) => console.error("Aviso al celular fallido:", e.message));
  if (ctx?.waitUntil) ctx.waitUntil(trabajo); else await trabajo;
}

// ---------- API ----------
const MAX_DISPOSITIVOS = 5;

async function conSesion(request, env) {
  if (!pushActivo(env)) return { respuesta: error("push_apagado", "Los avisos al celular no están disponibles.", 503) };
  const u = await usuarioActual(env, request);
  if (!u) return { respuesta: error("sin_sesion", "Ingresá a tu cuenta.", 401) };
  return { u };
}

export async function suscribir(request, env) {
  const s = await conSesion(request, env);
  if (s.respuesta) return s.respuesta;
  if (!(await limitarPor(env, "push", s.u.id, 30, 3600))) return error("demasiados_intentos", "Probá de nuevo en un rato.", 429);
  const lectura = await leerJson(request, 4000);
  if (!lectura.ok) return lectura.respuesta;
  const sub = validarSuscripcion(lectura.datos);
  if (!sub) return error("suscripcion_invalida", "Este dispositivo no admite los avisos.");
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ? AND endpoint <> ?").bind(s.u.id, sub.endpoint).first();
  if (n >= MAX_DISPOSITIVOS) return error("demasiados_dispositivos", `Podés tener avisos en hasta ${MAX_DISPOSITIVOS} dispositivos. Desactivá alguno desde otro.`, 409);
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  ).bind(s.u.id, sub.endpoint, sub.p256dh, sub.auth, ahora()).run();
  return json({ ok: true });
}

export async function desuscribir(request, env) {
  const s = await conSesion(request, env);
  if (s.respuesta) return s.respuesta;
  const lectura = await leerJson(request, 2000);
  if (!lectura.ok) return lectura.respuesta;
  const endpoint = String(lectura.datos?.endpoint || "");
  if (endpoint) await env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").bind(s.u.id, endpoint).run();
  return json({ ok: true });
}

export async function probar(request, env) {
  const s = await conSesion(request, env);
  if (s.respuesta) return s.respuesta;
  if (!(await limitarPor(env, "push-prueba", s.u.id, 5, 3600))) return error("demasiados_intentos", "Ya probaste varias veces. Esperá un rato.", 429);
  const r = await enviarAUsuario(env, s.u.id, { titulo: "Don Sticker", texto: "Funciona. Te escribo solo cuando cambie el estado de tu pedido.", url: "/cuenta", etiqueta: "prueba" });
  return json({ enviados: r.filter((x) => x === "ok").length, dispositivos: r.length });
}
