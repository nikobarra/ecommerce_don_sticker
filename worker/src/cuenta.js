// Datos de la cuenta, consentimiento para novedades, baja y eliminación de la cuenta.

import { json, error, leerJson, limpiarTexto, cookie } from "./util.js";
import { usuarioActual, usuarioPublico, registrarConsentimiento, COOKIE_SESION } from "./auth.js";
import { pedidoPublico } from "./pedidos.js";

export async function actualizarPerfil(request, env) {
  const u = await usuarioActual(env, request);
  if (!u) return error("sin_sesion", "Ingresá a tu cuenta.", 401);
  const lectura = await leerJson(request);
  if (!lectura.ok) return lectura.respuesta;
  const { nombre, novedades } = lectura.datos;

  if (nombre !== undefined) {
    const nom = limpiarTexto(nombre, 80);
    if (nom.length < 2) return error("nombre_invalido", "Escribí tu nombre.");
    await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(nom, u.id).run();
  }
  if (novedades !== undefined) {
    if (typeof novedades !== "boolean") return error("dato_invalido", "Dato no válido.");
    if (novedades !== Boolean(u.marketing_consent)) await registrarConsentimiento(env, u.id, novedades ? "granted" : "revoked", "cuenta");
  }
  const fila = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(u.id).first();
  return json({ usuario: usuarioPublico(env, fila) });
}

// Derecho de acceso: el cliente puede bajar todo lo que guardamos de él.
export async function misDatos(request, env) {
  const u = await usuarioActual(env, request);
  if (!u) return error("sin_sesion", "Ingresá a tu cuenta.", 401);
  const pedidos = await env.DB.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at").bind(u.id).all();
  const consentimientos = await env.DB.prepare("SELECT action, channel, text_version, created_at FROM consent_events WHERE user_id = ? ORDER BY id").bind(u.id).all();
  return json(
    {
      cuenta: { email: u.email, nombre: u.name, mailVerificado: Boolean(u.email_verified), creada: u.created_at, ultimoIngreso: u.last_login_at, ingresaConGoogle: Boolean(u.google_sub) },
      novedades: { activas: Boolean(u.marketing_consent), desde: u.marketing_consent_at, historial: consentimientos.results },
      pedidos: pedidos.results.map((f) => pedidoPublico(f)),
    },
    200,
    { "content-disposition": 'attachment; filename="mis-datos-don-sticker.json"' },
  );
}

// Derecho de supresión: se borra la cuenta y los pedidos quedan sin datos personales.
export async function eliminarCuenta(request, env) {
  const u = await usuarioActual(env, request);
  if (!u) return error("sin_sesion", "Ingresá a tu cuenta.", 401);
  const lectura = await leerJson(request);
  if (!lectura.ok) return lectura.respuesta;
  if (lectura.datos.confirmacion !== "ELIMINAR") return error("sin_confirmar", "Escribí ELIMINAR para confirmar.");
  // Se conservan los pedidos como registro comercial/fiscal, pero sin ningún dato que identifique a la persona:
  // nombre, calle, localidad, código postal, aclaraciones, identificadores de clic de campañas y la clave de
  // idempotencia. También se borran los mails guardados para esa dirección en mail_log (solo existe si el
  // servicio de mail está en modo «log»; ahí quedan los enlaces de verificación y de recuperación).
  // Lo que NO se toca: las notas del historial (order_events) que escribió el dueño, que son parte del
  // registro operativo del pedido; ver el informe de auditoría, sección de privacidad.
  await env.DB.batch([
    env.DB.prepare("UPDATE orders SET user_id = NULL, customer_name = '(cuenta eliminada)', street = NULL, locality = NULL, postal_code = NULL, notes = '', attribution_json = NULL, idempotency_key = NULL, request_fingerprint = NULL WHERE user_id = ?").bind(u.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(u.id),
    env.DB.prepare("DELETE FROM auth_tokens WHERE user_id = ?").bind(u.id),
    env.DB.prepare("DELETE FROM consent_events WHERE user_id = ?").bind(u.id),
    env.DB.prepare("DELETE FROM newsletter_envios WHERE user_id = ?").bind(u.id),
    env.DB.prepare("DELETE FROM mail_log WHERE to_addr = ?").bind(u.email),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(u.id),
  ]);
  return json({ ok: true }, 200, { "set-cookie": cookie(COOKIE_SESION, "", env, { maxAge: 0 }) });
}

// ---------- Baja de novedades con un clic (enlace de los mails) ----------
async function darDeBaja(env, token) {
  if (typeof token !== "string" || token.length < 10 || token.length > 100) return false;
  const u = await env.DB.prepare("SELECT * FROM users WHERE unsubscribe_token = ?").bind(token).first();
  if (!u) return false;
  if (u.marketing_consent) await registrarConsentimiento(env, u.id, "revoked", "baja");
  return true;
}

const paginaBaja = (titulo, texto) =>
  new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Don Sticker</title>
<style>body{margin:0;background:#FDF4E6;color:#160000;font-family:Arial,Helvetica,sans-serif;display:grid;place-items:center;min-height:100vh;padding:20px}main{max-width:460px;text-align:center}h1{color:#FD0000;font-size:2rem}a{color:#812120;font-weight:700}</style></head>
<body><main><h1>${titulo}</h1><p>${texto}</p><p><a href="/">Volver a Don Sticker</a></p></main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" } },
  );

export async function baja(request, env) {
  const token = new URL(request.url).searchParams.get("t");
  // Los mails con "List-Unsubscribe-Post" hacen un POST sin interfaz; el enlace normal es un GET.
  const ok = await darDeBaja(env, token);
  if (request.method === "POST") return json({ ok }, ok ? 200 : 404);
  return ok
    ? paginaBaja("Listo, te diste de baja", "No te vamos a mandar más novedades por mail. Podés volver a activarlas cuando quieras desde tu cuenta.")
    : paginaBaja("El enlace no es válido", "No pudimos procesar la baja con este enlace. Si tenés cuenta, podés desactivar las novedades desde «Mi cuenta».");
}
