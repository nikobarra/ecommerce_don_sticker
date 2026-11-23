// Pruebas de "Continuar con Google" con tokens firmados de verdad con una clave de prueba.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { crearEntorno, cliente, registrar, mailsEnviados, tokenDelUltimoMail, PASSWORD_OK } from "./helpers.js";
import { olvidarClavesDeGoogle } from "../src/google.js";

const CLIENT_ID = "cliente-de-prueba.apps.googleusercontent.com";
const b64url = (data) => Buffer.from(data).toString("base64url");

let par, parAjeno, jwkPublica;

before(async () => {
  const generar = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  par = await generar();
  parAjeno = await generar();
  jwkPublica = { ...(await crypto.subtle.exportKey("jwk", par.publicKey)), kid: "clave-1", alg: "RS256", use: "sig" };
});

beforeEach(() => {
  // Falsifica solo la descarga de las claves públicas de Google.
  globalThis.fetch = async (url) => {
    if (String(url).includes("googleapis.com/oauth2/v3/certs")) return Response.json({ keys: [jwkPublica] });
    throw new Error("URL inesperada " + url);
  };
});

async function firmar(carga, { clave = par.privateKey, kid = "clave-1", alg = "RS256" } = {}) {
  const cabecera = b64url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const cuerpo = b64url(JSON.stringify(carga));
  const firma = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", clave, new TextEncoder().encode(`${cabecera}.${cuerpo}`));
  return `${cabecera}.${cuerpo}.${b64url(Buffer.from(firma))}`;
}

const cargaValida = (extra = {}) => ({
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  sub: "1234567890",
  email: "persona@gmail.com",
  email_verified: true,
  name: "Persona Google",
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...extra,
});

test("un token válido crea la cuenta ya verificada y vuelve a ingresar con el mismo usuario", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  const r = await c.post("/api/auth/google", { credencial: await firmar(cargaValida()) });
  assert.equal(r.status, 200);
  assert.equal(r.datos.usuario.email, "persona@gmail.com");
  assert.equal(r.datos.usuario.mailVerificado, true);
  assert.equal(r.datos.usuario.tieneGoogle, true);
  assert.equal(r.datos.usuario.tienePassword, false);
  assert.equal(r.datos.usuario.novedades, false); // sin marcar no hay consentimiento

  const otraVez = cliente(env);
  await otraVez.post("/api/auth/google", { credencial: await firmar(cargaValida()) });
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1);
});

test("si marcó la casilla de novedades al entrar con Google, queda registrado", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await c.post("/api/auth/google", { credencial: await firmar(cargaValida()), novedades: true });
  assert.equal((await c.get("/api/auth/yo")).datos.usuario.novedades, true);
  assert.equal(env.DB.db.prepare("SELECT channel FROM consent_events").get().channel, "google");
});

// ---------- Toma anticipada de cuenta (auditoría 16/11/2026) ----------
// Escenario: A registra el mail de B con la contraseña de A (queda SIN verificar y con sesión abierta).
// Después B, el dueño real del mail, entra con Google.

const CONTRASENA_DE_A = "contrasena-del-atacante-1";
const rutaAdmin = "/api/admin/resumen";

test("REGRESIÓN: el dueño real reclama la cuenta; el registrante pierde contraseña y sesión", async () => {
  const env = crearEntorno();
  const a = cliente(env);
  await registrar(a, "persona@gmail.com", { password: CONTRASENA_DE_A });
  assert.ok((await a.get("/api/auth/yo")).datos.usuario, "A tiene sesión antes de que B llegue");

  const b = cliente(env);
  const r = await b.post("/api/auth/google", { credencial: await firmar(cargaValida()) });
  assert.equal(r.status, 200);
  assert.equal(r.datos.usuario.mailVerificado, true);
  assert.equal(r.datos.usuario.tieneGoogle, true);
  assert.equal(r.datos.usuario.tienePassword, false, "la contraseña del registrante no sobrevive");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1);

  // La sesión de A murió y su contraseña ya no sirve.
  assert.equal((await a.get("/api/auth/yo")).datos.usuario, null);
  assert.equal((await cliente(env).post("/api/auth/ingreso", { email: "persona@gmail.com", password: CONTRASENA_DE_A })).status, 401);
  // B, en cambio, sí está adentro.
  assert.equal((await b.get("/api/auth/yo")).datos.usuario.email, "persona@gmail.com");
});

