// Pruebas de cuentas: registro, ingreso, recuperación, verificación y consentimiento.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crearEntorno, cliente, registrar, PASSWORD_OK, mailsEnviados, tokenDelUltimoMail } from "./helpers.js";

test("el registro crea la cuenta, inicia sesión y no guarda la contraseña en claro", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  const r = await registrar(c);
  assert.equal(r.status, 201);
  assert.equal(r.datos.usuario.email, "cliente@ejemplo.com");
  assert.equal(r.datos.usuario.mailVerificado, false);
  assert.match(r.res.headers.get("set-cookie"), /HttpOnly/);
  assert.match(r.res.headers.get("set-cookie"), /SameSite=Lax/);

  const yo = await c.get("/api/auth/yo");
  assert.equal(yo.datos.usuario.nombre, "Cliente Prueba");

  const fila = env.DB.db.prepare("SELECT password_hash FROM users").get();
  assert.match(fila.password_hash, /^pbkdf2\$sha256\$100000\$/);
  assert.ok(!fila.password_hash.includes(PASSWORD_OK));
  // La cookie guardada en el navegador no es lo que está en la base (se guarda solo su hash).
  const idSesion = c.cookie().split("=")[1];
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id_hash = ?").get(idSesion).n, 0);
  // Se mandó el mail de verificación.
  assert.match(mailsEnviados(env)[0].subject, /Confirmá tu mail/);
});

test("el registro valida mail, contraseña, nombre y mail repetido", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  assert.equal((await registrar(c, "no-es-mail")).datos.error, "mail_invalido");
  assert.equal((await c.post("/api/auth/registro", { email: "a@b.com", password: "corta", nombre: "Ana" })).datos.error, "password_invalida");
  assert.equal((await c.post("/api/auth/registro", { email: "a@b.com", password: PASSWORD_OK, nombre: "" })).datos.error, "nombre_invalido");
  assert.equal((await registrar(c, "dup@ejemplo.com")).status, 201);
  const otro = cliente(env);
  const dup = await registrar(otro, "DUP@ejemplo.com");
  assert.equal(dup.status, 409);
  assert.equal(dup.datos.error, "mail_existente");
});

test("el ingreso funciona y no delata si el mail existe", async () => {
  const env = crearEntorno();
  await registrar(cliente(env));
  const c = cliente(env);
  const bien = await c.post("/api/auth/ingreso", { email: "cliente@ejemplo.com", password: PASSWORD_OK });
  assert.equal(bien.status, 200);
  const malaClave = await cliente(env).post("/api/auth/ingreso", { email: "cliente@ejemplo.com", password: "otra-clave-larga-1" });
  const sinMail = await cliente(env).post("/api/auth/ingreso", { email: "nadie@ejemplo.com", password: "otra-clave-larga-1" });
  assert.equal(malaClave.status, 401);
  assert.equal(sinMail.status, 401);
  assert.deepEqual(malaClave.datos, sinMail.datos);
});

test("después de varios intentos fallidos se bloquea el ingreso", async () => {
  const env = crearEntorno();
  await registrar(cliente(env));
  const c = cliente(env);
  let ultimo;
  for (let i = 0; i < 10; i++) ultimo = await c.post("/api/auth/ingreso", { email: "cliente@ejemplo.com", password: "mala-clave-larga-1" });
  assert.equal(ultimo.status, 429);
  // Aunque ahora use la clave correcta, sigue bloqueado hasta que pase la ventana.
  assert.equal((await c.post("/api/auth/ingreso", { email: "cliente@ejemplo.com", password: PASSWORD_OK })).status, 429);
});

test("cerrar sesión invalida la sesión", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c);
  const galleta = c.cookie();
  await c.post("/api/auth/salida");
  c.ponerCookie(galleta); // alguien que copió la cookie vieja
  assert.equal((await c.get("/api/auth/yo")).datos.usuario, null);
});

test("recuperar la contraseña: respuesta genérica, enlace de un solo uso y cierre de sesiones", async () => {
  const env = crearEntorno();
  const viejo = cliente(env);
  await registrar(viejo);
  const antes = mailsEnviados(env).length;

  const noExiste = await cliente(env).post("/api/auth/olvide", { email: "nadie@ejemplo.com" });
  assert.equal(noExiste.status, 200);
  assert.equal(mailsEnviados(env).length, antes); // no se mandó nada

  const existe = await cliente(env).post("/api/auth/olvide", { email: "cliente@ejemplo.com" });
  assert.deepEqual(existe.datos, noExiste.datos); // misma respuesta
  const token = tokenDelUltimoMail(env, "cliente@ejemplo.com");
  assert.ok(token);

  const nueva = "clave-nueva-muy-larga-9";
  assert.equal((await cliente(env).post("/api/auth/restablecer", { token, password: "corta" })).datos.error, "password_invalida");
  const ok = await cliente(env).post("/api/auth/restablecer", { token, password: nueva });
  assert.equal(ok.status, 200);
  assert.equal((await cliente(env).post("/api/auth/restablecer", { token, password: nueva })).datos.error, "enlace_invalido"); // un solo uso

  assert.equal((await viejo.get("/api/auth/yo")).datos.usuario, null); // la sesión vieja se cerró
  assert.equal((await cliente(env).post("/api/auth/ingreso", { email: "cliente@ejemplo.com", password: PASSWORD_OK })).status, 401);
  const entra = cliente(env);
  assert.equal((await entra.post("/api/auth/ingreso", { email: "cliente@ejemplo.com", password: nueva })).status, 200);
  assert.equal((await entra.get("/api/auth/yo")).datos.usuario.mailVerificado, true); // el enlace probó que el mail es suyo
});

