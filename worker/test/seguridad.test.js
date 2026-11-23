// Pruebas de seguridad de borde: https, dominio canónico, cabeceras, origen, métodos, límites de cuerpo,
// límite de intentos, limpieza de vencidos y pedidos idempotentes.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { crearEntorno, cliente, registrar, mailsEnviados, vaciarCache, entrarComoDueno } from "./helpers.js";
import { leerJson, limitar, limpiarVencidos } from "../src/util.js";
import { origenPermitido } from "../src/seguridad.js";

const ctx = { waitUntil: (p) => p };

// Pedido «crudo»: permite sacar el Origin o poner cualquier cabecera, cosa que el cliente de prueba no deja.
async function crudo(env, metodo, url, { cabeceras = {}, cuerpo } = {}) {
  const init = { method: metodo, headers: { ...cabeceras } };
  if (cuerpo !== undefined) { init.body = JSON.stringify(cuerpo); init.headers["content-type"] = "application/json"; }
  const res = await worker.fetch(new Request(url, init), env, ctx);
  const texto = await res.text();
  let datos = null;
  try { datos = JSON.parse(texto); } catch { /* no era JSON */ }
  return { status: res.status, headers: res.headers, texto, datos };
}

const PROD = { SITE_URL: "https://donsticker.com.ar" };

// ---------- HTTPS ----------

