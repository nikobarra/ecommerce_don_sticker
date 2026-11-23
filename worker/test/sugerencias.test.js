// Sugerencias de diseños: solo con cuenta, mail verificado y novedades activas; se mandan por mail y NO se guardan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crearEntorno, cliente, registrar, mailsEnviados } from "./helpers.js";

const IDEA = "Un sticker de un carpincho tomando mate con la bandera de Argentina.";

async function conCuenta(env, { mail = "cliente@ejemplo.com", novedades = true, verificado = true } = {}) {
  const c = cliente(env);
  await registrar(c, mail, { novedades });
  if (verificado) env.DB.db.prepare("UPDATE users SET email_verified = 1 WHERE email = ?").run(mail);
  return c;
}

test("sin sesión no se puede sugerir", async () => {
  const env = crearEntorno();
  const r = await cliente(env).post("/api/sugerencias", { idea: IDEA });
  assert.equal(r.status, 401);
  assert.equal(r.datos.error, "sin_sesion");
});

test("hay que tener el mail verificado", async () => {
  const env = crearEntorno();
  const c = await conCuenta(env, { verificado: false });
  const antes = mailsEnviados(env).length;
  const r = await c.post("/api/sugerencias", { idea: IDEA });
  assert.equal(r.status, 403);
  assert.equal(r.datos.error, "mail_sin_verificar");
  assert.equal(mailsEnviados(env).length, antes);
});

test("hay que estar suscripto a las novedades", async () => {
  const env = crearEntorno();
  const c = await conCuenta(env, { novedades: false });
  const r = await c.post("/api/sugerencias", { idea: IDEA });
  assert.equal(r.status, 403);
  assert.equal(r.datos.error, "sin_novedades");
  // Al activar las novedades ya puede enviar.
  await c.patch("/api/cuenta", { novedades: true });
  assert.equal((await c.post("/api/sugerencias", { idea: IDEA })).status, 201);
});

test("la sugerencia le llega por mail al dueño y no se guarda en la base", async () => {
  const env = crearEntorno();
  const c = await conCuenta(env);
  const r = await c.post("/api/sugerencias", { idea: IDEA, referencia: "foto en Pinterest" });
  assert.equal(r.status, 201);
  const mail = mailsEnviados(env).find((m) => m.subject === "Sugerencia de diseño en Don Sticker");
  assert.ok(mail, "debe haber un mail de sugerencia");
  assert.equal(mail.to_addr, "dueno@ejemplo.com");
  assert.match(mail.body, /carpincho tomando mate/);
  assert.match(mail.body, /cliente@ejemplo\.com/);
  assert.match(mail.body, /foto en Pinterest/);
  // Ninguna tabla propia guarda el texto: solo el registro de mails de pruebas (en producción se manda por Resend).
  const tablas = env.DB.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  assert.ok(!tablas.some((n) => /sugerenc|suggest/i.test(n)));
  for (const t of tablas.filter((n) => n !== "mail_log" && !n.startsWith("sqlite_"))) {
    const filas = JSON.stringify(env.DB.db.prepare(`SELECT * FROM ${t}`).all());
    assert.ok(!filas.includes("carpincho"), `la tabla ${t} no debe guardar la sugerencia`);
  }
});

test("en producción sale por Resend con el mail de la persona para poder responderle", async () => {
  const env = crearEntorno({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_prueba", MAIL_FROM: "Don Sticker <avisos@mail.donsticker.test>" });
  const c = await conCuenta(env);
  let enviado = null;
  globalThis.fetch = async (url, op) => { enviado = { url: String(url), cuerpo: JSON.parse(op.body) }; return Response.json({ id: "abc" }); };
  const r = await c.post("/api/sugerencias", { idea: IDEA });
  assert.equal(r.status, 201);
  assert.equal(enviado.url, "https://api.resend.com/emails");
  assert.deepEqual(enviado.cuerpo.to, ["dueno@ejemplo.com"]);
  assert.equal(enviado.cuerpo.reply_to, "cliente@ejemplo.com");
  assert.match(enviado.cuerpo.html, /carpincho/);
});

test("el texto se escapa en el mail para que nadie meta HTML", async () => {
  const env = crearEntorno({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_prueba", MAIL_FROM: "x@mail.donsticker.test" });
  const c = await conCuenta(env);
  let html = "";
  globalThis.fetch = async (_u, op) => { html = JSON.parse(op.body).html; return Response.json({ id: "abc" }); };
  await c.post("/api/sugerencias", { idea: "Un diseño <script>alert(1)</script> con perro" });
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("si el mail no sale, se avisa (no queda copia en ningún lado)", async () => {
  const env = crearEntorno({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_prueba", MAIL_FROM: "x@mail.donsticker.test" });
  const c = await conCuenta(env);
  globalThis.fetch = async () => new Response("caído", { status: 400 });
  const r = await c.post("/api/sugerencias", { idea: IDEA });
  assert.equal(r.status, 502);
  assert.equal(r.datos.error, "no_enviada");
});

test("la idea no puede ser muy corta y hay un máximo de sugerencias por día", async () => {
  const env = crearEntorno();
  const c = await conCuenta(env);
  assert.equal((await c.post("/api/sugerencias", { idea: "perro" })).datos.error, "idea_corta");
  for (let i = 0; i < 3; i++) assert.equal((await c.post("/api/sugerencias", { idea: IDEA + " " + i })).status, 201);
  const r = await c.post("/api/sugerencias", { idea: IDEA });
  assert.equal(r.status, 429);
  assert.equal(r.datos.error, "demasiadas_sugerencias");
});