test("REGRESIÓN: el consentimiento de novedades que dio el registrante no vale para el dueño real", async () => {
  const env = crearEntorno();
  await registrar(cliente(env), "persona@gmail.com", { novedades: true });
  assert.equal(env.DB.db.prepare("SELECT marketing_consent FROM users").get().marketing_consent, 1);
  await cliente(env).post("/api/auth/google", { credencial: await firmar(cargaValida()) });
  assert.equal(env.DB.db.prepare("SELECT marketing_consent FROM users").get().marketing_consent, 0);
  const evento = env.DB.db.prepare("SELECT action, channel FROM consent_events ORDER BY id DESC").get();
  assert.equal(evento.action, "revoked");
  assert.equal(evento.channel, "reclamo_google");
});

test("REGRESIÓN: A no hereda permisos de administrador cuando el dueño entra con Google", async () => {
  const env = crearEntorno(); // ADMIN_EMAILS = dueno@ejemplo.com
  const a = cliente(env);
  await registrar(a, "dueno@ejemplo.com", { password: CONTRASENA_DE_A });
  assert.equal((await a.get(rutaAdmin)).status, 403, "sin verificar no es administrador");

  const dueno = cliente(env);
  const r = await dueno.post("/api/auth/google", { credencial: await firmar(cargaValida({ email: "dueno@ejemplo.com", sub: "sub-dueno" })) });
  assert.equal(r.datos.usuario.admin, true);

  // La sesión que A tenía de antes NO sirve: murió con el reclamo, y la contraseña tampoco.
  assert.equal((await a.get(rutaAdmin)).status, 401);
  assert.equal((await cliente(env).post("/api/auth/ingreso", { email: "dueno@ejemplo.com", password: CONTRASENA_DE_A })).status, 401);
  assert.equal((await dueno.get(rutaAdmin)).status, 200);
});

test("REGRESIÓN: confirmar el mail por el enlace NO convierte en administrador a quien creó la cuenta con contraseña", async () => {
  const env = crearEntorno();
  const a = cliente(env);
  await registrar(a, "dueno@ejemplo.com", { password: CONTRASENA_DE_A });
  // El dueño recibe el mail de confirmación de un registro que no hizo y, por descuido, hace clic.
  const token = tokenDelUltimoMail(env, "dueno@ejemplo.com");
  assert.ok(token);
  assert.equal((await cliente(env).post("/api/auth/verificar", { token })).status, 200);
  assert.equal(env.DB.db.prepare("SELECT email_verified FROM users").get().email_verified, 1);
  // El mail quedó verificado, pero sin Google vinculado la cuenta nunca es administradora.
  assert.equal((await a.get("/api/auth/yo")).datos.usuario.admin, false);
  assert.equal((await a.get(rutaAdmin)).status, 403);
});

test("REGRESIÓN: si después el dueño entra con Google, la contraseña de A tampoco sobrevive", async () => {
  const env = crearEntorno();
  const a = cliente(env);
  await registrar(a, "dueno@ejemplo.com", { password: CONTRASENA_DE_A });
  await cliente(env).post("/api/auth/verificar", { token: tokenDelUltimoMail(env, "dueno@ejemplo.com") }); // cuenta ya verificada
  const dueno = cliente(env);
  const r = await dueno.post("/api/auth/google", { credencial: await firmar(cargaValida({ email: "dueno@ejemplo.com", sub: "sub-dueno" })) });
  assert.equal(r.datos.usuario.admin, true);
  assert.equal(r.datos.usuario.tienePassword, false, "sin prueba de que la contraseña es suya, se descarta");
  assert.equal((await a.get(rutaAdmin)).status, 401, "la sesión vieja de A murió");
  assert.equal((await cliente(env).post("/api/auth/ingreso", { email: "dueno@ejemplo.com", password: CONTRASENA_DE_A })).status, 401);
  assert.ok(mailsEnviados(env).some((m) => m.subject.includes("Vinculamos tu cuenta de Google")), "se avisa por mail");
});

