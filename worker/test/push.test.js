// Pruebas de los avisos al celular (Web Push): cifrado (RFC 8291), identificación (VAPID), API y envío al cambiar un pedido.
import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto as wc, createECDH, createDecipheriv, hkdfSync, createVerify } from "node:crypto";
import { cifrarAviso, cabeceraVapid, validarSuscripcion, avisoDePedido, deBase64Url, aBase64Url } from "../src/push.js";
import { crearEntorno, cliente, registrar, entrarComoDueno } from "./helpers.js";

// ---------- Ayudas ----------
// El «dispositivo» de la persona: su par de claves y su secreto de autenticación.
async function dispositivo() {
  const par = await wc.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const jwk = await wc.subtle.exportKey("jwk", par.privateKey);
  const publica = new Uint8Array(await wc.subtle.exportKey("raw", par.publicKey));
  const auth = wc.getRandomValues(new Uint8Array(16));
  return { d: jwk.d, p256dh: aBase64Url(publica), auth: aBase64Url(auth), publica, secretoAuth: auth };
}

// Descifrado hecho del lado del receptor, con node:crypto (independiente del código que se prueba).
function descifrar(cuerpo, disp) {
  const sal = cuerpo.subarray(0, 16);
  const largo = cuerpo[20];
  const publicaServidor = cuerpo.subarray(21, 21 + largo);
  const cifrado = cuerpo.subarray(21 + largo);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(disp.d, "base64url"));
  const compartido = ecdh.computeSecret(publicaServidor);
  const material = Buffer.from(hkdfSync("sha256", compartido, disp.secretoAuth, Buffer.concat([Buffer.from("WebPush: info\0"), disp.publica, publicaServidor]), 32));
  const clave = Buffer.from(hkdfSync("sha256", material, sal, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", material, sal, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", clave, nonce);
  d.setAuthTag(cifrado.subarray(cifrado.length - 16));
  const claro = Buffer.concat([d.update(cifrado.subarray(0, cifrado.length - 16)), d.final()]);
  assert.equal(claro[claro.length - 1], 2, "el último registro termina con 0x02");
  return claro.subarray(0, claro.length - 1).toString("utf8");
}

async function clavesVapid() {
  const par = await wc.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const jwk = await wc.subtle.exportKey("jwk", par.privateKey);
  const publica = new Uint8Array(await wc.subtle.exportKey("raw", par.publicKey));
  return { VAPID_PUBLIC_KEY: aBase64Url(publica), VAPID_PRIVATE_KEY: jwk.d, VAPID_SUBJECT: "mailto:prueba@ejemplo.com" };
}

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";
let envios = [];
const respuestaPush = { status: 201 };
const fetchOriginal = globalThis.fetch;
function simularServicioPush() {
  envios = [];
  respuestaPush.status = 201;
  globalThis.fetch = async (url, op) => {
    if (/googleapis|mozilla|apple|windows/.test(String(url))) {
      envios.push({ url: String(url), cabeceras: op.headers, cuerpo: new Uint8Array(op.body) });
      return new Response(null, { status: respuestaPush.status });
    }
    return fetchOriginal(url, op);
  };
}
const restaurarFetch = () => { globalThis.fetch = fetchOriginal; };
// En producción el envío corre en segundo plano (ctx.waitUntil): acá se espera a que llegue lo esperado.
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperarEnvios(n) {
  for (let i = 0; i < 40 && envios.length < n; i++) await pausa(25);
  await pausa(25); // un margen para detectar envíos de más
  return envios.length;
}
const esperarFilas = async (env, esperadas) => {
  for (let i = 0; i < 40 && env.DB.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get().n !== esperadas; i++) await pausa(25);
};

async function conAvisos(env, mail = "cliente@ejemplo.com") {
  const c = cliente(env);
  await registrar(c, mail);
  const disp = await dispositivo();
  const r = await c.post("/api/push/suscribir", { endpoint: ENDPOINT, keys: { p256dh: disp.p256dh, auth: disp.auth } });
  assert.equal(r.status, 200, JSON.stringify(r.datos));
  return { c, disp };
}
const pedirRetiro = (c) => c.post("/api/pedidos", { items: [{ id: "pack-10-01", cantidad: 1 }], entrega: "Balcarce", nombre: "Cliente Prueba" });