test("http en una lectura se redirige (308) a https conservando ruta y consulta", async () => {
  const env = crearEntorno(PROD);
  const r = await crudo(env, "GET", "http://donsticker.com.ar/api/config?x=1&y=a%20b");
  assert.equal(r.status, 308);
  assert.equal(r.headers.get("location"), "https://donsticker.com.ar/api/config?x=1&y=a%20b");
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("http en /baja también se redirige y conserva el token", async () => {
  const env = crearEntorno(PROD);
  const r = await crudo(env, "GET", "http://donsticker.com.ar/baja?t=abc123");
  assert.equal(r.status, 308);
  assert.equal(r.headers.get("location"), "https://donsticker.com.ar/baja?t=abc123");
});

test("http con un puerto raro no arrastra el puerto a https", async () => {
  const env = crearEntorno(PROD);
  const r = await crudo(env, "GET", "http://donsticker.com.ar:8080/api/config");
  assert.equal(r.headers.get("location"), "https://donsticker.com.ar/api/config");
});

test("un POST por http se RECHAZA sin procesarlo: no se lee el cuerpo ni se toca la base", async () => {
  const env = crearEntorno(PROD);
  const r = await crudo(env, "POST", "http://donsticker.com.ar/api/auth/ingreso", { cuerpo: { email: "a@b.co", password: "x" }, cabeceras: { origin: "http://donsticker.com.ar" } });
  assert.equal(r.status, 403);
  assert.equal(r.datos.error, "https_requerido");
  assert.ok(!r.headers.get("set-cookie"), "no emite cookie por http");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM rate_limits").get().n, 0, "ni siquiera cuenta el intento: no llegó a la lógica");
});

test("la API productiva no emite cookies sin Secure ni siquiera si la petición dice http", async () => {
  const env = crearEntorno(PROD);
  await registrar(cliente(env, "https://donsticker.com.ar"), "x@ejemplo.com");
  const r = await registrar(cliente(env, "https://donsticker.com.ar"), "y@ejemplo.com");
  assert.match(r.res.headers.get("set-cookie"), /; Secure/);
  const http = await crudo(env, "POST", "http://donsticker.com.ar/api/auth/registro", { cuerpo: { email: "z@ejemplo.com", password: "una-clave-larga-123", nombre: "Zeta" }, cabeceras: { origin: "http://donsticker.com.ar" } });
  assert.equal(http.status, 403);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'z@ejemplo.com'").get().n, 0);
});

test("el entorno local, declarado de forma explícita, sigue andando por http", async () => {
  const env = crearEntorno({ ENTORNO: "local" });
  const r = await crudo(env, "GET", "http://127.0.0.1:8787/api/config");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("strict-transport-security"), null, "HSTS no se manda en local");
  const c = cliente(env, "http://127.0.0.1:8787");
  assert.equal((await registrar(c, "local@ejemplo.com")).status, 201);
});

// ---------- Dominio canónico ----------

test("www se redirige al dominio canónico; las escrituras en www se rechazan", async () => {
  const env = crearEntorno(PROD);
  const lectura = await crudo(env, "GET", "https://www.donsticker.com.ar/api/config?a=1");
  assert.equal(lectura.status, 308);
  assert.equal(lectura.headers.get("location"), "https://donsticker.com.ar/api/config?a=1");
  const escritura = await crudo(env, "POST", "https://www.donsticker.com.ar/api/auth/ingreso", { cuerpo: {}, cabeceras: { origin: "https://www.donsticker.com.ar" } });
  assert.equal(escritura.status, 403);
  assert.equal(escritura.datos.error, "dominio_incorrecto");
});

test("http://www se resuelve en un solo salto a https del dominio canónico", async () => {
  const env = crearEntorno(PROD);
  const r = await crudo(env, "GET", "http://www.donsticker.com.ar/baja?t=zz");
  assert.equal(r.headers.get("location"), "https://donsticker.com.ar/baja?t=zz");
});

test("sin SITE_URL no se inventa ningún dominio canónico", async () => {
  const env = crearEntorno();
  const r = await crudo(env, "GET", "https://www.cualquiera.test/api/config");
  assert.equal(r.status, 200);
});

// ---------- Cabeceras de las respuestas dinámicas ----------

test("las respuestas de la API llevan HSTS (sin includeSubDomains ni preload) y las cabeceras de seguridad", async () => {
  const env = crearEntorno(PROD);
  const r = await crudo(env, "GET", "https://donsticker.com.ar/api/config");
  const h = r.headers;
  assert.equal(h.get("strict-transport-security"), "max-age=15552000");
  assert.doesNotMatch(h.get("strict-transport-security"), /includeSubDomains|preload/i);
  assert.equal(h.get("x-content-type-options"), "nosniff");
  assert.equal(h.get("x-frame-options"), "DENY");
  assert.match(h.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(h.get("content-security-policy"), /default-src 'none'/);
  assert.equal(h.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(h.get("permissions-policy"), /camera=\(\)/);
  assert.equal(h.get("cache-control"), "no-store");
});

test("también las respuestas de ERROR llevan las cabeceras (401, 403, 404, 405, 413, 500)", async () => {
  const env = crearEntorno(PROD);
  const casos = [
    crudo(env, "GET", "https://donsticker.com.ar/api/admin/pedidos"), // 401
    crudo(env, "POST", "https://donsticker.com.ar/api/auth/ingreso", { cuerpo: {}, cabeceras: { origin: "https://otro.example" } }), // 403
    crudo(env, "GET", "https://donsticker.com.ar/api/no-existe"), // 404
    crudo(env, "PUT", "https://donsticker.com.ar/api/config"), // 405
  ];
  for (const r of await Promise.all(casos)) {
    assert.ok([401, 403, 404, 405].includes(r.status), `estado ${r.status}`);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", `estado ${r.status}`);
    assert.equal(r.headers.get("x-frame-options"), "DENY", `estado ${r.status}`);
    assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/, `estado ${r.status}`);
    assert.ok(r.headers.get("strict-transport-security"), `estado ${r.status}`);
  }
  const roto = crearEntorno(PROD);
  roto.DB = { prepare() { throw new Error("la base se rompió"); }, batch() { throw new Error("la base se rompió"); } };
  const r500 = await crudo(roto, "GET", "https://donsticker.com.ar/api/auth/yo", { cabeceras: { cookie: "ds_sesion=algo" } });
  assert.equal(r500.status, 500);
  assert.equal(r500.headers.get("x-frame-options"), "DENY");
  assert.doesNotMatch(r500.texto, /se rompió/, "no se filtra el motivo");
});

test("/baja es HTML: solo se le permite su propio <style> y no se puede embeber", async () => {
  const env = crearEntorno(PROD);
  const r = await crudo(env, "GET", "https://donsticker.com.ar/baja?t=token-que-no-existe");
  assert.match(r.headers.get("content-type"), /text\/html/);
  const csp = r.headers.get("content-security-policy");
  assert.match(csp, /style-src 'unsafe-inline'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /script-src/);
  assert.equal(r.headers.get("x-robots-tag"), "noindex");
  assert.ok(!r.texto.includes("<script"), "la página de baja no usa scripts");
});

test("las cabeceras que la respuesta ya traía no se pisan", async () => {
  const env = crearEntorno(PROD);
  const r = await crudo(env, "GET", "https://donsticker.com.ar/baja?t=x");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer"); // la fija /baja y tiene que sobrevivir
});

// ---------- Origen y métodos ----------

const URL_API = "https://donsticker.com.ar/api/auth/ingreso";
const CUERPO = { email: "nadie@ejemplo.com", password: "una-clave-larga-123" };

test("el origen se compara completo: esquema, host y puerto", async () => {
  const env = crearEntorno(PROD);
  const intento = (origen) => crudo(env, "POST", URL_API, { cuerpo: CUERPO, cabeceras: { origin: origen } });
  assert.equal((await intento("https://donsticker.com.ar")).status, 401, "el propio sitio pasa (y falla recién en las credenciales)");
  for (const malo of ["http://donsticker.com.ar", "https://donsticker.com.ar:8443", "https://www.donsticker.com.ar", "https://sub.donsticker.com.ar", "https://donsticker.com.ar.evil.example", "https://evil.example", "null"]) {
    const r = await intento(malo);
    assert.equal(r.status, 403, malo);
    assert.equal(r.datos.error, "origen_invalido", malo);
  }
});

test("sin Origin se mira Sec-Fetch-Site; sin ninguno de los dos, se rechaza lo que usa la sesión", async () => {
  const env = crearEntorno(PROD);
  const con = (cabeceras) => crudo(env, "POST", URL_API, { cuerpo: CUERPO, cabeceras });
  assert.equal((await con({ "sec-fetch-site": "same-origin" })).status, 401);
  assert.equal((await con({ "sec-fetch-site": "none" })).status, 401);
  assert.equal((await con({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await con({ "sec-fetch-site": "same-site" })).status, 403);
  const sinNada = await con({});
  assert.equal(sinNada.status, 403);
  assert.equal(sinNada.datos.error, "origen_invalido");
});

test("las lecturas (GET/HEAD) no exigen origen", async () => {
  const env = crearEntorno(PROD);
  assert.equal((await crudo(env, "GET", "https://donsticker.com.ar/api/config", { cabeceras: { origin: "https://evil.example" } })).status, 200);
});

test("el contador de visitas acepta enviar sin origen (sendBeacon), pero no desde otro sitio", async () => {
  const env = crearEntorno(PROD);
  assert.equal((await crudo(env, "POST", "https://donsticker.com.ar/api/visita", { cuerpo: { ruta: "/", nueva: true } })).status, 204);
  assert.equal((await crudo(env, "POST", "https://donsticker.com.ar/api/visita", { cuerpo: { ruta: "/" }, cabeceras: { origin: "https://evil.example" } })).status, 403);
});

test("el aviso de Mercado Pago (servidor a servidor, sin Origin) no lo bloquea la regla de origen", async () => {
  const env = crearEntorno({ ...PROD, MP_ACCESS_TOKEN: "t", MP_WEBHOOK_SECRET: "s" });
  const r = await crudo(env, "POST", "https://donsticker.com.ar/api/pagos/mercadopago", { cuerpo: { type: "payment", data: { id: "1" } } });
  assert.equal(r.status, 401, "llega hasta la firma, que es lo que lo protege");
});

test("la baja de mails con un clic (POST sin Origin) sigue funcionando", async () => {
  const env = crearEntorno(PROD);
  const c = cliente(env, "https://donsticker.com.ar");
  await registrar(c, "baja@ejemplo.com", { novedades: true });
  const token = env.DB.db.prepare("SELECT unsubscribe_token AS t FROM users").get().t;
  const r = await crudo(env, "POST", `https://donsticker.com.ar/baja?t=${token}`);
  assert.equal(r.status, 200);
  assert.equal(env.DB.db.prepare("SELECT marketing_consent FROM users").get().marketing_consent, 0);
});

test("solo se aceptan los métodos que usa la API; el resto da 405 con Allow", async () => {
  const env = crearEntorno(PROD);
  for (const m of ["PUT", "OPTIONS", "TRACE", "CONNECT"]) {
    if (m === "TRACE" || m === "CONNECT") continue; // el runtime de fetch no los permite
    const r = await crudo(env, m, "https://donsticker.com.ar/api/config", { cabeceras: { origin: "https://donsticker.com.ar" } });
    assert.equal(r.status, 405, m);
    assert.match(r.headers.get("allow"), /GET/, m);
  }
});

test("origenPermitido es una función pura y simple de razonar", () => {
  const pedido = (metodo, url, cab = {}) => new Request(url, { method: metodo, headers: cab });
  assert.equal(origenPermitido(pedido("GET", "https://a.test/api/x"), "/api/x"), true);
  assert.equal(origenPermitido(pedido("POST", "https://a.test/api/x", { origin: "https://a.test" }), "/api/x"), true);
  assert.equal(origenPermitido(pedido("POST", "https://a.test/api/x", { origin: "http://a.test" }), "/api/x"), false);
  assert.equal(origenPermitido(pedido("DELETE", "https://a.test/api/x"), "/api/x"), false);
});

// ---------- Límite de cuerpo en BYTES ----------

const pedidoJson = (texto) => new Request("https://a.test/api/x", { method: "POST", headers: { "content-type": "application/json" }, body: texto });

test("el límite es en bytes: 15.000 caracteres «ñ» son 30.000 bytes y se rechazan con 413", async () => {
  const cuerpo = JSON.stringify({ t: "ñ".repeat(15000) });
  assert.ok(cuerpo.length < 20000 && new TextEncoder().encode(cuerpo).length > 20000);
  const r = await leerJson(pedidoJson(cuerpo), 20000);
  assert.equal(r.ok, false);
  assert.equal(r.respuesta.status, 413);
});

test("con emojis (4 bytes por carácter) el límite también se respeta", async () => {
  const r = await leerJson(pedidoJson(JSON.stringify({ t: "🙂".repeat(6000) })), 20000);
  assert.equal(r.respuesta.status, 413);
});

test("un cuerpo justo dentro del límite pasa, y uno apenas fuera no", async () => {
  const base = JSON.stringify({ t: "" });
  const relleno = (n) => JSON.stringify({ t: "a".repeat(n) });
  const justo = relleno(100 - base.length);
  assert.equal(new TextEncoder().encode(justo).length, 100);
  assert.equal((await leerJson(pedidoJson(justo), 100)).ok, true);
  assert.equal((await leerJson(pedidoJson(relleno(101 - base.length)), 100)).respuesta.status, 413);
});

test("un cuerpo enorme que llega de a pedazos se corta apenas pasa el límite, sin leerlo entero", async () => {
  let pedazos = 0;
  const flujo = new ReadableStream({
    pull(c) { pedazos++; c.enqueue(new TextEncoder().encode("a".repeat(10000))); if (pedazos > 1000) c.close(); },
  });
  const r = await leerJson(new Request("https://a.test/x", { method: "POST", headers: { "content-type": "application/json" }, body: flujo, duplex: "half" }), 20000);
  assert.equal(r.respuesta.status, 413);
  assert.ok(pedazos < 20, `se leyeron ${pedazos} pedazos de 1000: se cortó a tiempo`);
});

test("si Content-Length ya declara más del límite, se rechaza sin leer nada", async () => {
  const req = new Request("https://a.test/x", { method: "POST", headers: { "content-type": "application/json", "content-length": "999999" }, body: "{}" });
  assert.equal((await leerJson(req, 20000)).respuesta.status, 413);
});

test("tipo incorrecto y JSON roto siguen dando 415 y 400", async () => {
  assert.equal((await leerJson(new Request("https://a.test/x", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }))).respuesta.status, 415);
  assert.equal((await leerJson(pedidoJson("{roto"))).respuesta.status, 400);
  assert.equal((await leerJson(pedidoJson("[1,2]"))).respuesta.status, 400);
  assert.deepEqual((await leerJson(pedidoJson(""))).datos, {});
});

test("el límite se aplica de punta a punta: un registro gigante recibe 413 por HTTP", async () => {
  const env = crearEntorno(PROD);
  const r = await crudo(env, "POST", "https://donsticker.com.ar/api/auth/registro", { cuerpo: { email: "a@b.co", password: "x", nombre: "ñ".repeat(15000) }, cabeceras: { origin: "https://donsticker.com.ar" } });
  assert.equal(r.status, 413);
});

// ---------- Límite de intentos atómico ----------

test("50 intentos SIMULTÁNEOS con un límite de 10 dejan pasar exactamente 10", async () => {
  const env = crearEntorno();
  const resultados = await Promise.all(Array.from({ length: 50 }, () => limitar(env, "prueba:carrera", 10, 60)));
  assert.equal(resultados.filter(Boolean).length, 10);
  assert.equal(env.DB.db.prepare("SELECT count FROM rate_limits WHERE key = 'prueba:carrera'").get().count, 50);
});

test("el límite se respeta de a uno y se bloquea en el intento 11", async () => {
  const env = crearEntorno();
  const salida = [];
  for (let i = 0; i < 12; i++) salida.push(await limitar(env, "k", 10, 60));
  assert.deepEqual(salida, [...Array(10).fill(true), false, false]);
});

test("al vencer la ventana el contador arranca de nuevo", async () => {
  const env = crearEntorno();
  for (let i = 0; i < 11; i++) await limitar(env, "k", 10, 60);
  assert.equal(await limitar(env, "k", 10, 60), false);
  env.DB.db.prepare("UPDATE rate_limits SET window_start = ? WHERE key = 'k'").run(Date.now() - 61000);
  assert.equal(await limitar(env, "k", 10, 60), true);
  assert.equal(env.DB.db.prepare("SELECT count FROM rate_limits WHERE key = 'k'").get().count, 1);
});

test("las claves distintas no se pisan entre sí", async () => {
  const env = crearEntorno();
  for (let i = 0; i < 5; i++) await limitar(env, "a", 3, 60);
  assert.equal(await limitar(env, "a", 3, 60), false);
  assert.equal(await limitar(env, "b", 3, 60), true);
});

// ---------- Limpieza ----------

test("la limpieza borra lo vencido y NO toca pedidos, historial, consentimientos ni mails", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "viva@ejemplo.com", { novedades: true });
  const pedido = (await c.post("/api/pedidos", { items: [{ id: "pack-10-01", cantidad: 1 }], entrega: "Balcarce", nombre: "Viva" })).datos.pedido;
  const db = env.DB.db;
  const ahora = Date.now();
  const DIA = 86400000;
  db.prepare("INSERT INTO sessions (id_hash, user_id, expires_at, created_at) SELECT 'vieja', id, ?, 'x' FROM users").run(ahora - 1000);
  db.prepare("INSERT INTO auth_tokens (id_hash, user_id, kind, expires_at) SELECT 'tok-vencido', id, 'reset', ? FROM users").run(ahora - 1000);
  db.prepare("INSERT INTO auth_tokens (id_hash, user_id, kind, expires_at, used_at) SELECT 'tok-usado-viejo', id, 'reset', ?, ? FROM users").run(ahora + DIA, ahora - 8 * DIA);
  db.prepare("INSERT INTO auth_tokens (id_hash, user_id, kind, expires_at, used_at) SELECT 'tok-usado-reciente', id, 'reset', ?, ? FROM users").run(ahora + DIA, ahora - DIA);
  db.prepare("INSERT INTO rate_limits (key, count, window_start) VALUES ('viejo', 1, ?), ('reciente', 1, ?)").run(ahora - 3 * DIA, ahora - 1000);
  const antes = { pedidos: db.prepare("SELECT COUNT(*) AS n FROM orders").get().n, eventos: db.prepare("SELECT COUNT(*) AS n FROM order_events").get().n, consent: db.prepare("SELECT COUNT(*) AS n FROM consent_events").get().n, mails: mailsEnviados(env).length };

  await limpiarVencidos(env);

  const existe = (tabla, col, v) => db.prepare(`SELECT COUNT(*) AS n FROM ${tabla} WHERE ${col} = ?`).get(v).n === 1;
  assert.equal(existe("sessions", "id_hash", "vieja"), false);
  assert.equal(existe("auth_tokens", "id_hash", "tok-vencido"), false);
  assert.equal(existe("auth_tokens", "id_hash", "tok-usado-viejo"), false);
  assert.equal(existe("auth_tokens", "id_hash", "tok-usado-reciente"), true);
  assert.equal(existe("rate_limits", "key", "viejo"), false);
  assert.equal(existe("rate_limits", "key", "reciente"), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?").get(ahora).n, 1, "la sesión vigente sigue");
  assert.deepEqual({ pedidos: db.prepare("SELECT COUNT(*) AS n FROM orders").get().n, eventos: db.prepare("SELECT COUNT(*) AS n FROM order_events").get().n, consent: db.prepare("SELECT COUNT(*) AS n FROM consent_events").get().n, mails: mailsEnviados(env).length }, antes);
  assert.ok(pedido.id);
});

test("el cron (scheduled) limpia y no revienta aunque Mercado Pago no esté configurado", async () => {
  const env = crearEntorno();
  env.DB.db.prepare("INSERT INTO rate_limits (key, count, window_start) VALUES ('viejo', 1, ?)").run(Date.now() - 5 * 86400000);
  const pendientes = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pendientes.push(p) });
  await Promise.all(pendientes);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key = 'viejo'").get().n, 0);
});

