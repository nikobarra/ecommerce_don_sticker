// Pruebas del cobro con Mercado Pago, con respuestas SIMULADAS (no usan claves ni plata reales).
import { test } from "node:test";
import assert from "node:assert/strict";
import { crearEntorno, cliente, registrar, mailsEnviados, entrarComoDueno, vaciarCache } from "./helpers.js";
import { conciliarPendientes, formatoDeToken, sanear } from "../src/pagos.js";

const CLAVES = { MP_ACCESS_TOKEN: "APP_USR-1234567890123456-111111-abcdef0123456789abcdef0123456789-123456789", MP_WEBHOOK_SECRET: "clave-de-firma" };

const entornoPago = (extra = {}) => crearEntorno({ ...CLAVES, ...extra });

async function conCuenta(env, mail = "cliente@ejemplo.com") {
  const c = cliente(env);
  await registrar(c, mail);
  return c;
}

const pedidoRetiro = (items, extra = {}) => ({ items, entrega: "Balcarce", nombre: "Cliente Prueba", ...extra });

// Simula la API de Mercado Pago: crear la preferencia, consultar un pago y buscar pagos de un pedido.
function simularMercadoPago({ pago = {}, busqueda = [], estadoPreferencia = 200, mensajePreferencia = "", estadoPago = 200, colgado = false, redCaida = false } = {}) {
  const llamadas = { preferencias: [], pagos: 0, busquedas: 0 };
  globalThis.fetch = async (url, opts = {}) => {
    if (redCaida) throw new Error("sin red");
    if (colgado) return new Promise((_, rechazar) => opts.signal.addEventListener("abort", () => rechazar(opts.signal.reason)));
    const u = String(url);
    if (u.endsWith("/checkout/preferences")) {
      llamadas.preferencias.push({ cuerpo: JSON.parse(opts.body), headers: opts.headers });
      if (estadoPreferencia !== 200) return Response.json({ message: mensajePreferencia, cause: [] }, { status: estadoPreferencia });
      return Response.json({ id: "pref-123", init_point: "https://mercadopago.com/pagar/pref-123" });
    }
    if (u.includes("/v1/payments/search")) {
      llamadas.busquedas++;
      if (estadoPago !== 200) return new Response("falla", { status: estadoPago });
      return Response.json({ results: busqueda });
    }
    if (u.includes("/v1/payments/")) {
      llamadas.pagos++;
      if (estadoPago !== 200) return new Response("falla", { status: estadoPago });
      return Response.json({ id: 9001, status: "approved", currency_id: "ARS", transaction_amount: 11340, external_reference: "", live_mode: true, ...pago });
    }
    throw new Error("URL inesperada " + u);
  };
  return llamadas;
}

// Firma un aviso igual que lo hace Mercado Pago.
async function firmar(secreto, idPago, idPedido, ts = "1700000000") {
  const clave = await crypto.subtle.importKey("raw", new TextEncoder().encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const manifiesto = `id:${idPago};request-id:${idPedido};ts:${ts};`;
  const firma = await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(manifiesto));
  const hex = [...new Uint8Array(firma)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { "x-signature": `ts=${ts},v1=${hex}`, "x-request-id": idPedido };
}

const avisar = (c, idPago, cabeceras) => c.post("/api/pagos/mercadopago", { type: "payment", data: { id: idPago } }, { cabeceras });
const avisoFirmado = async (c, id = "9001") => avisar(c, id, await firmar(CLAVES.MP_WEBHOOK_SECRET, id, "req-1"));

async function pedidoParaCobrar(env, items = [{ id: "pack-10-01", cantidad: 1 }]) {
  const c = await conCuenta(env);
  const pedido = (await c.post("/api/pedidos", pedidoRetiro(items, { pago: "mercadopago" }))).datos.pedido;
  env.DB.db.prepare("UPDATE orders SET payment_preference_id = 'pref-123' WHERE id = ?").run(pedido.id);
  return { c, pedido };
}

const fila = (env, id) => ({ ...env.DB.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) });
const eventos = (env, id) => env.DB.db.prepare("SELECT status, note FROM order_events WHERE order_id = ? ORDER BY id").all(id).map((e) => ({ ...e }));
const mailsA = (env, destino) => mailsEnviados(env).filter((m) => m.to_addr === destino);