// ---------- Cifrado ----------
test("el cifrado reproduce el vector de prueba del RFC 8291", async () => {
  const d = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
  const pubS = deBase64Url("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  const jwk = { kty: "EC", crv: "P-256", d, x: aBase64Url(pubS.slice(1, 33)), y: aBase64Url(pubS.slice(33, 65)), ext: true };
  const privateKey = await wc.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = await wc.subtle.importKey("raw", pubS, { name: "ECDH", namedCurve: "P-256" }, true, []);
  const cuerpo = await cifrarAviso("When I grow up, I want to be a watermelon",
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "BTBZMqHH6r4Tts7J_aSIgg",
    { par: { privateKey, publicKey }, sal: deBase64Url("DGv6ra1nlYgDCS1FRnbzlw") });
  assert.equal(aBase64Url(cuerpo), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

test("un aviso cifrado solo lo lee el dispositivo destinatario, con tildes y todo", async () => {
  const disp = await dispositivo();
  const otro = await dispositivo();
  const texto = JSON.stringify({ titulo: "Don Sticker", texto: "Pedido DS-ABC234. Salió rumbo a tu casa. Año, ñandú, ¿sí?" });
  const cuerpo = await cifrarAviso(texto, disp.p256dh, disp.auth);
  assert.equal(descifrar(cuerpo, disp), texto);
  assert.throws(() => descifrar(cuerpo, otro));
});

// ---------- VAPID ----------
test("VAPID: el token lleva el origen del servicio, vence en horas y su firma es válida", async () => {
  const claves = await clavesVapid();
  const ahoraSeg = 1_800_000_000;
  const cab = await cabeceraVapid(claves, ENDPOINT, ahoraSeg);
  const m = cab.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  assert.ok(m, cab);
  assert.equal(m[4], claves.VAPID_PUBLIC_KEY);
  const cabeza = JSON.parse(Buffer.from(m[1], "base64url"));
  const reclamos = JSON.parse(Buffer.from(m[2], "base64url"));
  assert.deepEqual(cabeza, { typ: "JWT", alg: "ES256" });
  assert.equal(reclamos.aud, "https://fcm.googleapis.com");
  assert.equal(reclamos.sub, "mailto:prueba@ejemplo.com");
  assert.ok(reclamos.exp > ahoraSeg && reclamos.exp <= ahoraSeg + 24 * 3600);
  // La firma es r||s (64 bytes); se verifica con la clave pública, como lo hace el servicio de push.
  const firma = Buffer.from(m[3], "base64url");
  assert.equal(firma.length, 64);
  const pub = deBase64Url(claves.VAPID_PUBLIC_KEY);
  const clavePublica = await wc.subtle.importKey("raw", pub, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.equal(await wc.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, clavePublica, firma, new TextEncoder().encode(`${m[1]}.${m[2]}`)), true);
});

// ---------- Validación ----------
test("solo se aceptan direcciones de los servicios de push de los navegadores, por https", async () => {
  const d = await dispositivo();
  const ok = (endpoint) => validarSuscripcion({ endpoint, keys: { p256dh: d.p256dh, auth: d.auth } });
  for (const bueno of [ENDPOINT, "https://updates.push.services.mozilla.com/wpush/v2/xyz", "https://web.push.apple.com/QAbc", "https://wns2-par02p.notify.windows.com/w/?token=1"]) assert.ok(ok(bueno), bueno);
  for (const malo of ["http://fcm.googleapis.com/x", "https://ejemplo.com/push", "https://fcm.googleapis.com.malo.com/x", "https://localhost/x", "https://169.254.169.254/latest", "https://usuario:clave@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "no es una url", ""]) {
    assert.equal(ok(malo), null, malo);
  }
  assert.equal(validarSuscripcion({ endpoint: ENDPOINT, keys: { p256dh: "AAAA", auth: d.auth } }), null);
  assert.equal(validarSuscripcion({ endpoint: ENDPOINT, keys: { p256dh: d.p256dh, auth: "AAAA" } }), null);
  assert.equal(validarSuscripcion(null), null);
});

// ---------- Qué se avisa ----------
test("se avisa solo lo importante, con la voz del Don y sin exclamaciones", () => {
  const base = { number: "DS-ABC234", delivery: "envio", tracking_number: "" };
  const t = (p, c) => avisoDePedido({ ...base, ...p }, c)?.texto;
  assert.match(t({ status: "pago_confirmado" }, { cambioEstado: true }), /El pago llegó/);
  assert.match(t({ status: "despachado", tracking_number: "CA1AR" }, { cambioEstado: true }), /rumbo a tu casa\. Seguimiento: CA1AR\./);
  assert.match(t({ status: "despachado", delivery: "Balcarce" }, { cambioEstado: true }), /Coordinamos la entrega en Balcarce/);
  assert.match(t({ status: "entregado" }, { cambioEstado: true }), /Entregado/);
  assert.match(t({ status: "cancelado" }, { cambioEstado: true }), /cancelado/);
  assert.match(t({ status: "despachado", tracking_number: "CA1AR" }, { cambioEstado: false, cambioSeg: true }), /Número de seguimiento: CA1AR/);
  // Sin aviso: pasos intermedios, o un seguimiento cargado antes de despachar.
  assert.equal(t({ status: "preparando" }, { cambioEstado: true }), undefined);
  assert.equal(t({ status: "recibido" }, { cambioEstado: true }), undefined);
  assert.equal(t({ status: "preparando", tracking_number: "CA1AR" }, { cambioEstado: false, cambioSeg: true }), undefined);
  for (const e of ["pago_confirmado", "despachado", "entregado", "cancelado"]) assert.ok(!t({ status: e }, { cambioEstado: true }).includes("!"));
});

// ---------- API ----------
test("sin claves VAPID los avisos están apagados: la web no los ofrece y la API responde 503", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c);
  assert.equal((await c.get("/api/config")).datos.pushClave, "");
  assert.equal((await c.post("/api/push/suscribir", {})).status, 503);
});

test("activar exige sesión y un dispositivo válido; se puede desactivar", async () => {
  const env = crearEntorno(await clavesVapid());
  const anonimo = cliente(env);
  const d = await dispositivo();
  assert.equal((await anonimo.post("/api/push/suscribir", { endpoint: ENDPOINT, keys: { p256dh: d.p256dh, auth: d.auth } })).status, 401);

  const c = cliente(env);
  await registrar(c);
  assert.equal((await c.get("/api/config")).datos.pushClave, env.VAPID_PUBLIC_KEY);
  assert.equal((await c.post("/api/push/suscribir", { endpoint: "https://ejemplo.com/x", keys: { p256dh: d.p256dh, auth: d.auth } })).datos.error, "suscripcion_invalida");
  assert.equal((await c.post("/api/push/suscribir", { endpoint: ENDPOINT, keys: { p256dh: d.p256dh, auth: d.auth } })).status, 200);
  assert.equal((await c.post("/api/push/suscribir", { endpoint: ENDPOINT, keys: { p256dh: d.p256dh, auth: d.auth } })).status, 200, "repetir no duplica");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get().n, 1);
  await c.post("/api/push/baja", { endpoint: ENDPOINT });
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get().n, 0);
});

test("hay un máximo de dispositivos por cuenta", async () => {
  const env = crearEntorno(await clavesVapid());
  const c = cliente(env);
  await registrar(c);
  const d = await dispositivo();
  for (let i = 0; i < 5; i++) assert.equal((await c.post("/api/push/suscribir", { endpoint: `https://fcm.googleapis.com/fcm/send/${i}`, keys: { p256dh: d.p256dh, auth: d.auth } })).status, 200);
  assert.equal((await c.post("/api/push/suscribir", { endpoint: "https://fcm.googleapis.com/fcm/send/6", keys: { p256dh: d.p256dh, auth: d.auth } })).datos.error, "demasiados_dispositivos");
});

test("una persona no puede borrar el dispositivo de otra", async () => {
  const env = crearEntorno(await clavesVapid());
  const { disp } = await conAvisos(env, "ana@ejemplo.com");
  const beto = cliente(env);
  await registrar(beto, "beto@ejemplo.com");
  await beto.post("/api/push/baja", { endpoint: ENDPOINT });
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get().n, 1);
  assert.ok(disp);
});

