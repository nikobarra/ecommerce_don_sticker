// Utilidades compartidas: respuestas, cookies, hashes y validaciones.

export const json = (datos, status = 200, extra = {}) =>
  new Response(JSON.stringify(datos), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

export const error = (codigo, mensaje, status = 400) => json({ error: codigo, mensaje }, status);

export const ahora = () => new Date().toISOString();

// ---------- Lectura del cuerpo ----------
// El límite es en BYTES y se aplica MIENTRAS se lee: un cuerpo enorme se corta apenas lo supera,
// sin cargarlo entero en memoria (con UTF-8, un carácter puede ocupar hasta 4 bytes).
async function leerLimitado(request, maxBytes) {
  if (!request.body) return '';
  const lector = request.body.getReader();
  const partes = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await lector.cancel().catch(() => {});
      throw new Error('muy_grande');
    }
    partes.push(value);
  }
  const todo = new Uint8Array(total);
  let pos = 0;
  for (const p of partes) { todo.set(p, pos); pos += p.byteLength; }
  return new TextDecoder().decode(todo);
}

export async function leerJson(request, maxBytes = 20000) {
  const tipo = request.headers.get('content-type') || '';
  if (!tipo.includes('application/json')) return { ok: false, respuesta: error('tipo_invalido', 'Contenido no válido.', 415) };
  const declarado = Number(request.headers.get('content-length'));
  if (declarado > maxBytes) return { ok: false, respuesta: error('muy_grande', 'Pedido demasiado grande.', 413) };
  let texto;
  try {
    texto = await leerLimitado(request, maxBytes);
  } catch (e) {
    if (e.message === 'muy_grande') return { ok: false, respuesta: error('muy_grande', 'Pedido demasiado grande.', 413) };
    return { ok: false, respuesta: error('json_invalido', 'No pude leer los datos enviados.') };
  }
  try {
    const datos = JSON.parse(texto || '{}');
    if (datos === null || typeof datos !== 'object' || Array.isArray(datos)) throw new Error('no objeto');
    return { ok: true, datos };
  } catch {
    return { ok: false, respuesta: error('json_invalido', 'No pude leer los datos enviados.') };
  }
}

// ---------- Aleatorios y hashes ----------
const aBase64Url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const deBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export const tokenAleatorio = (bytes = 32) => aBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
export const uuid = () => crypto.randomUUID();

export async function sha256(texto) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function iguales(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- Contraseñas (PBKDF2-SHA256; Workers admite hasta 100.000 iteraciones) ----------
const ITERACIONES = 100000;

async function derivar(password, sal, iteraciones) {
  const clave = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: iteraciones }, clave, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivar(password, sal, ITERACIONES);
  return `pbkdf2$sha256$${ITERACIONES}$${aBase64Url(sal)}$${aBase64Url(hash)}`;
}

const base64UrlABytes = (s) => deBase64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));

export async function verificarPassword(password, guardado) {
  const partes = String(guardado || "").split("$");
  if (partes.length !== 5 || partes[0] !== "pbkdf2") return false;
  const calculado = aBase64Url(await derivar(password, base64UrlABytes(partes[3]), Number(partes[2])));
  return iguales(calculado, partes[4]);
}

// Se usa cuando el mail no existe, para que la respuesta tarde lo mismo y no delate qué mails están registrados.
export const HASH_FALSO = "pbkdf2$sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// ---------- Validaciones ----------
export const normalizarMail = (m) => String(m || "").trim().toLowerCase();
export const mailValido = (m) => m.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(m);

export function validarPassword(password, mail = "") {
  if (typeof password !== "string") return "Escribí una contraseña.";
  if (password.length < 10) return "La contraseña tiene que tener al menos 10 caracteres.";
  if (password.length > 128) return "La contraseña es demasiado larga (máximo 128).";
  if (mail && password.toLowerCase().includes(mail.split("@")[0]) && mail.split("@")[0].length >= 4) return "La contraseña no puede contener tu mail.";
  if (/^(.)\1+$/.test(password)) return "Elegí una contraseña menos obvia.";
  return "";
}

