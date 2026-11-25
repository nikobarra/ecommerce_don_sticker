// Pruebas de la carga automática del envío en MiCorreo, con respuestas SIMULADAS del Correo (no usan claves reales).
import { test } from "node:test";
import assert from "node:assert/strict";
import { separarCalle, codigoProvincia, armarEnvio, reintentarImportaciones } from "../src/micorreo.js";
import { crearEntorno, cliente, registrar, entrarComoDueno, vaciarCache } from "./helpers.js";

const CLAVES = { MICORREO_USER: "usuario", MICORREO_PASSWORD: "clave", MICORREO_CUSTOMER_ID: "0000550137", MICORREO_AMBIENTE: "produccion", MICORREO_IMPORTAR: "1" };
const fetchOriginal = globalThis.fetch;
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// Simula el Correo: token, cotización y carga del envío. «importar» decide qué responde la carga.
function simularCorreo(importar = () => Response.json({ createdAt: "2026-11-25T10:00:00.000-03:00" })) {
  const llamadas = { importaciones: [] };
  globalThis.fetch = async (url, opts = {}) => {
    if (url.endsWith("/token")) return Response.json({ token: "jwt-de-prueba" });
    if (url.endsWith("/rates")) return Response.json({ customerId: "x", rates: [{ deliveredType: "D", productName: "Correo Argentino Clasico", price: 9000 }] });
    if (url.endsWith("/shipping/import")) {
      llamadas.importaciones.push(JSON.parse(opts.body));
      return importar(llamadas.importaciones.length);
    }
    throw new Error("URL inesperada " + url);
  };
  return llamadas;
}
const restaurar = () => { globalThis.fetch = fetchOriginal; };

const pedidoEnvio = (extra = {}) => ({ items: [{ id: "pack-10-01", cantidad: 2 }, { id: "ds-0001", cantidad: 3 }], entrega: "envio", nombre: "Ana Pérez", provincia: "Buenos Aires", cp: "7600", calle: "Belgrano 1234", localidad: "Mar del Plata", ...extra });

async function conPedido(env, extra = {}, mail = "cliente@ejemplo.com") {
  const c = cliente(env);
  await registrar(c, mail);
  const r = await c.post("/api/pedidos", pedidoEnvio(extra));
  assert.equal(r.status, 201, JSON.stringify(r.datos));
  return { c, pedido: r.datos.pedido };
}
const fila = (env, id) => env.DB.db.prepare("SELECT * FROM micorreo_envios WHERE order_id = ?").get(id);
async function esperar(cond) { for (let i = 0; i < 60 && !cond(); i++) await pausa(25); await pausa(25); }

// ---------- Calle y altura ----------
test("separa la calle de la altura solo cuando no hay duda", () => {
  const casos = [
    ["Belgrano 1234", { calle: "Belgrano", altura: "1234", piso: "", depto: "" }],
    ["Av. San Martín 567", { calle: "Av. San Martín", altura: "567", piso: "", depto: "" }],
    ["Calle 12 nº 345", { calle: "Calle 12", altura: "345", piso: "", depto: "" }],
    ["Calle 12 1234", { calle: "Calle 12", altura: "1234", piso: "", depto: "" }],
    ["Av 9 de Julio 1234", { calle: "Av 9 de Julio", altura: "1234", piso: "", depto: "" }],
    ["Mitre 456 piso 4 dpto B", { calle: "Mitre", altura: "456", piso: "4", depto: "B" }],
    ["Mitre 456 5 B", { calle: "Mitre", altura: "456", piso: "5", depto: "B" }],
    ["Rivadavia N° 89, 2° A", { calle: "Rivadavia", altura: "89", piso: "2", depto: "" }],
    ["Calle 50 entre 3 y 4 nro 56", { calle: "Calle 50 entre 3 y 4", altura: "56", piso: "", depto: "" }],
  ];
  for (const [texto, esperado] of casos) assert.deepEqual(separarCalle(texto), esperado, texto);
  // Sin altura o sin calle: no se adivina.
  for (const dudoso of ["Belgrano", "1234", "9 de Julio 1234", "s/n", ""]) assert.equal(separarCalle(dudoso), null, dudoso);
});