// ---------- Envío al cambiar un pedido ----------
test("al despachar, el cliente recibe el aviso cifrado en su celular, con el seguimiento", async () => {
  simularServicioPush();
  try {
    const env = crearEntorno(await clavesVapid());
    const { c, disp } = await conAvisos(env);
    const p = (await pedirRetiro(c)).datos.pedido;
    const adm = await entrarComoDueno(env);
    await adm.patch(`/api/admin/pedidos/${p.id}`, { estado: "preparando" });
    assert.equal(await esperarEnvios(0), 0, "«preparando» no avisa");

    await adm.patch(`/api/admin/pedidos/${p.id}`, { estado: "despachado", seguimiento: "CA123456789AR" });
    assert.equal(await esperarEnvios(1), 1);
    const e = envios[0];
    assert.equal(e.url, ENDPOINT);
    assert.equal(e.cabeceras["Content-Encoding"], "aes128gcm");
    assert.match(e.cabeceras.Authorization, /^vapid t=.+, k=.+$/);
    assert.equal(e.cabeceras.Topic, `pedido-${p.numero}`);
    const aviso = JSON.parse(descifrar(e.cuerpo, disp));
    assert.equal(aviso.titulo, "Don Sticker");
    assert.equal(aviso.url, "/cuenta");
    assert.ok(aviso.texto.includes(p.numero));
    assert.match(aviso.texto, /Coordinamos la entrega en Balcarce/);
    for (let i = 0; i < 40 && !env.DB.db.prepare("SELECT last_ok_at FROM push_subscriptions").get().last_ok_at; i++) await pausa(25);
    assert.ok(env.DB.db.prepare("SELECT last_ok_at FROM push_subscriptions").get().last_ok_at, "se anota el último aviso entregado");
  } finally { restaurarFetch(); }
});