// ---------- Precios según el medio de pago ----------

test("por transferencia se cobran los precios con descuento", async () => {
  const env = entornoPago();
  const c = await conCuenta(env);
  const r = await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }, { id: "ds-0001", cantidad: 2 }], { pago: "transferencia" }));
  assert.equal(r.status, 201);
  assert.equal(r.datos.pedido.subtotal, 5100 + 2 * 630);
  assert.equal(r.datos.pedido.descuento, (5670 - 5100) + (1400 - 1260));
  assert.equal(r.datos.pedido.pago, "transferencia");
});

test("por Mercado Pago se cobran los precios de lista, sin descuento", async () => {
  const env = entornoPago();
  const c = await conCuenta(env);
  const r = await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }, { id: "ds-0001", cantidad: 2 }], { pago: "mercadopago" }));
  assert.equal(r.status, 201);
  assert.equal(r.datos.pedido.subtotal, 5670 + 2 * 700);
  assert.equal(r.datos.pedido.descuento, 0);
  assert.equal(r.datos.pedido.pago, "mercadopago");
});

test("si no hay clave de Mercado Pago, no se puede elegir ese medio", async () => {
  const env = crearEntorno();
  const c = await conCuenta(env);
  const r = await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }], { pago: "mercadopago" }));
  assert.equal(r.status, 400);
  assert.equal(r.datos.error, "pago_no_disponible");
  assert.equal((await c.get("/api/config")).datos.mercadoPago, false);
});

test("con el token pero sin el secreto del webhook, Mercado Pago sigue apagado", async () => {
  const env = crearEntorno({ MP_ACCESS_TOKEN: CLAVES.MP_ACCESS_TOKEN });
  const c = await conCuenta(env);
  assert.equal((await c.get("/api/config")).datos.mercadoPago, false);
  const r = await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }], { pago: "mercadopago" }));
  assert.equal(r.datos.error, "pago_no_disponible");
});

test("un medio de pago inventado se rechaza", async () => {
  const env = entornoPago();
  const c = await conCuenta(env);
  const r = await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }], { pago: "efectivo" }));
  assert.equal(r.status, 400);
  assert.equal(r.datos.error, "pago_invalido");
});

const CORREO = { MICORREO_USER: "u", MICORREO_PASSWORD: "p", MICORREO_CUSTOMER_ID: "1" };
const envioA = { entrega: "envio", provincia: "Buenos Aires", cp: "7600", calle: "Calle 1 123", localidad: "Balcarce", nombre: "Cliente Prueba" };
const correoRespondiendo = () => {
  vaciarCache();
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/token")) return Response.json({ token: "jwt" });
    if (String(url).endsWith("/rates")) return Response.json({ rates: [{ productName: "Paq.ar", price: 6000 }] });
    throw new Error("URL inesperada");
  };
};

test("si el Correo en producción no responde, se cobra la tarifa por zona por Mercado Pago", async () => {
  globalThis.fetch = async () => new Response("sin correo", { status: 500 });
  const env = entornoPago({ ...CORREO, MICORREO_AMBIENTE: "produccion" });
  const c = await conCuenta(env);
  const r = await c.post("/api/pedidos", { items: [{ id: "ds-0001", cantidad: 1 }], ...envioA, pago: "mercadopago" });
  assert.equal(r.status, 201);
  assert.equal(r.datos.pedido.envioFuente, "zona");
  assert.equal(r.datos.pedido.envio, 14000); // Buenos Aires: zona 1
});

test("sin Correo configurado, Mercado Pago cobra la tarifa por zona de la provincia", async () => {
  const env = entornoPago();
  const c = await conCuenta(env);
  for (const [provincia, cp, esperado] of [["Santa Fe", "3000", 14000], ["Mendoza", "5500", 19000], ["Salta", "4400", 24000]]) {
    const r = await c.post("/api/pedidos", { items: [{ id: "ds-0001", cantidad: 1 }], ...envioA, provincia, cp, pago: "mercadopago" });
    assert.equal(r.status, 201, provincia);
    assert.equal(r.datos.pedido.envioFuente, "zona");
    assert.equal(r.datos.pedido.envio, esperado, provincia);
  }
});