test("las provincias se convierten a la letra del Correo", () => {
  assert.equal(codigoProvincia("Buenos Aires"), "B");
  assert.equal(codigoProvincia("Ciudad Autónoma de Buenos Aires"), "C");
  assert.equal(codigoProvincia("Córdoba"), "X");
  assert.equal(codigoProvincia("Tierra del Fuego"), "V");
  assert.equal(codigoProvincia("Neuquén"), "Q");
  assert.equal(codigoProvincia("Narnia"), null);
});

test("el envío se arma con las medidas de la caja, el peso y los datos del cliente", () => {
  const orden = { number: "DS-ABC234", street: "Belgrano 1234", province: "Buenos Aires", postal_code: "7600", locality: "Mar del Plata", customer_name: "Ana Pérez", subtotal: 20000, discount: 2000,
    items_json: JSON.stringify([{ tipo: "pack", unidades: 10, cantidad: 2 }, { tipo: "suelto", cantidad: 3 }]) };
  const r = armarEnvio({ MICORREO_CUSTOMER_ID: "567218" }, orden, "ana@ejemplo.com");
  assert.equal(r.ok, true);
  const c = r.cuerpo;
  assert.equal(c.customerId, "0000567218");
  assert.equal(c.extOrderId, "DS-ABC234");
  assert.deepEqual(c.recipient, { name: "Ana Pérez", phone: "", cellPhone: "", email: "ana@ejemplo.com" });
  assert.deepEqual(c.shipping.address, { streetName: "Belgrano", streetNumber: "1234", floor: "", apartment: "", city: "Mar del Plata", provinceCode: "B", postalCode: "7600" });
  assert.equal(c.shipping.deliveryType, "D");
  assert.deepEqual([c.shipping.length, c.shipping.width, c.shipping.height], [12, 11, 5]);
  assert.equal(c.shipping.weight, 23 * 2 + 40);
  assert.equal(c.shipping.declaredValue, 18000);
  assert.ok(c.sender.originAddress && Object.values(c.sender.originAddress).every((v) => v === null), "el origen sale de tu cuenta de MiCorreo");
});

// ---------- Flujo ----------
test("al confirmar el pago, el envío se carga solo en MiCorreo y no se carga dos veces", async () => {
  vaciarCache();
  const llamadas = simularCorreo();
  try {
    const env = crearEntorno(CLAVES);
    const { pedido } = await conPedido(env);
    const adm = await entrarComoDueno(env);
    assert.equal(llamadas.importaciones.length, 0, "recién hecho, todavía sin pago");

    await adm.patch(`/api/admin/pedidos/${pedido.id}`, { estado: "pago_confirmado" });
    await esperar(() => llamadas.importaciones.length >= 1);
    assert.equal(llamadas.importaciones.length, 1);
    assert.equal(llamadas.importaciones[0].orderNumber, pedido.numero);
    assert.equal(llamadas.importaciones[0].shipping.address.postalCode, "7600");
    assert.equal(fila(env, pedido.id).estado, "importado");

    // Cambios de estado posteriores no lo vuelven a cargar.
    await adm.patch(`/api/admin/pedidos/${pedido.id}`, { estado: "preparando" });
    await esperar(() => false);
    assert.equal(llamadas.importaciones.length, 1);

    // El panel lo informa.
    const lista = (await adm.get("/api/admin/pedidos")).datos;
    assert.equal(lista.micorreoActivo, true);
    assert.equal(lista.pedidos[0].micorreo.estado, "importado");
  } finally { restaurar(); }
});

test("los pedidos que se retiran en un punto de entrega no se cargan", async () => {
  vaciarCache();
  const llamadas = simularCorreo();
  try {
    const env = crearEntorno(CLAVES);
    const { pedido } = await conPedido(env, { entrega: "Balcarce", provincia: undefined, cp: undefined, calle: undefined, localidad: undefined });
    const adm = await entrarComoDueno(env);
    await adm.patch(`/api/admin/pedidos/${pedido.id}`, { estado: "pago_confirmado" });
    await esperar(() => false);
    assert.equal(llamadas.importaciones.length, 0);
    assert.equal(fila(env, pedido.id), undefined);
  } finally { restaurar(); }
});

test("con la carga apagada o sin producción no se hace nada", async () => {
  vaciarCache();
  const llamadas = simularCorreo();
  try {
    for (const extra of [{ MICORREO_IMPORTAR: "0" }, { MICORREO_AMBIENTE: "prueba" }]) {
      const env = crearEntorno({ ...CLAVES, ...extra });
      const { pedido } = await conPedido(env);
      await (await entrarComoDueno(env)).patch(`/api/admin/pedidos/${pedido.id}`, { estado: "pago_confirmado" });
      await esperar(() => false);
      assert.equal(fila(env, pedido.id), undefined);
    }
    assert.equal(llamadas.importaciones.length, 0);
  } finally { restaurar(); }
});