// ---------- Pedidos idempotentes y dirección ----------

const CLAVE = "clave-del-pedido-0123456789";
const itemsPack = [{ id: "pack-10-01", cantidad: 1 }];
const pedidoCon = (extra = {}) => ({ items: itemsPack, entrega: "Balcarce", nombre: "Cliente", ...extra });

test("reintentar el mismo pedido con la misma clave devuelve el que ya existe: no hay pedido doble ni mail doble", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "idem@ejemplo.com");
  const uno = await c.post("/api/pedidos", pedidoCon({ claveIdempotencia: CLAVE }));
  const dos = await c.post("/api/pedidos", pedidoCon({ claveIdempotencia: CLAVE }));
  assert.equal(uno.status, 201);
  assert.equal(dos.status, 200);
  assert.equal(dos.datos.repetido, true);
  assert.equal(dos.datos.pedido.id, uno.datos.pedido.id);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n, 1);
  assert.equal(mailsEnviados(env).filter((m) => m.subject.includes("Recibí tu pedido")).length, 1);
});

test("la clave también puede viajar en la cabecera Idempotency-Key", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "idem@ejemplo.com");
  await c.post("/api/pedidos", pedidoCon(), { cabeceras: { "idempotency-key": CLAVE } });
  const dos = await c.post("/api/pedidos", pedidoCon(), { cabeceras: { "idempotency-key": CLAVE } });
  assert.equal(dos.datos.repetido, true);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n, 1);
});