test("una tarifa del ambiente de PRUEBA del Correo se ignora: se usa la zona", async () => {
  correoRespondiendo();
  const env = entornoPago(CORREO); // sin MICORREO_AMBIENTE: se trata como prueba
  const c = await conCuenta(env);
  const r = await c.post("/api/pedidos", { items: [{ id: "ds-0001", cantidad: 1 }], ...envioA, pago: "mercadopago" });
  assert.equal(r.status, 201);
  assert.equal(r.datos.pedido.envioFuente, "zona");
  assert.equal(r.datos.pedido.envio, 14000); // no los 6000 de la tarifa de prueba
});

test("con el Correo en producción, el envío es definitivo y se puede cobrar por Mercado Pago", async () => {
  correoRespondiendo();
  const env = entornoPago({ ...CORREO, MICORREO_AMBIENTE: "produccion" });
  const c = await conCuenta(env);
  const r = await c.post("/api/pedidos", { items: [{ id: "ds-0001", cantidad: 1 }], ...envioA, pago: "mercadopago" });
  assert.equal(r.status, 201);
  assert.equal(r.datos.pedido.envioFuente, "correo");
  assert.equal(r.datos.pedido.envio, 6000);
});

// ---------- Link de pago ----------

test("crea el link de pago con el total exacto del pedido", async () => {
  const env = entornoPago();
  const c = await conCuenta(env);
  const pedido = (await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 2 }], { pago: "mercadopago" }))).datos.pedido;
  const llamadas = simularMercadoPago();
  const r = await c.post(`/api/pedidos/${pedido.id}/pago`);
  assert.equal(r.status, 200);
  assert.equal(r.datos.url, "https://mercadopago.com/pagar/pref-123");
  const enviado = llamadas.preferencias[0].cuerpo;
  assert.equal(enviado.external_reference, pedido.id);
  const total = enviado.items.reduce((a, i) => a + i.unit_price * i.quantity, 0);
  assert.equal(total, pedido.total);
  assert.equal(total, 2 * 5670);
  assert.match(enviado.notification_url, /\/api\/pagos\/mercadopago$/);
  assert.equal(fila(env, pedido.id).payment_preference_id, "pref-123");
});

test("el envío viaja como una línea más del pago", async () => {
  correoRespondiendo();
  const env = entornoPago({ ...CORREO, MICORREO_AMBIENTE: "produccion" });
  const c = await conCuenta(env);
  const pedido = (await c.post("/api/pedidos", { items: [{ id: "ds-0001", cantidad: 1 }], ...envioA, pago: "mercadopago" })).datos.pedido;
  assert.ok(pedido.envio > 0);
  const llamadas = simularMercadoPago();
  await c.post(`/api/pedidos/${pedido.id}/pago`);
  const enviado = llamadas.preferencias[0].cuerpo;
  assert.equal(enviado.items.at(-1).id, "envio");
  assert.equal(enviado.items.reduce((a, i) => a + i.unit_price * i.quantity, 0), pedido.total);
});

test("no se puede pedir el link de pago de un pedido ajeno", async () => {
  const env = entornoPago();
  const dueno = await conCuenta(env, "uno@ejemplo.com");
  const otro = await conCuenta(env, "dos@ejemplo.com");
  const pedido = (await dueno.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }], { pago: "mercadopago" }))).datos.pedido;
  simularMercadoPago();
  assert.equal((await otro.post(`/api/pedidos/${pedido.id}/pago`)).status, 404);
});

test("un pedido por transferencia no abre el pago de Mercado Pago", async () => {
  const env = entornoPago();
  const c = await conCuenta(env);
  const pedido = (await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }], { pago: "transferencia" }))).datos.pedido;
  simularMercadoPago();
  const r = await c.post(`/api/pedidos/${pedido.id}/pago`);
  assert.equal(r.status, 409);
  assert.equal(r.datos.error, "otro_medio");
});

