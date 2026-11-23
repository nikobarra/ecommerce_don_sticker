// Mail semanal de novedades: cuándo sale, a quién, por tandas y con tope diario, y las rutas del panel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crearEntorno, cliente, entrarComoDueno, mailsEnviados } from "./helpers.js";
import { crearSemanal, enviarLote, semanaIso } from "../src/novedades.js";

const JUEVES = new Date(Date.UTC(2026, 10, 19, 14, 0)); // jueves 19/11/2026, 11 h de Argentina
const DIA = 86400000;

const diseno = (n, fecha = "2026-11-17") => ({ id: `ds-0${n}`, codigo: `DS-0${n}`, nombre: `Diseño ${n}`, fecha, numero: n });

function entorno(lista, extra = {}) {
  const env = crearEntorno({
    NOVEDADES_ACTIVO: "1",
    SITE_URL: "https://donsticker.test",
    ...extra,
  });
  env.lista = lista;
  env.ASSETS = {
    fetch: async (req) => new URL(req.url).pathname === "/novedades.json"
      ? new Response(JSON.stringify(env.lista), { headers: { "content-type": "application/json" } })
      : new Response("web"),
  };
  return env;
}

function usuario(env, n, { consentimiento = 1, verificado = 1 } = {}) {
  env.DB.db.prepare("INSERT INTO users (id, email, name, email_verified, marketing_consent, unsubscribe_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(`u${n}`, `cliente${n}@ejemplo.com`, `Cliente ${n}`, verificado, consentimiento, `baja-token-${n}-abcdef`, new Date().toISOString());
}

// Mails a suscriptores (sin contar la copia del dueño, que se prueba aparte).
const novedadesEnviadas = (env) => mailsEnviados(env).filter((m) => m.subject.startsWith("Novedades en Don Sticker") && m.to_addr !== "dueno@ejemplo.com");
const copiasDueno = (env) => mailsEnviados(env).filter((m) => m.subject.startsWith("Novedades en Don Sticker") && m.to_addr === "dueno@ejemplo.com");

test("la semana ISO se calcula bien", () => {
  assert.equal(JUEVES.getUTCDay(), 4);
  assert.equal(semanaIso(JUEVES), "2026-W47");
  assert.equal(semanaIso(new Date(Date.UTC(2027, 0, 1))), "2026-W53");
});

test("apagado (NOVEDADES_ACTIVO distinto de 1) no arma ni manda nada", async () => {
  const env = entorno([diseno(989)], { NOVEDADES_ACTIVO: "0" });
  usuario(env, 1);
  assert.equal(await crearSemanal(env, JUEVES), null);
  assert.deepEqual(await enviarLote(env, JUEVES), { enviados: 0 });
  assert.equal(novedadesEnviadas(env).length, 0);
});

test("solo sale el día y desde la hora configurados", async () => {
  const env = entorno([diseno(989)]);
  usuario(env, 1);
  assert.equal(await crearSemanal(env, new Date(Date.UTC(2026, 10, 19, 12, 59))), null, "antes de las 13 UTC");
  assert.equal(await crearSemanal(env, new Date(Date.UTC(2026, 10, 18, 15))), null, "un miércoles");
  const r = await crearSemanal(env, JUEVES);
  assert.equal(r.estado, "enviando");
});

test("solo a quien aceptó novedades y confirmó su mail, con su enlace de baja y los códigos", async () => {
  const env = entorno([diseno(989), diseno(990)]);
  usuario(env, 1);
  usuario(env, 2, { consentimiento: 0 });
  usuario(env, 3, { verificado: 0 });
  const r = await crearSemanal(env, JUEVES);
  assert.equal(r.total, 1);
  assert.equal(r.disenos, 2);
  await enviarLote(env, JUEVES);
  const mails = novedadesEnviadas(env);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to_addr, "cliente1@ejemplo.com");
  assert.equal(mails[0].subject, "Novedades en Don Sticker: 2 diseños nuevos");
  assert.match(mails[0].body, /DS-0990/);
  assert.match(mails[0].body, /https:\/\/donsticker\.test\/baja\?t=baja-token-1-abcdef/);
  assert.match(mails[0].body, /utm_source=novedades/);
});

test("manda por tandas, respeta el tope diario y sigue al día siguiente", async () => {
  const env = entorno([diseno(989)], { NOVEDADES_LOTE: "2", NOVEDADES_TOPE_DIARIO: "3" });
  for (let i = 1; i <= 5; i++) usuario(env, i);
  await crearSemanal(env, JUEVES);
  assert.equal((await enviarLote(env, JUEVES)).enviados, 2);
  assert.equal((await enviarLote(env, JUEVES)).enviados, 1, "llega al tope de 3 por día");
  assert.equal((await enviarLote(env, JUEVES)).tope, true);
  const viernes = new Date(JUEVES.getTime() + DIA);
  assert.equal((await enviarLote(env, viernes)).enviados, 2);
  assert.equal(novedadesEnviadas(env).length, 5);
  const b = env.DB.db.prepare("SELECT estado, enviados, total FROM newsletters").get();
  assert.deepEqual({ ...b }, { estado: "terminado", enviados: 5, total: 5 });
});

