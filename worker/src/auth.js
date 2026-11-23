// Cuentas: registro, ingreso, sesiones, recuperación de contraseña y "Continuar con Google".

import {
  json, error, ahora, leerJson, tokenAleatorio, uuid, sha256, hashPassword, verificarPassword, HASH_FALSO,
  normalizarMail, mailValido, validarPassword, limpiarTexto, cookie, leerCookies, limitar, limitarPor, ipDe,
} from "./util.js";
import { enviarSinFallar, mailVerificacion, mailRestablecer, mailGoogleVinculado, urlSitio } from "./mail.js";
import { verificarTokenGoogle } from "./google.js";

export const COOKIE_SESION = "ds_sesion";
const VIDA_SESION_MS = 30 * 24 * 3600 * 1000;
const VIDA_SESION_ADMIN_MS = 7 * 24 * 3600 * 1000; // quien administra vuelve a entrar con Google cada semana
const VIDA_VERIFICACION_MS = 24 * 3600 * 1000;
const VIDA_RESTABLECER_MS = 3600 * 1000;

// Versión del texto que ve el cliente al dar su consentimiento. Si se cambia el texto, cambiar la versión.
export const VERSION_CONSENTIMIENTO = "2026-11-v2";
export const TEXTO_CONSENTIMIENTO = "Quiero enterarme antes que nadie de los diseños nuevos, recibir cupones de descuento y entrar a las promociones exclusivas de la familia. Un mail por semana, como máximo, y me doy de baja cuando quiera.";

// Administra solo quien tiene el mail verificado, figura en ADMIN_EMAILS Y entra con Google (google_sub).
// Exigir Google evita que una cuenta creada con contraseña por otra persona, para ese mismo mail, pase a
// ser administradora el día que el dueño confirme el mail por cualquier vía.
export const esAdmin = (env, u) =>
  Boolean(u.email_verified) && Boolean(u.google_sub) &&
  String(env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean).includes(u.email);

export const usuarioPublico = (env, u) => ({
  id: u.id,
  email: u.email,
  nombre: u.name,
  mailVerificado: Boolean(u.email_verified),
  novedades: Boolean(u.marketing_consent),
  tienePassword: Boolean(u.password_hash),
  tieneGoogle: Boolean(u.google_sub),
  admin: esAdmin(env, u),
});

export async function registrarConsentimiento(env, userId, accion, canal) {
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET marketing_consent = ?, marketing_consent_at = ? WHERE id = ?").bind(accion === "granted" ? 1 : 0, ahora(), userId),
    env.DB.prepare("INSERT INTO consent_events (user_id, action, channel, text_version, created_at) VALUES (?, ?, ?, ?, ?)").bind(userId, accion, canal, VERSION_CONSENTIMIENTO, ahora()),
  ]);
}

// Si alguien aceptó recibir novedades con un mail que no había demostrado tener, ese consentimiento no
// vale: se desactiva y queda el registro de por qué.
function anularConsentimiento(env, userId, canal) {
  return [
    env.DB.prepare("UPDATE users SET marketing_consent = 0, marketing_consent_at = ? WHERE id = ?").bind(ahora(), userId),
    env.DB.prepare("INSERT INTO consent_events (user_id, action, channel, text_version, created_at) VALUES (?, 'revoked', ?, ?, ?)").bind(userId, canal, VERSION_CONSENTIMIENTO, ahora()),
  ];
}

// ---------- Sesiones ----------
// Cada ingreso crea una sesión nueva y cierra la que traía el navegador (rotación): una cookie vieja
// o ajena no sobrevive a un ingreso. La sesión del administrador dura menos que la de un cliente.
async function iniciarSesion(env, request, u, respuestaDatos, status = 200) {
  const valor = tokenAleatorio(32);
  const vida = esAdmin(env, u) ? VIDA_SESION_ADMIN_MS : VIDA_SESION_MS;
  const anterior = leerCookies(request)[COOKIE_SESION];
  const sentencias = [
    env.DB.prepare("INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(await sha256(valor), u.id, Date.now() + vida, ahora()),
    env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(ahora(), u.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").bind(u.id, Date.now()),
  ];
  if (anterior) sentencias.push(env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(anterior)));
  await env.DB.batch(sentencias);
  return json(respuestaDatos, status, { "set-cookie": cookie(COOKIE_SESION, valor, env, { maxAge: vida / 1000 }) });
}

export async function usuarioActual(env, request) {
  const valor = leerCookies(request)[COOKIE_SESION];
  if (!valor) return null;
  return env.DB.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?",
  ).bind(await sha256(valor), Date.now()).first();
}