test("si Mercado Pago se cuelga al crear el link, se corta por plazo", async () => {
  const env = entornoPago({ TIMEOUT_EXTERNO_MS: "50" });
  const c = await conCuenta(env);
  const pedido = (await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }], { pago: "mercadopago" }))).datos.pedido;
  simularMercadoPago({ colgado: true });
  const inicio = Date.now();
  const r = await c.post(`/api/pedidos/${pedido.id}/pago`);
  assert.equal(r.status, 502);
  assert.ok(Date.now() - inicio < 2000);
});

// ---------- Diagnóstico: qué se muestra y qué no ----------

test("el cliente ve un mensaje general: sin motivo técnico ni datos de la clave", async () => {
  const env = entornoPago(); // MP_DIAGNOSTICO no está activo
  const c = await conCuenta(env);
  const pedido = (await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }], { pago: "mercadopago" }))).datos.pedido;
  simularMercadoPago({ estadoPreferencia: 403, mensajePreferencia: "At least one policy returned UNAUTHORIZED" });
  const r = await c.post(`/api/pedidos/${pedido.id}/pago`);
  assert.equal(r.status, 502);
  assert.doesNotMatch(r.texto, /UNAUTHORIZED|403|APP_USR|caracteres/);
});

test("con el diagnóstico encendido se ve el motivo del proveedor, pero NUNCA la clave ni su forma", async () => {
  const env = entornoPago({ MP_DIAGNOSTICO: "1" });
  const c = await conCuenta(env);
  const pedido = (await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }], { pago: "mercadopago" }))).datos.pedido;
  simularMercadoPago({ estadoPreferencia: 403, mensajePreferencia: `Token ${CLAVES.MP_ACCESS_TOKEN} inválido de a@b.com` });
  const r = await c.post(`/api/pedidos/${pedido.id}/pago`);
  assert.match(r.datos.mensaje, /mercadopago 403/);
  assert.ok(!r.texto.includes(CLAVES.MP_ACCESS_TOKEN));
  assert.ok(!r.texto.includes("APP_USR"));
  assert.ok(!r.texto.includes("a@b.com"));
  assert.doesNotMatch(r.texto, /caracteres|prefijo|clave APP/);
});

test("formatoDeToken detecta la Public Key pegada en lugar del Access Token, sin revelar nada", () => {
  assert.equal(formatoDeToken("APP_USR-12345678-1234-1234-1234-123456789012"), "parece_public_key");
  assert.equal(formatoDeToken(CLAVES.MP_ACCESS_TOKEN), "access_token");
  assert.equal(formatoDeToken("TEST-123-456"), "de_prueba");
  assert.equal(formatoDeToken(""), "vacío");
  assert.equal(formatoDeToken("cualquier-cosa"), "desconocido");
  assert.doesNotMatch(sanear(`el token ${CLAVES.MP_ACCESS_TOKEN} y TEST-abc-123 y x@y.com`), /APP_USR|TEST-|x@y\.com/);
  assert.ok(sanear("x".repeat(500)).length <= 160);
});

// ---------- Aviso de pago: firma y consulta ----------

test("un aviso con firma inválida se rechaza (401) y no toca el pedido", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  const llamadas = simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total } });
  const r = await avisar(c, "9001", { "x-signature": "ts=1,v1=0000", "x-request-id": "req-1" });
  assert.equal(r.status, 401);
  assert.equal(llamadas.pagos, 0, "ni siquiera se consulta a Mercado Pago");
  assert.equal(fila(env, pedido.id).status, "recibido");
});

test("un aviso sin firma tampoco pasa", async () => {
  const env = entornoPago();
  const { c } = await pedidoParaCobrar(env);
  simularMercadoPago();
  assert.equal((await avisar(c, "9001", {})).status, 401);
});

test("un aviso firmado y aprobado confirma el pago, anota el historial y avisa al cliente", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total } });
  assert.equal((await avisoFirmado(c)).status, 200);
  const f = fila(env, pedido.id);
  assert.equal(f.status, "pago_confirmado");
  assert.equal(f.payment_id, "9001");
  assert.equal(f.payment_status, "approved");
  assert.equal(eventos(env, pedido.id).filter((e) => e.status === "pago_confirmado").length, 1);
  assert.ok(mailsA(env, "cliente@ejemplo.com").some((m) => m.subject.includes("Pago confirmado")));
});