export const limpiarTexto = (t, max) => String(t ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

// ---------- Cookies ----------
export function leerCookies(request) {
  const salida = {};
  for (const par of (request.headers.get("cookie") || "").split(";")) {
    const i = par.indexOf("=");
    if (i > 0) salida[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
  }
  return salida;
}

// Solo el desarrollo local, declarado de forma EXPLÍCITA (ENTORNO=local en .dev.vars), puede
// funcionar sin https. En producción esa variable no existe, así que la cookie siempre es Secure
// y la API no atiende por http, aunque la dirección de la petición diga otra cosa.
export const esLocal = (env) => String(env?.ENTORNO || "").toLowerCase() === "local";

export function cookie(nombre, valor, env, { maxAge } = {}) {
  return [
    `${nombre}=${encodeURIComponent(valor)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    esLocal(env) ? "" : "Secure",
    maxAge !== undefined ? `Max-Age=${maxAge}` : "",
  ].filter(Boolean).join("; ");
}

// ---------- Límite de intentos ----------
// Una sola sentencia atómica: D1 ejecuta cada sentencia completa antes de la siguiente, así que
// dos pedidos simultáneos no pueden leer el mismo contador y pasar los dos (con SELECT + UPDATE
// separados, sí podían). Si la ventana venció, el contador arranca de nuevo en 1.
export async function limitar(env, clave, max, ventanaSeg) {
  const fila = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN ?2 - window_start > ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN ?2 - window_start > ?3 THEN ?2 ELSE window_start END
     RETURNING count`,
  ).bind(clave, Date.now(), ventanaSeg * 1000).first();
  return Number(fila?.count) <= max;
}

// Limpieza de lo que ya no sirve para nada: contadores de límite viejos, sesiones y enlaces
// vencidos. NO toca pedidos, historial, consentimientos ni mails: eso es evidencia comercial.
export async function limpiarVencidos(env, ahoraMs = Date.now()) {
  const DIA = 24 * 3600 * 1000;
  const r = await env.DB.batch([
    env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(ahoraMs - 2 * DIA),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(ahoraMs),
    env.DB.prepare("DELETE FROM auth_tokens WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)").bind(ahoraMs, ahoraMs - 7 * DIA),
  ]);
  return r.map((x) => x.meta?.changes ?? 0);
}

// ---------- Llamadas a servicios externos ----------
// Toda llamada a Mercado Pago, el Correo, Google o Resend lleva un plazo: sin él, un proveedor
// colgado deja la petición esperando hasta que Cloudflare la corte. TIMEOUT_EXTERNO_MS lo ajusta.
export const TIMEOUT_EXTERNO_MS = 8000;

export async function fetchExterno(env, url, opciones = {}, ms) {
  const limite = Number(ms ?? env?.TIMEOUT_EXTERNO_MS) || TIMEOUT_EXTERNO_MS;
  const control = new AbortController();
  const temporizador = setTimeout(() => control.abort(new DOMException("plazo vencido", "TimeoutError")), limite);
  const senal = opciones.signal ? AbortSignal.any([opciones.signal, control.signal]) : control.signal;
  try {
    return await fetch(url, { ...opciones, signal: senal });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw Object.assign(new Error("tiempo_agotado"), { transitorio: true });
    throw Object.assign(new Error(e?.message || "red"), { transitorio: true });
  } finally {
    clearTimeout(temporizador);
  }
}

export const ipDe = (request) => request.headers.get("CF-Connecting-IP") || "local";

// Las claves del límite de intentos NO llevan la IP ni el mail en claro: llevan una huella (SHA-256) que cambia
// todos los días y, si está cargado el secreto IP_SALT, también depende de él. Así la base nunca guarda una IP
// ni un mail por este motivo, y la huella de un día no sirve para seguir a nadie al día siguiente.
export async function huella(env, valor) {
  const dia = new Date().toISOString().slice(0, 10);
  return (await sha256(`${valor}|${dia}|${env?.IP_SALT || ""}`)).slice(0, 32);
}

export async function limitarPor(env, prefijo, valor, max, ventanaSeg) {
  return limitar(env, `${prefijo}:${await huella(env, valor)}`, max, ventanaSeg);
}

// Mercado Pago necesita las DOS claves: el token para cobrar y el secreto para validar
// el aviso de pago. Con una sola, el cliente pagaría y el pedido nunca se confirmaría solo.
export const mercadoPagoActivo = (env) => Boolean(env.MP_ACCESS_TOKEN && env.MP_WEBHOOK_SECRET);