test("cuenta verificada: si quien llega ya está dentro de ella, conserva su contraseña y su sesión", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "persona@gmail.com");
  await cliente(env).post("/api/auth/verificar", { token: tokenDelUltimoMail(env, "persona@gmail.com") });
  const otraSesion = cliente(env);
  await otraSesion.post("/api/auth/ingreso", { email: "persona@gmail.com", password: PASSWORD_OK });

  const r = await c.post("/api/auth/google", { credencial: await firmar(cargaValida()) }); // c ya tiene sesión propia
  assert.equal(r.datos.usuario.tienePassword, true);
  assert.equal(r.datos.usuario.tieneGoogle, true);
  assert.equal((await c.get("/api/auth/yo")).datos.usuario.email, "persona@gmail.com");
  assert.equal((await otraSesion.get("/api/auth/yo")).datos.usuario, null, "las demás sesiones se cierran");
  assert.equal((await cliente(env).post("/api/auth/ingreso", { email: "persona@gmail.com", password: PASSWORD_OK })).status, 200);
});

test("cuenta verificada: mandar la contraseña correcta junto con Google también la conserva", async () => {
  const env = crearEntorno();
  await registrar(cliente(env), "persona@gmail.com");
  await cliente(env).post("/api/auth/verificar", { token: tokenDelUltimoMail(env, "persona@gmail.com") });
  const sinProbar = await cliente(env).post("/api/auth/google", { credencial: await firmar(cargaValida()), password: "otra-contrasena-que-no-es" });
  assert.equal(sinProbar.datos.usuario.tienePassword, false, "una contraseña equivocada no prueba nada");

  const env2 = crearEntorno();
  await registrar(cliente(env2), "persona@gmail.com");
  await cliente(env2).post("/api/auth/verificar", { token: tokenDelUltimoMail(env2, "persona@gmail.com") });
  const conPrueba = await cliente(env2).post("/api/auth/google", { credencial: await firmar(cargaValida()), password: PASSWORD_OK });
  assert.equal(conPrueba.datos.usuario.tienePassword, true);
});

test("una cuenta que ya tiene otro Google vinculado no se pisa", async () => {
  const env = crearEntorno();
  await cliente(env).post("/api/auth/google", { credencial: await firmar(cargaValida({ sub: "primer-google" })) });
  const r = await cliente(env).post("/api/auth/google", { credencial: await firmar(cargaValida({ sub: "otro-google-distinto" })) });
  assert.equal(r.status, 409);
  assert.equal(r.datos.error, "google_otra_cuenta");
  assert.equal(env.DB.db.prepare("SELECT google_sub FROM users").get().google_sub, "primer-google");
});

test("recuperar la contraseña de una cuenta sin verificar cierra las sesiones y anula el consentimiento ajeno", async () => {
  const env = crearEntorno();
  const a = cliente(env);
  await registrar(a, "persona@gmail.com", { password: CONTRASENA_DE_A, novedades: true });
  await cliente(env).post("/api/auth/olvide", { email: "persona@gmail.com" });
  const token = tokenDelUltimoMail(env, "persona@gmail.com");
  const r = await cliente(env).post("/api/auth/restablecer", { token, password: "la-clave-nueva-del-dueno-9" });
  assert.equal(r.status, 200);
  assert.equal((await a.get("/api/auth/yo")).datos.usuario, null, "la sesión de A murió");
  assert.equal((await cliente(env).post("/api/auth/ingreso", { email: "persona@gmail.com", password: CONTRASENA_DE_A })).status, 401);
  assert.equal((await cliente(env).post("/api/auth/ingreso", { email: "persona@gmail.com", password: "la-clave-nueva-del-dueno-9" })).status, 200);
  assert.equal(env.DB.db.prepare("SELECT marketing_consent FROM users").get().marketing_consent, 0);
});