async function crearTokenAuth(env, userId, tipo, vidaMs) {
  const valor = tokenAleatorio(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND kind = ?").bind(userId, tipo), // vale solo el último enlace
    env.DB.prepare("INSERT INTO auth_tokens (id_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256(valor), userId, tipo, Date.now() + vidaMs),
  ]);
  return valor;
}

async function enviarVerificacion(env, ctx, request, u) {
  const t = await crearTokenAuth(env, u.id, "verify", VIDA_VERIFICACION_MS);
  const url = `${urlSitio(env, request)}/verificar.html?token=${t}`;
  await enviarSinFallar(env, ctx, { to: u.email, ...mailVerificacion(url, u.name) });
}

// ---------- Rutas ----------
export async function registro(request, env, ctx) {
  const lectura = await leerJson(request);
  if (!lectura.ok) return lectura.respuesta;
  const { email, password, nombre, novedades } = lectura.datos;
  const mail = normalizarMail(email);
  const nom = limpiarTexto(nombre, 80);

  if (!(await limitarPor(env, "reg", ipDe(request), 10, 3600))) return error("demasiados_intentos", "Hiciste muchos intentos. Probá de nuevo en un rato.", 429);
  if (!mailValido(mail)) return error("mail_invalido", "Escribí un mail válido.");
  if (nom.length < 2) return error("nombre_invalido", "Escribí tu nombre.");
  const fallo = validarPassword(password, mail);
  if (fallo) return error("password_invalida", fallo);

  const existente = await env.DB.prepare("SELECT id, google_sub FROM users WHERE email = ?").bind(mail).first();
  if (existente) {
    return error("mail_existente", existente.google_sub ? "Ya hay una cuenta con ese mail. Entrá con Google o recuperá tu contraseña." : "Ya hay una cuenta con ese mail. Ingresá o recuperá tu contraseña.", 409);
  }

  const u = { id: uuid(), email: mail, name: nom };
  await env.DB.prepare(
    "INSERT INTO users (id, email, name, password_hash, email_verified, unsubscribe_token, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
  ).bind(u.id, u.email, u.name, await hashPassword(password), tokenAleatorio(24), ahora()).run();
  if (novedades === true) await registrarConsentimiento(env, u.id, "granted", "registro");
  await enviarVerificacion(env, ctx, request, u);

  const fila = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(u.id).first();
  return iniciarSesion(env, request, fila, { usuario: usuarioPublico(env, fila) }, 201);
}

export async function ingreso(request, env) {
  const lectura = await leerJson(request);
  if (!lectura.ok) return lectura.respuesta;
  const mail = normalizarMail(lectura.datos.email);
  const password = typeof lectura.datos.password === "string" ? lectura.datos.password.slice(0, 200) : "";

  const permitido = (await limitarPor(env, "login-ip", ipDe(request), 30, 900)) && (await limitarPor(env, "login-mail", mail, 8, 900));
  if (!permitido) return error("demasiados_intentos", "Hiciste muchos intentos. Probá de nuevo en unos minutos.", 429);

  const u = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(mail).first();
  const ok = await verificarPassword(password, u?.password_hash || HASH_FALSO); // misma demora exista o no el mail
  if (!u || !u.password_hash || !ok) return error("credenciales", "El mail o la contraseña no son correctos.", 401);
  return iniciarSesion(env, request, u, { usuario: usuarioPublico(env, u) });
}

export async function salida(request, env) {
  const valor = leerCookies(request)[COOKIE_SESION];
  if (valor) await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(valor)).run();
  return json({ ok: true }, 200, { "set-cookie": cookie(COOKIE_SESION, "", env, { maxAge: 0 }) });
}

export async function yo(request, env) {
  const u = await usuarioActual(env, request);
  return json({ usuario: u ? usuarioPublico(env, u) : null });
}

export async function olvide(request, env, ctx) {
  const lectura = await leerJson(request);
  if (!lectura.ok) return lectura.respuesta;
  const mail = normalizarMail(lectura.datos.email);
  const generica = json({ ok: true, mensaje: "Si ese mail tiene una cuenta, te mandamos un enlace para elegir una contraseña nueva." });

  if (!mailValido(mail)) return generica;
  const permitido = (await limitarPor(env, "olvide-ip", ipDe(request), 10, 3600)) && (await limitarPor(env, "olvide-mail", mail, 3, 3600));
  if (!permitido) return error("demasiados_intentos", "Pediste muchos enlaces. Probá de nuevo en un rato.", 429);

  const u = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(mail).first();
  if (u) {
    const t = await crearTokenAuth(env, u.id, "reset", VIDA_RESTABLECER_MS);
    await enviarSinFallar(env, ctx, { to: u.email, ...mailRestablecer(`${urlSitio(env, request)}/restablecer.html?token=${t}`) });
  }
  return generica;
}