test("si alguien se da de baja después de armado el envío, no le llega", async () => {
  const env = entorno([diseno(989)]);
  usuario(env, 1);
  usuario(env, 2);
  await crearSemanal(env, JUEVES);
  await cliente(env).get("/baja?t=baja-token-2-abcdef");
  await enviarLote(env, JUEVES);
  const mails = novedadesEnviadas(env);
  assert.deepEqual(mails.map((m) => m.to_addr), ["cliente1@ejemplo.com"]);
  const estado = env.DB.db.prepare("SELECT estado FROM newsletter_envios WHERE user_id = 'u2'").get().estado;
  assert.equal(estado, "omitido");
});

test("una vez por semana, y la siguiente solo con lo nuevo; sin novedades no sale nada", async () => {
  const env = entorno([diseno(989)]);
  usuario(env, 1);
  await crearSemanal(env, JUEVES);
  assert.equal(await crearSemanal(env, new Date(JUEVES.getTime() + 3600000)), null, "la misma semana no se repite");
  await enviarLote(env, JUEVES);

  const otroJueves = new Date(JUEVES.getTime() + 7 * DIA);
  const sinNada = await crearSemanal(env, otroJueves);
  assert.equal(sinNada.estado, "sin_novedades");
  await enviarLote(env, otroJueves);
  assert.equal(novedadesEnviadas(env).length, 1, "esa semana no sale mail");

  env.lista = [diseno(989), diseno(991, "2026-11-28")];
  const tercero = await crearSemanal(env, new Date(JUEVES.getTime() + 14 * DIA));
  assert.equal(tercero.disenos, 1, "solo el diseño que no se había mandado");
  await enviarLote(env, new Date(JUEVES.getTime() + 14 * DIA));
  const ultimo = novedadesEnviadas(env).at(-1);
  assert.match(ultimo.body, /DS-0991/);
  assert.doesNotMatch(ultimo.body, /DS-0989/);
});

test("el dueño recibe siempre su copia, aunque no esté suscripto, y nunca dos veces", async () => {
  const env = entorno([diseno(989)], { ADMIN_EMAILS: "dueno@ejemplo.com" });
  usuario(env, 1);
  // El dueño tiene cuenta y además está suscripto: igual le llega una sola copia.
  env.DB.db.prepare("INSERT INTO users (id, email, name, email_verified, marketing_consent, unsubscribe_token, created_at) VALUES ('d', 'dueno@ejemplo.com', 'Dueño', 1, 1, 'baja-dueno-abcdef', ?)").run(new Date().toISOString());
  const r = await crearSemanal(env, JUEVES);
  assert.equal(r.total, 1, "el dueño no entra en la lista de suscriptores");
  assert.equal(copiasDueno(env).length, 1, "la copia sale apenas se arma el envío");
  await enviarLote(env, JUEVES);
  await enviarLote(env, JUEVES);
  assert.equal(copiasDueno(env).length, 1, "no se repite");
  assert.equal(novedadesEnviadas(env).length, 1);

  // Sin novedades no hay mail para nadie, tampoco para el dueño.
  await crearSemanal(env, new Date(JUEVES.getTime() + 7 * DIA));
  assert.equal(copiasDueno(env).length, 1);
});

test("la copia del dueño sale aunque no tenga cuenta ni haya suscriptores", async () => {
  const env = entorno([diseno(989)], { ADMIN_EMAILS: "dueno@ejemplo.com" });
  const r = await crearSemanal(env, JUEVES);
  assert.equal(r.total, 0);
  assert.equal(copiasDueno(env).length, 1);
});

test("el panel muestra el estado, la vista previa y manda la prueba solo al dueño", async () => {
  const env = entorno([diseno(989)], { ADMIN_EMAILS: "dueno@ejemplo.com" });
  usuario(env, 1);
  const extrano = cliente(env);
  assert.equal((await extrano.get("/api/admin/novedades")).status, 401);

  const dueno = await entrarComoDueno(env);
  const estado = await dueno.get("/api/admin/novedades");
  assert.equal(estado.status, 200);
  assert.equal(estado.datos.suscriptores, 1);
  assert.equal(estado.datos.disenosPendientes, 1);

  const vista = await dueno.get("/api/admin/novedades/vista-previa");
  assert.equal(vista.status, 200);
  assert.match(vista.texto, /Diseño 989/);
  assert.match(vista.texto, /assets\/mail\/ds-0989\.png/);
  // La vista previa tiene que poder mostrar las imágenes del sitio (y nada de otros orígenes ni scripts).
  const csp = vista.res.headers.get("content-security-policy");
  assert.match(csp, /img-src 'self'/);
  assert.doesNotMatch(csp, /script-src/);

  const prueba = await dueno.post("/api/admin/novedades/prueba", {});
  assert.equal(prueba.status, 200);
  const mail = mailsEnviados(env).at(-1);
  assert.equal(mail.to_addr, "dueno@ejemplo.com");
  assert.match(mail.subject, /^\[Prueba\] Novedades/);
});