test("cuatro pedidos iguales SIMULTÁNEOS con la misma clave crean uno solo", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "idem@ejemplo.com");
  const rs = await Promise.all(Array.from({ length: 4 }, () => c.post("/api/pedidos", pedidoCon({ claveIdempotencia: CLAVE }))));
  assert.ok(rs.every((r) => r.status === 200 || r.status === 201));
  assert.equal(new Set(rs.map((r) => r.datos.pedido.id)).size, 1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n, 1);
});

test("la misma clave con otro contenido es un error, no se pisa el pedido", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "idem@ejemplo.com");
  await c.post("/api/pedidos", pedidoCon({ claveIdempotencia: CLAVE }));
  const otro = await c.post("/api/pedidos", pedidoCon({ claveIdempotencia: CLAVE, items: [{ id: "pack-25-01", cantidad: 1 }] }));
  assert.equal(otro.status, 409);
  assert.equal(otro.datos.error, "clave_reutilizada");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n, 1);
});

test("una clave mal formada se rechaza; sin clave todo sigue como antes", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "idem@ejemplo.com");
  assert.equal((await c.post("/api/pedidos", pedidoCon({ claveIdempotencia: "corta" }))).datos.error, "clave_invalida");
  assert.equal((await c.post("/api/pedidos", pedidoCon())).status, 201);
  assert.equal((await c.post("/api/pedidos", pedidoCon())).status, 201);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n, 2);
});