test("el mismo aviso repetido no duplica el evento ni el mail", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total } });
  await avisoFirmado(c);
  await avisoFirmado(c);
  assert.equal(eventos(env, pedido.id).filter((e) => e.status === "pago_confirmado").length, 1);
  assert.equal(mailsA(env, "cliente@ejemplo.com").filter((m) => m.subject.includes("Pago confirmado")).length, 1);
  assert.equal(fila(env, pedido.id).payment_issue, "");
});

test("cinco avisos simultáneos confirman UNA sola vez", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total } });
  const cabeceras = await firmar(CLAVES.MP_WEBHOOK_SECRET, "9001", "req-1");
  const rs = await Promise.all(Array.from({ length: 5 }, () => avisar(c, "9001", cabeceras)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(eventos(env, pedido.id).filter((e) => e.status === "pago_confirmado").length, 1);
  assert.equal(mailsA(env, "cliente@ejemplo.com").filter((m) => m.subject.includes("Pago confirmado")).length, 1);
});

// ---------- Aviso de pago: fallos del proveedor (se reintentan) ----------

for (const [nombre, config] of [
  ["la red cae", { redCaida: true }],
  ["responde 429", { estadoPago: 429 }],
  ["responde 500", { estadoPago: 500 }],
  ["responde 503", { estadoPago: 503 }],
  ["rechaza nuestra credencial (401)", { estadoPago: 401 }],
  ["rechaza nuestra credencial (403)", { estadoPago: 403 }],
]) {
  test(`si Mercado Pago ${nombre}, el aviso NO se acusa: 503 para que reintente`, async () => {
    const env = entornoPago();
    const { c, pedido } = await pedidoParaCobrar(env);
    simularMercadoPago(config);
    const r = await avisoFirmado(c);
    assert.equal(r.status, 503);
    assert.ok(r.res.headers.get("retry-after"));
    assert.equal(fila(env, pedido.id).status, "recibido");
  });
}

test("si Mercado Pago se cuelga, el aviso se corta por plazo y se reintenta (503)", async () => {
  const env = entornoPago({ TIMEOUT_EXTERNO_MS: "50" });
  const { c, pedido } = await pedidoParaCobrar(env);
  simularMercadoPago({ colgado: true });
  const inicio = Date.now();
  assert.equal((await avisoFirmado(c)).status, 503);
  assert.ok(Date.now() - inicio < 2000);
  assert.equal(fila(env, pedido.id).status, "recibido");
});

test("un pago que no existe (404, como las pruebas del panel) se acusa con 200: no hay nada que reintentar", async () => {
  const env = entornoPago();
  const { c } = await pedidoParaCobrar(env);
  simularMercadoPago({ estadoPago: 404 });
  assert.equal((await avisoFirmado(c)).status, 200);
});

test("tras un fallo, el reintento del mismo aviso sí confirma", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  simularMercadoPago({ estadoPago: 500 });
  assert.equal((await avisoFirmado(c)).status, 503);
  simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total } });
  assert.equal((await avisoFirmado(c)).status, 200);
  assert.equal(fila(env, pedido.id).status, "pago_confirmado");
});

test("otros tipos de aviso y avisos sin id se acusan sin consultar nada", async () => {
  const env = entornoPago();
  const { c } = await pedidoParaCobrar(env);
  const llamadas = simularMercadoPago();
  assert.equal((await c.post("/api/pagos/mercadopago", { type: "merchant_order", data: { id: "1" } })).status, 200);
  assert.equal((await c.post("/api/pagos/mercadopago", { type: "payment", data: {} })).status, 200);
  assert.equal(llamadas.pagos, 0);
});

// ---------- Validación del cobro ----------

test("un pago por menos del total no confirma: queda marcado y se avisa al dueño", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total - 1000 } });
  await avisoFirmado(c);
  const f = fila(env, pedido.id);
  assert.equal(f.status, "recibido");
  assert.equal(f.payment_issue, "importe_distinto");
  assert.ok(mailsA(env, "dueno@ejemplo.com").some((m) => m.subject.includes("Cobro a revisar")));
});