async function consumirToken(env, valor, tipo) {
  if (typeof valor !== "string" || valor.length < 20 || valor.length > 100) return null;
  const hash = await sha256(valor);
  const fila = await env.DB.prepare("SELECT * FROM auth_tokens WHERE id_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?").bind(hash, tipo, Date.now()).first();
  if (!fila) return null;
  const r = await env.DB.prepare("UPDATE auth_tokens SET used_at = ? WHERE id_hash = ? AND used_at IS NULL").bind(Date.now(), hash).run();
  if (!r.meta?.changes) return null; // otro pedido lo usó primero
  return fila;
}

export async function restablecer(request, env) {
  const lectura = await leerJson(request);
  if (!lectura.ok) return lectura.respuesta;
  const { token, password } = lectura.datos;
  if (!(await limitarPor(env, "reset-ip", ipDe(request), 20, 3600))) return error("demasiados_intentos", "Hiciste muchos intentos. Probá de nuevo en un rato.", 429);

  const u0 = typeof token === "string" ? await env.DB.prepare("SELECT u.email FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.id_hash = ?").bind(await sha256(token)).first() : null;
  const fallo = validarPassword(password, u0?.email || "");
  if (fallo) return error("password_invalida", fallo);

  const fila = await consumirToken(env, token, "reset");
  if (!fila) return error("enlace_invalido", "El enlace no sirve o ya venció. Pedí uno nuevo.", 400);

  // Entrar por el enlace del mail demuestra que el mail es de la persona: queda verificado. Si la cuenta
  // no estaba verificada, la creó alguien que no había probado ser dueño del mail: se cierran todas sus
  // sesiones, se anulan los enlaces de verificación viejos y lo que haya aceptado en nombre de ese mail.
  const antes = await env.DB.prepare("SELECT email_verified, marketing_consent FROM users WHERE id = ?").bind(fila.user_id).first();
  const sentencias = [
    env.DB.prepare("UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?").bind(await hashPassword(password), fila.user_id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(fila.user_id),
    env.DB.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND kind = 'verify'").bind(fila.user_id),
  ];
  if (antes && !antes.email_verified && antes.marketing_consent) sentencias.push(...anularConsentimiento(env, fila.user_id, "reclamo_reset"));
  await env.DB.batch(sentencias);
  return json({ ok: true, mensaje: "Listo, ya podés ingresar con tu contraseña nueva." });
}

export async function verificarMail(request, env) {
  const lectura = await leerJson(request);
  if (!lectura.ok) return lectura.respuesta;
  const fila = await consumirToken(env, lectura.datos.token, "verify");
  if (!fila) return error("enlace_invalido", "El enlace no sirve o ya venció. Pedí uno nuevo desde tu cuenta.", 400);
  await env.DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").bind(fila.user_id).run();
  return json({ ok: true, mensaje: "Mail confirmado. ¡Gracias!" });
}

export async function reenviarVerificacion(request, env, ctx) {
  const u = await usuarioActual(env, request);
  if (!u) return error("sin_sesion", "Ingresá a tu cuenta.", 401);
  if (u.email_verified) return json({ ok: true, mensaje: "Tu mail ya está confirmado." });
  if (!(await limitar(env, `verif:${u.id}`, 3, 3600))) return error("demasiados_intentos", "Ya te mandamos varios enlaces. Probá más tarde.", 429);
  await enviarVerificacion(env, ctx, request, u);
  return json({ ok: true, mensaje: "Te mandamos un enlace de confirmación." });
}

export async function cambiarPassword(request, env) {
  const u = await usuarioActual(env, request);
  if (!u) return error("sin_sesion", "Ingresá a tu cuenta.", 401);
  const lectura = await leerJson(request);
  if (!lectura.ok) return lectura.respuesta;
  const { actual, nueva } = lectura.datos;
  if (!u.password_hash) return error("sin_password", "Tu cuenta entra con Google. Para tener una contraseña, usá «Olvidé mi contraseña».", 400);
  if (!(await limitar(env, `cambio:${u.id}`, 10, 900))) return error("demasiados_intentos", "Probá de nuevo en unos minutos.", 429);
  if (!(await verificarPassword(String(actual || ""), u.password_hash))) return error("credenciales", "La contraseña actual no es correcta.", 401);
  const fallo = validarPassword(nueva, u.email);
  if (fallo) return error("password_invalida", fallo);

  const valorActual = leerCookies(request)[COOKIE_SESION];
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(nueva), u.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?").bind(u.id, await sha256(valorActual)), // cierra las demás sesiones
  ]);
  return json({ ok: true, mensaje: "Contraseña actualizada." });
}

