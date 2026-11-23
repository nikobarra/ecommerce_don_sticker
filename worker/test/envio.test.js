// Pruebas de la cotización con MiCorreo, con respuestas SIMULADAS del Correo (no usan claves reales).
import { test } from "node:test";
import assert from "node:assert/strict";
import { crearEntorno, cliente, vaciarCache } from "./helpers.js";

const CLAVES = { MICORREO_USER: "usuario", MICORREO_PASSWORD: "clave", MICORREO_CUSTOMER_ID: "0000550137", MICORREO_AMBIENTE: "produccion" };

function simularCorreo({ tarifas = [{ deliveredType: "D", productName: "Paq.ar Clásico", price: 6000.4 }], estadoRates = 200, vencerPrimerToken = false } = {}) {
  const llamadas = { token: 0, rates: 0, cuerpos: [], autorizaciones: [] };
  globalThis.fetch = async (url, opts = {}) => {
    if (url.endsWith("/token")) {
      llamadas.token++;
      llamadas.autorizaciones.push(opts.headers.Authorization);
      return Response.json({ token: `jwt-${llamadas.token}` });
    }
    if (url.endsWith("/rates")) {
      llamadas.rates++;
      llamadas.cuerpos.push(JSON.parse(opts.body));
      if (vencerPrimerToken && llamadas.rates === 1) return new Response("vencido", { status: 401 });
      return estadoRates === 200 ? Response.json({ customerId: "x", rates: tarifas }) : new Response("falla", { status: estadoRates });
    }
    throw new Error("URL inesperada " + url);
  };
  return llamadas;
}

const pedir = (cp, gramos, extra = {}) => cliente(crearEntornoCon(extra)).get(`/api/envio?cp=${cp}&gramos=${gramos}`);
const crearEntornoCon = (extra) => crearEntorno({ ...CLAVES, ...extra });

test("cotiza y redondea el precio del Correo", async () => {
  vaciarCache();
  const llamadas = simularCorreo();
  const r = await pedir("1704", 120);
  assert.equal(r.status, 200);
  assert.deepEqual(r.datos, { precio: 6000, producto: "Paq.ar Clásico", definitivo: true });
  assert.equal(llamadas.cuerpos[0].customerId, "0000550137");
  assert.equal(llamadas.cuerpos[0].postalCodeOrigin, "7620");
  assert.equal(llamadas.cuerpos[0].postalCodeDestination, "1704");
  assert.equal(llamadas.cuerpos[0].deliveredType, "D");
  assert.equal(llamadas.cuerpos[0].dimensions.weight, 200); // 120 g se agrupan en 200 g
  assert.match(llamadas.autorizaciones[0], /^Basic /);
});

test("elige la tarifa más barata y aplica el recargo", async () => {
  vaciarCache();
  simularCorreo({ tarifas: [{ productName: "Urgente", price: 9000 }, { productName: "Clásico", price: 5000 }] });
  const r = await pedir("5800", 300, { RECARGO_PORCENTAJE: "10" });
  assert.deepEqual(r.datos, { precio: 5500, producto: "Clásico", definitivo: true });
});

test("la segunda consulta igual sale de la caché", async () => {
  vaciarCache();
  const llamadas = simularCorreo();
  await pedir("2000", 500);
  await pedir("2000", 500);
  assert.equal(llamadas.rates, 1);
});

test("si el token venció, lo renueva y reintenta una vez", async () => {
  vaciarCache();
  const llamadas = simularCorreo({ vencerPrimerToken: true });
  const r = await pedir("3000", 100);
  assert.equal(r.status, 200);
  assert.equal(llamadas.rates, 2);
});

test("rechaza código postal y peso inválidos sin llamar al Correo", async () => {
  vaciarCache();
  const llamadas = simularCorreo();
  assert.equal((await pedir("12", 100)).status, 400);
  assert.equal((await pedir("1704", 0)).status, 400);
  assert.equal((await pedir("1704", 30000)).status, 400);
  assert.equal((await pedir("1704", "abc")).status, 400);
  assert.equal(llamadas.token + llamadas.rates, 0);
});

test("sin claves configuradas responde 503", async () => {
  vaciarCache();
  simularCorreo();
  const r = await cliente(crearEntorno()).get("/api/envio?cp=1704&gramos=100");
  assert.equal(r.status, 503);
});

test("si el Correo falla responde 502 y no filtra datos internos", async () => {
  vaciarCache();
  simularCorreo({ estadoRates: 500 });
  const r = await pedir("1704", 100);
  assert.equal(r.status, 502);
  assert.deepEqual(r.datos, { error: "no_disponible" });
  assert.ok(!r.texto.includes("clave") && !r.texto.includes("usuario"));
});

test("las demás rutas siguen sirviendo la web y /api desconocida da 404", async () => {
  const env = crearEntorno();
  const web = await (await import("../src/index.js")).default.fetch(new Request("https://donsticker.test/"), env, { waitUntil() {} });
  assert.equal(await web.text(), "web");
  assert.equal((await cliente(env).get("/api/otra")).status, 404);
});

test("la configuración pública no incluye secretos", async () => {
  const env = crearEntorno({ ...CLAVES });
  const r = await cliente(env).get("/api/config");
  assert.deepEqual(Object.keys(r.datos).sort(), ["analitica", "googleClientId", "mercadoPago", "textoConsentimiento", "versionConsentimiento"]);
  assert.ok(!r.texto.includes("clave"));
});