test("la clave es por cliente: otro cliente con la misma clave hace su propio pedido", async () => {
  const env = crearEntorno();
  const a = cliente(env); const b = cliente(env);
  await registrar(a, "a@ejemplo.com"); await registrar(b, "b@ejemplo.com");
  const ra = await a.post("/api/pedidos", pedidoCon({ claveIdempotencia: CLAVE }));
  const rb = await b.post("/api/pedidos", pedidoCon({ claveIdempotencia: CLAVE }));
  assert.equal(ra.status, 201);
  assert.equal(rb.status, 201);
  assert.notEqual(ra.datos.pedido.id, rb.datos.pedido.id);
});

test("los reintentos de un pedido ya creado no consumen el límite de pedidos por hora", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "idem@ejemplo.com");
  await c.post("/api/pedidos", pedidoCon({ claveIdempotencia: CLAVE }));
  for (let i = 0; i < 15; i++) assert.equal((await c.post("/api/pedidos", pedidoCon({ claveIdempotencia: CLAVE }))).status, 200);
});

const ENVIO = { entrega: "envio", provincia: "Buenos Aires", cp: "7600" };

test("la dirección se guarda separada: calle y localidad", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "dir@ejemplo.com");
  const r = await c.post("/api/pedidos", pedidoCon({ ...ENVIO, calle: "Calle 21 N° 700", localidad: "Balcarce" }));
  assert.equal(r.status, 201);
  assert.equal(r.datos.pedido.calle, "Calle 21 N° 700");
  assert.equal(r.datos.pedido.localidad, "Balcarce");
  const f = env.DB.db.prepare("SELECT street, locality FROM orders").get();
  assert.equal(f.street, "Calle 21 N° 700");
  assert.equal(f.locality, "Balcarce");
});