test("un pago por MÁS del total tampoco se da por bueno solo", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total + 500 } });
  await avisoFirmado(c);
  assert.equal(fila(env, pedido.id).status, "recibido");
  assert.equal(fila(env, pedido.id).payment_issue, "importe_distinto");
});

test("un pago en otra moneda no confirma aunque el número coincida", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total, currency_id: "USD" } });
  await avisoFirmado(c);
  assert.equal(fila(env, pedido.id).status, "recibido");
  assert.equal(fila(env, pedido.id).payment_issue, "importe_distinto");
});

test("un pago rechazado queda anotado pero no confirma el pedido", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total, status: "rejected" } });
  await avisoFirmado(c);
  const f = fila(env, pedido.id);
  assert.equal(f.status, "recibido");
  assert.equal(f.payment_status, "rejected");
  assert.equal(f.payment_issue, "");
});

test("un pago pendiente (efectivo) no confirma, y después sí cuando se acredita", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total, status: "pending" } });
  await avisoFirmado(c);
  assert.equal(fila(env, pedido.id).status, "recibido");
  simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total, status: "approved" } });
  await avisoFirmado(c);
  assert.equal(fila(env, pedido.id).status, "pago_confirmado");
});

test("un pago de otro pedido que no existe no rompe nada", async () => {
  const env = entornoPago();
  const { c } = await pedidoParaCobrar(env);
  simularMercadoPago({ pago: { external_reference: "no-existe", transaction_amount: 1 } });
  assert.equal((await avisoFirmado(c)).status, 200);
});

test("un pago aprobado de un pedido que se paga por transferencia no lo confirma", async () => {
  const env = entornoPago();
  const c = await conCuenta(env);
  const pedido = (await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }], { pago: "transferencia" }))).datos.pedido;
  simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total } });
  await avisoFirmado(c);
  assert.equal(fila(env, pedido.id).status, "recibido");
});

test("un pago de prueba (live_mode false) no confirma pedidos con credenciales de producción", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total, live_mode: false } });
  await avisoFirmado(c);
  assert.equal(fila(env, pedido.id).status, "recibido");
});

// ---------- Cancelaciones, duplicados y devoluciones ----------

async function cancelar(c, pedido) { return c.post(`/api/pedidos/${pedido.id}/cancelar`, {}); }

test("un pago que llega DESPUÉS de cancelar no reactiva el pedido: queda marcado y se avisa una sola vez", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  assert.equal((await cancelar(c, pedido)).status, 200);
  simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total } });
  await avisoFirmado(c);
  await avisoFirmado(c); // repetido
  const f = fila(env, pedido.id);
  assert.equal(f.status, "cancelado");
  assert.equal(f.payment_issue, "pago_en_pedido_cancelado");
  assert.equal(f.payment_id, "9001", "queda asociado para poder devolverlo");
  assert.equal(eventos(env, pedido.id).filter((e) => e.note.includes("pago_en_pedido_cancelado")).length, 1);
  assert.equal(mailsA(env, "dueno@ejemplo.com").filter((m) => m.subject.includes("Cobro a revisar")).length, 1);
  assert.equal(eventos(env, pedido.id).filter((e) => e.status === "pago_confirmado").length, 0);
});

test("un segundo pago distinto sobre un pedido ya pagado queda como duplicado", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  simularMercadoPago({ pago: { id: 9001, external_reference: pedido.id, transaction_amount: pedido.total } });
  await avisoFirmado(c, "9001");
  simularMercadoPago({ pago: { id: 9002, external_reference: pedido.id, transaction_amount: pedido.total } });
  await avisoFirmado(c, "9002");
  const f = fila(env, pedido.id);
  assert.equal(f.status, "pago_confirmado");
  assert.equal(f.payment_id, "9001", "el primero sigue siendo el pago del pedido");
  assert.equal(f.payment_issue, "pago_duplicado");
  assert.ok(mailsA(env, "dueno@ejemplo.com").some((m) => m.subject.includes("Cobro a revisar")));
});

test("si el pago confirmado después se devuelve o tiene contracargo, se marca sin cambiar el estado solo", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total } });
  await avisoFirmado(c);
  simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total, status: "refunded" } });
  await avisoFirmado(c);
  assert.equal(fila(env, pedido.id).status, "pago_confirmado");
  assert.equal(fila(env, pedido.id).payment_issue, "pago_devuelto");
  simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total, status: "charged_back" } });
  await avisoFirmado(c);
  assert.equal(fila(env, pedido.id).payment_issue, "contracargo");
});