test("un enlace de recuperación vencido no sirve", async () => {
  const env = crearEntorno();
  await registrar(cliente(env));
  await cliente(env).post("/api/auth/olvide", { email: "cliente@ejemplo.com" });
  const token = tokenDelUltimoMail(env, "cliente@ejemplo.com");
  env.DB.db.prepare("UPDATE auth_tokens SET expires_at = ? WHERE kind = 'reset'").run(Date.now() - 1000);
  assert.equal((await cliente(env).post("/api/auth/restablecer", { token, password: "clave-nueva-muy-larga-9" })).datos.error, "enlace_invalido");
});

test("confirmar el mail con el enlace", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c);
  const token = tokenDelUltimoMail(env, "cliente@ejemplo.com");
  assert.equal((await cliente(env).post("/api/auth/verificar", { token: "inventado-inventado-inventado" })).datos.error, "enlace_invalido");
  assert.equal((await cliente(env).post("/api/auth/verificar", { token })).status, 200);
  assert.equal((await c.get("/api/auth/yo")).datos.usuario.mailVerificado, true);
});

test("cambiar la contraseña pide la actual y cierra las demás sesiones", async () => {
  const env = crearEntorno();
  const a = cliente(env);
  await registrar(a);
  const b = cliente(env);
  await b.post("/api/auth/ingreso", { email: "cliente@ejemplo.com", password: PASSWORD_OK });
  assert.equal((await a.post("/api/auth/password", { actual: "incorrecta-1234", nueva: "clave-nueva-muy-larga-9" })).status, 401);
  assert.equal((await a.post("/api/auth/password", { actual: PASSWORD_OK, nueva: "clave-nueva-muy-larga-9" })).status, 200);
  assert.ok((await a.get("/api/auth/yo")).datos.usuario); // esta sesión sigue
  assert.equal((await b.get("/api/auth/yo")).datos.usuario, null); // la otra se cerró
});

test("rechaza pedidos de escritura que vienen de otro sitio", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  const r = await c.post("/api/auth/registro", { email: "x@ejemplo.com", password: PASSWORD_OK, nombre: "X" }, { cabeceras: { origin: "https://sitio-malicioso.example" } });
  assert.equal(r.status, 403);
});

test("el consentimiento para novedades queda registrado y se puede retirar", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "cliente@ejemplo.com", { novedades: true });
  assert.equal((await c.get("/api/auth/yo")).datos.usuario.novedades, true);
  let eventos = env.DB.db.prepare("SELECT action, channel, text_version FROM consent_events").all();
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].action, "granted");
  assert.equal(eventos[0].channel, "registro");
  assert.ok(eventos[0].text_version);

  const r = await c.patch("/api/cuenta", { novedades: false });
  assert.equal(r.datos.usuario.novedades, false);
  eventos = env.DB.db.prepare("SELECT action, channel FROM consent_events ORDER BY id").all();
  assert.deepEqual(eventos.map((e) => e.action), ["granted", "revoked"]);
});

test("sin marcar la casilla no hay consentimiento", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c);
  assert.equal((await c.get("/api/auth/yo")).datos.usuario.novedades, false);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM consent_events").get().n, 0);
  // "true" como texto no cuenta: tiene que ser un sí explícito.
  const otro = cliente(env);
  await registrar(otro, "otro@ejemplo.com", { novedades: "true" });
  assert.equal((await otro.get("/api/auth/yo")).datos.usuario.novedades, false);
});

test("la baja con el enlace de los mails retira el consentimiento sin iniciar sesión", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "cliente@ejemplo.com", { novedades: true });
  const token = env.DB.db.prepare("SELECT unsubscribe_token FROM users").get().unsubscribe_token;

  const malo = await cliente(env).get("/baja?t=token-que-no-existe");
  assert.match(malo.texto, /no es válido/);
  const pagina = await cliente(env).get(`/baja?t=${token}`);
  assert.match(pagina.texto, /te diste de baja/);
  assert.equal((await c.get("/api/auth/yo")).datos.usuario.novedades, false);
  const eventos = env.DB.db.prepare("SELECT action, channel FROM consent_events ORDER BY id").all();
  assert.deepEqual(eventos.map((e) => `${e.action}:${e.channel}`), ["granted:registro", "revoked:baja"]);
  // Repetir la baja no genera otro registro ni falla.
  assert.equal((await cliente(env).post(`/baja?t=${token}`, {})).status, 200);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM consent_events").get().n, 2);
});

test("el cliente puede descargar sus datos y eliminar su cuenta", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "cliente@ejemplo.com", { novedades: true });
  const datos = await c.get("/api/cuenta/datos");
  assert.equal(datos.datos.cuenta.email, "cliente@ejemplo.com");
  assert.equal(datos.datos.novedades.historial.length, 1);

  assert.equal((await c.del("/api/cuenta", { confirmacion: "no" })).datos.error, "sin_confirmar");
  assert.equal((await c.del("/api/cuenta", { confirmacion: "ELIMINAR" })).status, 200);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM consent_events").get().n, 0);
  assert.equal((await c.get("/api/auth/yo")).datos.usuario, null);
});