test("con el formulario nuevo la calle y la localidad son obligatorias por separado", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "dir@ejemplo.com");
  assert.equal((await c.post("/api/pedidos", pedidoCon({ ...ENVIO, calle: "", localidad: "Balcarce" }))).datos.error, "calle_invalida");
  assert.equal((await c.post("/api/pedidos", pedidoCon({ ...ENVIO, calle: "Calle 21 700", localidad: "" }))).datos.error, "localidad_invalida");
});

test("compatibilidad: la versión anterior del formulario (todo junto en «localidad») sigue funcionando", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "dir@ejemplo.com");
  const r = await c.post("/api/pedidos", pedidoCon({ ...ENVIO, localidad: "Balcarce, Calle 21 700" }));
  assert.equal(r.status, 201);
  assert.equal(r.datos.pedido.calle, null);
  assert.equal(r.datos.pedido.localidad, "Balcarce, Calle 21 700");
  assert.equal((await c.post("/api/pedidos", pedidoCon({ ...ENVIO, localidad: "ab" }))).datos.error, "direccion_invalida");
});

test("el mail al dueño muestra calle y localidad juntas", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "dir@ejemplo.com");
  await c.post("/api/pedidos", pedidoCon({ ...ENVIO, calle: "Calle 21 N° 700", localidad: "Balcarce" }));
  const aviso = mailsEnviados(env).find((m) => m.subject.startsWith("Pedido nuevo"));
  assert.match(aviso.body, /Calle 21 N° 700, Balcarce, CP 7600/);
});

// ---------- Atribución de campañas ----------