test("cancelar y pagar al mismo tiempo nunca deja un pago confirmado DESPUÉS de la cancelación", async () => {
  for (let vuelta = 0; vuelta < 5; vuelta++) {
    const env = entornoPago();
    const { c, pedido } = await pedidoParaCobrar(env);
    simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total } });
    const cabeceras = await firmar(CLAVES.MP_WEBHOOK_SECRET, "9001", "req-1");
    await Promise.all(vuelta % 2 ? [cancelar(c, pedido), avisar(c, "9001", cabeceras)] : [avisar(c, "9001", cabeceras), cancelar(c, pedido)]);
    const f = fila(env, pedido.id);
    const hist = eventos(env, pedido.id);
    assert.equal(f.status, "cancelado");
    const iCancel = hist.findIndex((e) => e.status === "cancelado");
    const iPago = hist.findIndex((e) => e.status === "pago_confirmado");
    assert.ok(iCancel >= 0);
    if (iPago >= 0) assert.ok(iPago < iCancel, "si se confirmó, fue antes de cancelar");
    else assert.equal(f.payment_issue, "pago_en_pedido_cancelado", "si se canceló primero, el cobro quedó marcado");
  }
});

test("el dueño cierra el cobro revisado desde el panel y el cliente no recibe un mail de cambio de estado", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  await cancelar(c, pedido);
  simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total } });
  await avisoFirmado(c);
  const dueno = await entrarComoDueno(env);
  const lista = await dueno.get("/api/admin/pedidos");
  assert.equal(lista.datos.pedidos[0].problemaPago, "pago_en_pedido_cancelado");
  const antes = mailsA(env, "cliente@ejemplo.com").length;
  const r = await dueno.patch(`/api/admin/pedidos/${pedido.id}`, { resolverProblemaPago: true });
  assert.equal(r.status, 200);
  assert.equal(fila(env, pedido.id).payment_issue, "");
  assert.equal(mailsA(env, "cliente@ejemplo.com").length, antes);
  // El cliente nunca ve el código interno.
  assert.equal((await c.get("/api/pedidos")).datos.pedidos[0].problemaPago, undefined);
});

// ---------- Atomicidad ----------

test("confirmar el pago y su evento son una sola operación: si falla el evento, el pedido no cambia", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  // Se fuerza un fallo justo al anotar el evento de confirmación.
  env.DB.db.exec("CREATE TRIGGER falla_evento BEFORE INSERT ON order_events WHEN NEW.status = 'pago_confirmado' BEGIN SELECT RAISE(ABORT, 'falla simulada'); END;");
  simularMercadoPago({ pago: { external_reference: pedido.id, transaction_amount: pedido.total } });
  const r = await avisoFirmado(c);
  assert.equal(r.status, 500, "no se acusa recibo: Mercado Pago va a reintentar");
  const f = fila(env, pedido.id);
  assert.equal(f.status, "recibido", "no quedó un estado sin su evento");
  assert.equal(f.payment_id, "");
  // Arreglado el problema, el reintento confirma normalmente.
  env.DB.db.exec("DROP TRIGGER falla_evento");
  assert.equal((await avisoFirmado(c)).status, 200);
  assert.equal(fila(env, pedido.id).status, "pago_confirmado");
});

// ---------- Conciliación ----------

test("la conciliación confirma un pago aunque el aviso nunca haya llegado ni el comprador haya vuelto", async () => {
  const env = entornoPago();
  const { pedido } = await pedidoParaCobrar(env);
  const llamadas = simularMercadoPago({ busqueda: [{ id: 7001, status: "approved", currency_id: "ARS", transaction_amount: 5670, external_reference: pedido.id, live_mode: true }] });
  const r = await conciliarPendientes(env, { waitUntil: (p) => p });
  assert.deepEqual(r, { revisados: 1, confirmados: 1, problemas: 0, errores: 0 });
  assert.equal(llamadas.busquedas, 1);
  assert.equal(fila(env, pedido.id).status, "pago_confirmado");
  assert.equal(eventos(env, pedido.id).filter((e) => e.status === "pago_confirmado").length, 1);
});