// "Continuar con Google" cuando ya hay una cuenta con ese mail y sin Google vinculado:
//
//  - Cuenta SIN verificar: la creó alguien que nunca demostró ser dueño del mail (pudo ser un tercero).
//    Quien llega con Google SÍ lo demostró, así que reclama la cuenta: se borra la contraseña, se cierran
//    todas las sesiones, se anulan los enlaces pendientes y el consentimiento de novedades que hubiera.
//    El registrante no conserva ninguna credencial. Los pedidos quedan en la cuenta.
//  - Cuenta VERIFICADA: se vincula, pero la contraseña existente solo se conserva si quien llega prueba
//    que la tiene (ya está dentro de esa cuenta, o manda la contraseña en la misma petición). Sin esa
//    prueba la contraseña se descarta, porque no hay forma de saber si es del dueño del mail o de quien
//    registró la cuenta y después hizo clic en el enlace de verificación. Se cierran las demás sesiones
//    y se avisa por mail. Para volver a tener contraseña: «Olvidé mi contraseña».
//  - Una cuenta que ya tiene OTRO Google vinculado nunca se pisa.
export async function google(request, env, ctx) {
  const lectura = await leerJson(request);
  if (!lectura.ok) return lectura.respuesta;
  if (!(await limitarPor(env, "google", ipDe(request), 30, 900))) return error("demasiados_intentos", "Probá de nuevo en unos minutos.", 429);

  let g;
  try {
    g = await verificarTokenGoogle(lectura.datos.credencial, env.GOOGLE_CLIENT_ID, env);
  } catch (e) {
    console.error("Google rechazado:", e.message);
    const sinConfigurar = e.message === "google_sin_configurar";
    const noDisponible = Boolean(e.transitorio) || e.message === "claves de Google no disponibles";
    return error("google_invalido", sinConfigurar ? "El ingreso con Google todavía no está disponible." : noDisponible ? "Google no responde en este momento. Probá de nuevo en unos minutos." : "No pudimos verificar tu cuenta de Google. Probá de nuevo.", sinConfigurar || noDisponible ? 503 : 401);
  }

  let u = await env.DB.prepare("SELECT * FROM users WHERE google_sub = ?").bind(g.sub).first();
  if (!u) {
    const porMail = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(g.email).first();
    if (porMail) {
      if (porMail.google_sub) return error("google_otra_cuenta", "Ese mail ya está vinculado a otra cuenta de Google.", 409);
      const nombre = limpiarTexto(g.name, 80) || porMail.name;
      if (!porMail.email_verified) {
        const sentencias = [
          env.DB.prepare("UPDATE users SET google_sub = ?, email_verified = 1, password_hash = NULL, name = ? WHERE id = ? AND email_verified = 0").bind(g.sub, nombre, porMail.id),
          env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(porMail.id),
          env.DB.prepare("DELETE FROM auth_tokens WHERE user_id = ?").bind(porMail.id),
        ];
        if (porMail.marketing_consent) sentencias.push(...anularConsentimiento(env, porMail.id, "reclamo_google"));
        await env.DB.batch(sentencias);
      } else {
        const actual = await usuarioActual(env, request);
        const sesionPropia = Boolean(actual) && actual.id === porMail.id;
        const claveOk = !sesionPropia && typeof lectura.datos.password === "string" && porMail.password_hash
          ? await verificarPassword(lectura.datos.password.slice(0, 200), porMail.password_hash)
          : false;
        const conservaClave = Boolean(porMail.password_hash) && (sesionPropia || claveOk);
        const valorActual = sesionPropia ? leerCookies(request)[COOKIE_SESION] : null;
        await env.DB.batch([
          conservaClave
            ? env.DB.prepare("UPDATE users SET google_sub = ? WHERE id = ?").bind(g.sub, porMail.id)
            : env.DB.prepare("UPDATE users SET google_sub = ?, password_hash = NULL WHERE id = ?").bind(g.sub, porMail.id),
          valorActual
            ? env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?").bind(porMail.id, await sha256(valorActual))
            : env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(porMail.id),
        ]);
        await enviarSinFallar(env, ctx, { to: porMail.email, ...mailGoogleVinculado(!conservaClave && Boolean(porMail.password_hash), `${urlSitio(env, request)}/cuenta.html`) });
      }
      u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(porMail.id).first();
    } else {
      const id = uuid();
      await env.DB.prepare("INSERT INTO users (id, email, name, google_sub, email_verified, unsubscribe_token, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .bind(id, g.email, limpiarTexto(g.name, 80) || g.email.split("@")[0], g.sub, tokenAleatorio(24), ahora()).run();
      if (lectura.datos.novedades === true) await registrarConsentimiento(env, id, "granted", "google");
      u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
    }
  }
  return iniciarSesion(env, request, u, { usuario: usuarioPublico(env, u) });
}