test("cada ingreso crea una sesión nueva y cierra la anterior del mismo navegador", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "persona@gmail.com");
  const antes = c.cookie();
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 1);
  await c.post("/api/auth/ingreso", { email: "persona@gmail.com", password: PASSWORD_OK });
  assert.notEqual(c.cookie(), antes);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 1, "la anterior se cerró");
  const viejo = cliente(env);
  viejo.ponerCookie(antes);
  assert.equal((await viejo.get("/api/auth/yo")).datos.usuario, null);
});

test("la sesión del administrador dura 7 días y la de un cliente 30", async () => {
  const env = crearEntorno();
  const cliente1 = cliente(env);
  await registrar(cliente1, "cliente@ejemplo.com");
  const dueno = cliente(env);
  await dueno.post("/api/auth/google", { credencial: await firmar(cargaValida({ email: "dueno@ejemplo.com", sub: "sub-dueno" })) });
  const dias = (mail) => {
    const f = env.DB.db.prepare("SELECT s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?").get(mail);
    return Math.round((f.expires_at - Date.now()) / 86400000);
  };
  assert.equal(dias("cliente@ejemplo.com"), 30);
  assert.equal(dias("dueno@ejemplo.com"), 7);
});

test("la cookie de sesión es Secure salvo que el entorno local lo declare", async () => {
  const produccion = crearEntorno();
  const r1 = await registrar(cliente(produccion), "uno@ejemplo.com");
  assert.match(r1.res.headers.get("set-cookie"), /; Secure/);
  assert.match(r1.res.headers.get("set-cookie"), /HttpOnly/);
  const local = crearEntorno({ ENTORNO: "local" });
  const r2 = await registrar(cliente(local), "dos@ejemplo.com");
  assert.doesNotMatch(r2.res.headers.get("set-cookie"), /Secure/);
});

test("si Google no responde, ingresar da un error reintentable (503), no uno de credenciales", async () => {
  olvidarClavesDeGoogle();
  globalThis.fetch = async () => { throw new Error("sin red"); };
  const env = crearEntorno();
  const r = await cliente(env).post("/api/auth/google", { credencial: await firmar(cargaValida()) });
  assert.equal(r.status, 503);
});

test("si Google se cuelga, el pedido se corta por plazo en vez de esperar sin fin", async () => {
  olvidarClavesDeGoogle();
  globalThis.fetch = (_url, opciones) => new Promise((_, rechazar) => opciones.signal.addEventListener("abort", () => rechazar(opciones.signal.reason)));
  const env = crearEntorno({ TIMEOUT_EXTERNO_MS: "50" });
  const inicio = Date.now();
  const r = await cliente(env).post("/api/auth/google", { credencial: await firmar(cargaValida()) });
  assert.equal(r.status, 503);
  assert.ok(Date.now() - inicio < 2000);
});

test("rechaza tokens con firma ajena, otro destinatario, vencidos o con mail sin verificar", async () => {
  const env = crearEntorno();
  const casos = {
    "firma de otra clave": await firmar(cargaValida(), { clave: parAjeno.privateKey }),
    "otro destinatario": await firmar(cargaValida({ aud: "otro-cliente.apps.googleusercontent.com" })),
    "token vencido": await firmar(cargaValida({ exp: Math.floor(Date.now() / 1000) - 10 })),
    "emisor falso": await firmar(cargaValida({ iss: "https://evil.example" })),
    "mail sin verificar": await firmar(cargaValida({ email_verified: false })),
    "algoritmo none": `${b64url(JSON.stringify({ alg: "none", kid: "clave-1" }))}.${b64url(JSON.stringify(cargaValida()))}.`,
    "clave desconocida": await firmar(cargaValida(), { kid: "clave-que-no-existe" }),
    "basura": "esto.no.es-un-token",
  };
  for (const [nombre, credencial] of Object.entries(casos)) {
    const r = await cliente(env).post("/api/auth/google", { credencial });
    assert.equal(r.status, 401, nombre);
    assert.equal(r.datos.error, "google_invalido", nombre);
  }
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
});

test("sin ID de cliente configurado responde que no está disponible", async () => {
  const env = crearEntorno({ GOOGLE_CLIENT_ID: "" });
  const r = await cliente(env).post("/api/auth/google", { credencial: await firmar(cargaValida()) });
  assert.equal(r.status, 503);
});