test("la atribución se guarda saneada: solo claves permitidas, con largo y caracteres acotados", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "utm@ejemplo.com");
  await c.post("/api/pedidos", pedidoCon({ atribucion: {
    utm_source: "google", utm_medium: "cpc", utm_campaign: "reventa-2026", gclid: "Cj0KCQ-abc_123",
    email: "robado@ejemplo.com", nombre: "Alguien", utm_term: "<script>alert(1)</script>", utm_content: "x".repeat(500),
  } }));
  const guardado = JSON.parse(env.DB.db.prepare("SELECT attribution_json FROM orders").get().attribution_json);
  // utm_term con HTML se descarta; utm_content demasiado largo se recorta a 100; email y nombre ni se miran.
  assert.deepEqual(guardado, { utm_source: "google", utm_medium: "cpc", utm_campaign: "reventa-2026", utm_content: "x".repeat(100), gclid: "Cj0KCQ-abc_123" });
});

test("sin atribución, o con basura, no se guarda nada", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "utm@ejemplo.com");
  await c.post("/api/pedidos", pedidoCon());
  await c.post("/api/pedidos", pedidoCon({ atribucion: "texto" }));
  await c.post("/api/pedidos", pedidoCon({ atribucion: [1, 2] }));
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE attribution_json IS NOT NULL").get().n, 0);
});

// ---------- Eliminar la cuenta ----------

test("eliminar la cuenta anonimiza el pedido por completo y borra los mails guardados de esa dirección", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "adios@ejemplo.com");
  await c.post("/api/pedidos", pedidoCon({ ...ENVIO, calle: "Calle 21 N° 700", localidad: "Balcarce", notas: "timbre roto", claveIdempotencia: CLAVE, atribucion: { gclid: "abc123", utm_source: "google" } }));
  assert.ok(mailsEnviados(env).some((m) => m.to_addr === "adios@ejemplo.com"));
  const r = await c.del("/api/cuenta", { confirmacion: "ELIMINAR" });
  assert.equal(r.status, 200);
  const f = env.DB.db.prepare("SELECT * FROM orders").get();
  assert.equal(f.user_id, null);
  assert.equal(f.customer_name, "(cuenta eliminada)");
  for (const campo of ["street", "locality", "postal_code", "attribution_json", "idempotency_key", "request_fingerprint"]) assert.equal(f[campo], null, campo);
  assert.equal(f.notes, "");
  assert.equal(mailsEnviados(env).filter((m) => m.to_addr === "adios@ejemplo.com").length, 0);
  assert.match(r.res.headers.get("set-cookie"), /Max-Age=0/);
  assert.match(r.res.headers.get("set-cookie"), /; Secure/);
});

// ---------- /api/envio: abuso, concurrencia y plazos ----------

const CORREO = { MICORREO_USER: "u", MICORREO_PASSWORD: "p", MICORREO_CUSTOMER_ID: "1", MICORREO_AMBIENTE: "produccion" };

function correo({ colgado = false } = {}) {
  vaciarCache();
  const llamadas = { rates: 0 };
  globalThis.fetch = async (url, opts = {}) => {
    if (colgado) return new Promise((_, rechazar) => opts.signal.addEventListener("abort", () => rechazar(opts.signal.reason)));
    if (String(url).endsWith("/token")) return Response.json({ token: "jwt" });
    if (String(url).endsWith("/rates")) { llamadas.rates++; await new Promise((r) => setTimeout(r, 15)); return Response.json({ rates: [{ productName: "Paq.ar", price: 5000 }] }); }
    throw new Error("URL inesperada");
  };
  return llamadas;
}

test("/api/envio: consultas iguales y simultáneas hacen UNA sola llamada al Correo", async () => {
  const llamadas = correo();
  const env = crearEntorno(CORREO);
  const rs = await Promise.all(Array.from({ length: 8 }, () => crudo(env, "GET", "https://donsticker.test/api/envio?cp=7600&gramos=120")));
  assert.ok(rs.every((r) => r.status === 200 && r.datos.precio === 5000));
  assert.equal(llamadas.rates, 1);
});

test("/api/envio: el límite por IP cuenta solo las consultas que salen al Correo y da 429", async () => {
  correo();
  const env = crearEntorno(CORREO);
  for (let i = 0; i < 40; i++) assert.equal((await crudo(env, "GET", `https://donsticker.test/api/envio?cp=${1000 + i}&gramos=120`)).status, 200);
  const r = await crudo(env, "GET", "https://donsticker.test/api/envio?cp=2999&gramos=120");
  assert.equal(r.status, 429);
  assert.ok(r.headers.get("retry-after"));
  assert.equal(env.DB.db.prepare("SELECT count FROM rate_limits WHERE key LIKE 'envio:%'").get().count, 41);
});