test("si el dispositivo ya no existe (410), se borra; y un fallo del servicio no rompe el cambio de estado", async () => {
  simularServicioPush();
  try {
    const env = crearEntorno(await clavesVapid());
    const { c } = await conAvisos(env);
    const p = (await pedirRetiro(c)).datos.pedido;
    const adm = await entrarComoDueno(env);

    respuestaPush.status = 500;
    const r = await adm.patch(`/api/admin/pedidos/${p.id}`, { estado: "pago_confirmado" });
    assert.equal(r.status, 200);
    assert.equal(r.datos.pedido.estado, "pago_confirmado");
    assert.equal(await esperarEnvios(1), 1);
    assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get().n, 1, "un error pasajero no borra al dispositivo");

    respuestaPush.status = 410;
    await adm.patch(`/api/admin/pedidos/${p.id}`, { estado: "entregado" });
    await esperarFilas(env, 0);
    assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get().n, 0);
  } finally { restaurarFetch(); }
});

test("sin dispositivos suscriptos, o con los avisos apagados, no se envía nada", async () => {
  simularServicioPush();
  try {
    const sin = crearEntorno(await clavesVapid());
    const c1 = cliente(sin);
    await registrar(c1);
    const p1 = (await pedirRetiro(c1)).datos.pedido;
    await (await entrarComoDueno(sin)).patch(`/api/admin/pedidos/${p1.id}`, { estado: "pago_confirmado" });

    const apagado = crearEntorno();
    const c2 = cliente(apagado);
    await registrar(c2);
    const p2 = (await pedirRetiro(c2)).datos.pedido;
    await (await entrarComoDueno(apagado)).patch(`/api/admin/pedidos/${p2.id}`, { estado: "pago_confirmado" });
    assert.equal(await esperarEnvios(0), 0);
  } finally { restaurarFetch(); }
});

test("el botón de prueba manda un aviso al celular y tiene límite", async () => {
  simularServicioPush();
  try {
    const env = crearEntorno(await clavesVapid());
    const { c, disp } = await conAvisos(env);
    const r = await c.post("/api/push/prueba");
    assert.deepEqual(r.datos, { enviados: 1, dispositivos: 1 });
    assert.match(JSON.parse(descifrar(envios[0].cuerpo, disp)).texto, /Funciona/);
    for (let i = 0; i < 4; i++) await c.post("/api/push/prueba");
    assert.equal((await c.post("/api/push/prueba")).status, 429);
  } finally { restaurarFetch(); }
});

// ---------- Privacidad ----------
test("al eliminar la cuenta se borran los dispositivos, y «mis datos» los informa", async () => {
  const env = crearEntorno(await clavesVapid());
  const { c } = await conAvisos(env);
  const datos = (await c.get("/api/cuenta/datos")).datos;
  assert.equal(datos.avisosCelular.dispositivos.length, 1);
  assert.ok(!JSON.stringify(datos).includes("fcm.googleapis.com"), "la dirección del dispositivo no se entrega ni se muestra");
  assert.equal((await c.del("/api/cuenta", { confirmacion: "ELIMINAR" })).status, 200);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get().n, 0);
});