test("la conciliación no vuelve a consultar el mismo pedido en menos de 10 minutos", async () => {
  const env = entornoPago();
  await pedidoParaCobrar(env);
  const llamadas = simularMercadoPago({ busqueda: [] });
  await conciliarPendientes(env, null);
  await conciliarPendientes(env, null);
  assert.equal(llamadas.busquedas, 1);
  await conciliarPendientes(env, null, { forzar: true });
  assert.equal(llamadas.busquedas, 2);
});

test("si Mercado Pago falla durante la conciliación, se cuenta el error y el pedido se revisa otra vez después", async () => {
  const env = entornoPago();
  const { pedido } = await pedidoParaCobrar(env);
  simularMercadoPago({ estadoPago: 500 });
  const r = await conciliarPendientes(env, null);
  assert.equal(r.errores, 1);
  assert.equal(fila(env, pedido.id).status, "recibido");
  simularMercadoPago({ busqueda: [{ id: 7001, status: "approved", currency_id: "ARS", transaction_amount: 5670, external_reference: pedido.id, live_mode: true }] });
  assert.equal((await conciliarPendientes(env, null, { forzar: true })).confirmados, 1);
});

test("la conciliación también detecta un pago en un pedido cancelado, pero no consulta pedidos sin link de pago", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  await cancelar(c, pedido);
  const sinLink = (await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }], { pago: "mercadopago" }))).datos.pedido;
  const llamadas = simularMercadoPago({ busqueda: [{ id: 7001, status: "approved", currency_id: "ARS", transaction_amount: 5670, external_reference: pedido.id, live_mode: true }] });
  const r = await conciliarPendientes(env, null, { forzar: true });
  assert.equal(llamadas.busquedas, 1, "solo el que tiene preferencia");
  assert.equal(r.problemas, 1);
  assert.equal(fila(env, pedido.id).payment_issue, "pago_en_pedido_cancelado");
  assert.equal(fila(env, sinLink.id).status, "recibido");
});

test("el botón «Revisar pagos» del panel solo lo puede usar el dueño", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  simularMercadoPago({ busqueda: [{ id: 7001, status: "approved", currency_id: "ARS", transaction_amount: 5670, external_reference: pedido.id, live_mode: true }] });
  assert.equal((await c.post("/api/admin/conciliar", {})).status, 403);
  assert.equal((await cliente(env).post("/api/admin/conciliar", {})).status, 401);
  const dueno = await entrarComoDueno(env);
  const r = await dueno.post("/api/admin/conciliar", {});
  assert.equal(r.status, 200);
  assert.equal(r.datos.confirmados, 1);
});

test("al volver de Mercado Pago, la página consulta a Mercado Pago (una vez cada 20 s) y no depende del aviso", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  const llamadas = simularMercadoPago({ busqueda: [{ id: 7001, status: "approved", currency_id: "ARS", transaction_amount: 5670, external_reference: pedido.id, live_mode: true }] });
  const r = await c.get(`/api/pedidos/numero/${pedido.numero}`);
  assert.equal(r.datos.pedido.estado, "pago_confirmado");
  await c.get(`/api/pedidos/numero/${pedido.numero}`);
  assert.equal(llamadas.busquedas, 1);
});

test("el cliente puede consultar su pedido por número, y nadie más", async () => {
  const env = entornoPago();
  const { c, pedido } = await pedidoParaCobrar(env);
  simularMercadoPago();
  const r = await c.get(`/api/pedidos/numero/${pedido.numero}`);
  assert.equal(r.status, 200);
  assert.equal(r.datos.pedido.id, pedido.id);
  const ajeno = await conCuenta(env, "otro@ejemplo.com");
  assert.equal((await ajeno.get(`/api/pedidos/numero/${pedido.numero}`)).status, 404);
});

test("sin las claves de Mercado Pago el aviso se rechaza con 503 (reintentable), no se descarta", async () => {
  const env = crearEntorno();
  const r = await avisar(cliente(env), "9001", {});
  assert.equal(r.status, 503);
});