test("/api/envio: pedir muchas veces lo mismo no gasta intentos (sale de la caché)", async () => {
  const llamadas = correo();
  const env = crearEntorno(CORREO);
  for (let i = 0; i < 60; i++) assert.equal((await crudo(env, "GET", "https://donsticker.test/api/envio?cp=7600&gramos=120")).status, 200);
  assert.equal(llamadas.rates, 1);
  const fila = env.DB.db.prepare("SELECT count FROM rate_limits WHERE key LIKE 'envio:%'").get();
  assert.ok(!fila || fila.count <= 1, "la caché no escribe en la base");
});

test("/api/envio: si el Correo se cuelga, se corta por plazo y responde 502", async () => {
  correo({ colgado: true });
  const env = crearEntorno({ ...CORREO, TIMEOUT_EXTERNO_MS: "50" });
  const inicio = Date.now();
  const r = await crudo(env, "GET", "https://donsticker.test/api/envio?cp=7600&gramos=120");
  assert.equal(r.status, 502);
  assert.ok(Date.now() - inicio < 2000);
});

test("/api/envio: la respuesta dice si el precio es definitivo (producción) o de prueba", async () => {
  correo();
  const prod = await crudo(crearEntorno(CORREO), "GET", "https://donsticker.test/api/envio?cp=7600&gramos=120");
  assert.equal(prod.datos.definitivo, true);
  vaciarCache();
  const prueba = await crudo(crearEntorno({ ...CORREO, MICORREO_AMBIENTE: "prueba" }), "GET", "https://donsticker.test/api/envio?cp=7600&gramos=120");
  assert.equal(prueba.datos.definitivo, false);
  vaciarCache();
  const sinDeclarar = await crudo(crearEntorno({ ...CORREO, MICORREO_AMBIENTE: undefined }), "GET", "https://donsticker.test/api/envio?cp=7600&gramos=120");
  assert.equal(sinDeclarar.datos.definitivo, false, "si no se declara producción, se asume prueba");
});

// ---------- Administrador ----------

test("el panel solo lo abre una cuenta de ADMIN_EMAILS con el mail verificado Y con Google vinculado", async () => {
  const env = crearEntorno();
  const sinGoogle = cliente(env);
  await registrar(sinGoogle, "dueno@ejemplo.com");
  env.DB.db.prepare("UPDATE users SET email_verified = 1").run();
  assert.equal((await sinGoogle.get("/api/admin/resumen")).status, 403, "verificado pero sin Google: no");
  env.DB.db.prepare("UPDATE users SET google_sub = 'g-1'").run();
  assert.equal((await sinGoogle.get("/api/admin/resumen")).status, 200);
  const otro = await entrarComoDueno(crearEntorno({ ADMIN_EMAILS: "otro@ejemplo.com" }));
  assert.equal((await otro.get("/api/admin/resumen")).status, 403, "con Google pero no figura en ADMIN_EMAILS: no");
});

// ---------- Privacidad: la base no guarda IP ni mail en claro por el límite de intentos ----------

test("tras usar la web, ninguna clave de rate_limits contiene la IP ni el mail en claro", async () => {
  const env = crearEntorno();
  const IP = "203.0.113.77";
  const MAIL = "persona.privada@ejemplo.com";
  const c = cliente(env);
  const cab = { cabeceras: { "cf-connecting-ip": IP } };
  await c.post("/api/auth/registro", { email: MAIL, password: "una-clave-larga-123", nombre: "Persona" }, cab);
  await c.post("/api/auth/ingreso", { email: MAIL, password: "equivocada-equivocada" }, cab);
  await c.post("/api/auth/olvide", { email: MAIL }, cab);
  await c.post("/api/visita", { ruta: "/", nueva: true }, cab);
  const claves = env.DB.db.prepare("SELECT key FROM rate_limits").all().map((f) => f.key);
  assert.ok(claves.length >= 4, "se registraron intentos");
  for (const k of claves) {
    assert.ok(!k.includes(IP), `la IP aparece en «${k}»`);
    assert.ok(!k.includes(MAIL) && !k.includes("persona.privada"), `el mail aparece en «${k}»`);
  }
});

test("la huella cambia de un día al siguiente y con el secreto IP_SALT, y es estable dentro del día", async () => {
  const { huella } = await import("../src/util.js");
  const a = await huella({}, "203.0.113.5");
  assert.equal(a, await huella({}, "203.0.113.5"));
  assert.notEqual(a, await huella({}, "203.0.113.6"));
  assert.notEqual(a, await huella({ IP_SALT: "otro-secreto" }, "203.0.113.5"));
  assert.equal(a.length, 32);
  assert.doesNotMatch(a, /203/);
});