test("una dirección que no se puede separar queda marcada para cargar a mano, sin llamar al Correo", async () => {
  vaciarCache();
  const llamadas = simularCorreo();
  try {
    const env = crearEntorno(CLAVES);
    const { pedido } = await conPedido(env, { calle: "Casa de mi tía sin numero" });
    const adm = await entrarComoDueno(env);
    await adm.patch(`/api/admin/pedidos/${pedido.id}`, { estado: "pago_confirmado" });
    await esperar(() => fila(env, pedido.id));
    const f = fila(env, pedido.id);
    assert.equal(f.estado, "error");
    assert.equal(f.permanente, 1);
    assert.match(f.error, /Cargalo a mano/);
    assert.equal(llamadas.importaciones.length, 0);
    const p = (await adm.get("/api/admin/pedidos")).datos.pedidos[0];
    assert.equal(p.micorreo.permanente, true);
  } finally { restaurar(); }
});

test("si el Correo rechaza el dato, queda el motivo y se puede reintentar desde el panel", async () => {
  vaciarCache();
  const llamadas = simularCorreo((n) => (n === 1 ? Response.json({ code: "402", message: "Peso no valido" }, { status: 402 }) : Response.json({ createdAt: "x" })));
  try {
    const env = crearEntorno(CLAVES);
    const { pedido } = await conPedido(env);
    const adm = await entrarComoDueno(env);
    await adm.patch(`/api/admin/pedidos/${pedido.id}`, { estado: "pago_confirmado" });
    await esperar(() => fila(env, pedido.id));
    assert.equal(fila(env, pedido.id).permanente, 1);
    assert.match(fila(env, pedido.id).error, /Peso no valido/);

    const r = await adm.post(`/api/admin/pedidos/${pedido.id}/micorreo`);
    assert.equal(r.status, 200);
    assert.equal(r.datos.estado, "importado");
    assert.equal(fila(env, pedido.id).estado, "importado");
    assert.equal(llamadas.importaciones.length, 2);
  } finally { restaurar(); }
});

test("un corte del Correo se reintenta solo; y «ya fue importada» cuenta como éxito", async () => {
  vaciarCache();
  // El módulo ya reintenta 3 veces seguidas ante un 5xx: las 3 primeras llamadas caen y la cuarta (el reintento del cron) dice «ya importada».
  const llamadas = simularCorreo((n) => (n <= 3 ? new Response("down", { status: 503 }) : n === 4 ? Response.json({ code: "402", message: "La orden ya fue importada con anterioridad." }, { status: 402 }) : Response.json({ createdAt: "x" })));
  try {
    const env = crearEntorno(CLAVES);
    const { pedido } = await conPedido(env);
    await (await entrarComoDueno(env)).patch(`/api/admin/pedidos/${pedido.id}`, { estado: "pago_confirmado" });
    await esperar(() => fila(env, pedido.id));
    assert.equal(fila(env, pedido.id).estado, "error");
    assert.equal(fila(env, pedido.id).permanente, 0);

    assert.equal(await reintentarImportaciones(env), 1);
    assert.equal(fila(env, pedido.id).estado, "importado");
    assert.equal(await reintentarImportaciones(env), 0, "ya no queda nada para reintentar");
  } finally { restaurar(); }
});

test("solo el dueño puede mandar un envío a MiCorreo desde el panel", async () => {
  vaciarCache();
  simularCorreo();
  try {
    const env = crearEntorno(CLAVES);
    const { c, pedido } = await conPedido(env);
    assert.equal((await c.post(`/api/admin/pedidos/${pedido.id}/micorreo`)).status, 403);
    assert.equal((await cliente(env).post(`/api/admin/pedidos/${pedido.id}/micorreo`)).status, 401);
    // Con el pago sin confirmar, ni el dueño puede.
    const adm = await entrarComoDueno(env);
    const r = await adm.post(`/api/admin/pedidos/${pedido.id}/micorreo`);
    assert.equal(r.datos.estado, "error");
    assert.match(r.datos.mensaje, /pago confirmado/);
  } finally { restaurar(); }
});
