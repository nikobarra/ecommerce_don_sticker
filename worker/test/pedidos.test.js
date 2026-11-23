// Pruebas de pedidos, historial, estados y panel del dueño.
import { test } from "node:test";
import assert from "node:assert/strict";
import { armarDetalle } from "../src/precios.js";
import { crearEntorno, cliente, registrar, mailsEnviados, vaciarCache, entrarComoDueno } from "./helpers.js";

async function conCuenta(env, mail = "cliente@ejemplo.com") {
  const c = cliente(env);
  await registrar(c, mail);
  return c;
}

const pedidoRetiro = (items, extra = {}) => ({ items, entrega: "Balcarce", nombre: "Cliente Prueba", ...extra });

test("hacer un pedido exige tener sesión", async () => {
  const env = crearEntorno();
  const r = await cliente(env).post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }]));
  assert.equal(r.status, 401);
});

test("el servidor calcula los precios y no confía en los que manda el navegador", async () => {
  const env = crearEntorno();
  const c = await conCuenta(env);
  const r = await c.post("/api/pedidos", pedidoRetiro([
    { id: "pack-25-01", cantidad: 2, precio: 1 }, // un precio inventado se ignora
    { id: "ds-0001", cantidad: 3 },
    { id: "ds-0002", cantidad: 2 },
  ], { total: 1 }));
  assert.equal(r.status, 201);
  const p = r.datos.pedido;
  assert.equal(p.subtotal, 2 * 12050 + 3150);
  assert.equal(p.envio, 0);
  assert.equal(p.total, 27250);
  assert.equal(p.estado, "recibido");
  assert.match(p.numero, /^DS-[A-Z2-9]{6}$/);
});

test("desde 10, 25, 50 y 100 stickers a elección todo el pedido toma el precio por unidad del tramo", async () => {
  const env = crearEntorno();
  const c = await conCuenta(env);
  // [cantidad, total por transferencia, total de lista]: $700 hasta 9, $630 desde 10, $595 desde 25, $560 desde 50, $525 desde 100
  for (const [n, transferencia, lista] of [[1, 630, 700], [9, 5670, 6300], [10, 5670, 6300], [17, 9640, 10710], [24, 13610, 15120], [25, 13390, 14875], [49, 26240, 29155], [50, 25200, 28000], [99, 49900, 55440], [100, 47250, 52500], [150, 70880, 78750]]) {
    const t = armarDetalle([{ id: "ds-0001", cantidad: n }], "transferencia");
    assert.equal(t.subtotal, transferencia, `${n} por transferencia`);
    assert.equal(t.descuento, lista - transferencia, `${n} descuento`);
    assert.equal(armarDetalle([{ id: "ds-0001", cantidad: n }], "mercadopago").subtotal, lista, `${n} de lista`);
  }
  // mezclando diseños, cuenta la cantidad total de stickers a elección
  const mezcla = await c.post("/api/pedidos", pedidoRetiro([{ id: "ds-0001", cantidad: 6 }, { id: "ds-0003", cantidad: 4 }]));
  assert.equal(mezcla.datos.pedido.total, 5670);
});

test("rechaza productos inexistentes, cantidades raras, pedidos vacíos y entregas inválidas", async () => {
  const env = crearEntorno();
  const c = await conCuenta(env);
  const intentos = [
    pedidoRetiro([]),
    pedidoRetiro([{ id: "no-existe", cantidad: 1 }]),
    pedidoRetiro([{ id: "pack-10-01", cantidad: 0 }]),
    pedidoRetiro([{ id: "pack-10-01", cantidad: -3 }]),
    pedidoRetiro([{ id: "pack-10-01", cantidad: 1.5 }]),
    pedidoRetiro([{ id: "pack-10-01", cantidad: 100000 }]),
    pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }], { entrega: "Villa Gesell" }),
    { items: "pack-10-01", entrega: "Balcarce" },
  ];
  for (const cuerpo of intentos) assert.equal((await c.post("/api/pedidos", cuerpo)).status, 400, JSON.stringify(cuerpo));
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n, 0);
});

test("envío a domicilio: usa la tabla de respaldo si no hay Correo, y nunca es gratis", async () => {
  const env = crearEntorno(); // sin credenciales del Correo
  const c = await conCuenta(env);
  const base = { entrega: "envio", provincia: "Chubut", cp: "9100", localidad: "Trelew, Calle 1" };
  const chico = await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }], base));
  assert.equal(chico.status, 201);
  assert.equal(chico.datos.pedido.envio, 24000); // Chubut: zona 3
  assert.equal(chico.datos.pedido.envioFuente, "zona");
  assert.equal(chico.datos.pedido.total, 5100 + 24000);

  // Precio fijo por zona (referencia del dueño): zona 1 $14.000, zona 2 $19.000, zona 3 $24.000
  for (const [provincia, cp, esperado] of [["Santa Fe", "3000", 14000], ["Ciudad Autónoma de Buenos Aires", "1000", 14000], ["Mendoza", "5500", 19000], ["Neuquén", "8300", 19000], ["Tierra del Fuego", "9410", 24000], ["Jujuy", "4600", 24000]]) {
    const r = await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }], { ...base, provincia, cp }));
    assert.equal(r.datos.pedido.envio, esperado, provincia);
  }

  const grande = await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-100-01", cantidad: 2 }], base));
  assert.equal(grande.datos.pedido.envio, 24000, "no hay envío gratis, ni con un pedido grande");
  assert.equal(grande.datos.pedido.envioFuente, "zona");
  assert.equal(grande.datos.pedido.total, 2 * 42530 + 24000);

  assert.equal((await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }], { ...base, cp: "91" }))).datos.error, "cp_invalido");
  assert.equal((await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }], { ...base, provincia: "Narnia" }))).datos.error, "provincia_invalida");
});

test("envío a domicilio: con credenciales usa la tarifa del Correo", async () => {
  vaciarCache();
  const env = crearEntorno({ MICORREO_USER: "u", MICORREO_PASSWORD: "p", MICORREO_CUSTOMER_ID: "0000550137", MICORREO_AMBIENTE: "produccion" });
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/token")) return Response.json({ token: "jwt" });
    if (String(url).endsWith("/rates")) return Response.json({ rates: [{ deliveredType: "D", productName: "Paq.ar Clásico", price: 7234.4 }] });
    throw new Error("URL inesperada");
  };
  const c = await conCuenta(env);
  const r = await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }], { entrega: "envio", provincia: "Santa Fe", cp: "2000", localidad: "Rosario, Calle 2" }));
  assert.equal(r.datos.pedido.envio, 7234);
  assert.equal(r.datos.pedido.envioFuente, "correo");
});

test("el cliente ve solo sus pedidos y el historial de estados", async () => {
  const env = crearEntorno();
  const ana = await conCuenta(env, "ana@ejemplo.com");
  const beto = await conCuenta(env, "beto@ejemplo.com");
  const pa = (await ana.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }]))).datos.pedido;
  await beto.post("/api/pedidos", pedidoRetiro([{ id: "pack-25-01", cantidad: 1 }]));

  const lista = await ana.get("/api/pedidos");
  assert.equal(lista.datos.pedidos.length, 1);
  assert.equal(lista.datos.pedidos[0].numero, pa.numero);
  const uno = await ana.get(`/api/pedidos/${pa.id}`);
  assert.equal(uno.datos.pedido.historial[0].estado, "recibido");
  assert.equal((await beto.get(`/api/pedidos/${pa.id}`)).status, 404); // no puede ver el de otra persona
  assert.equal((await cliente(env).get("/api/pedidos")).status, 401);
});

test("botón de arrepentimiento: se puede cancelar hasta antes del despacho", async () => {
  const env = crearEntorno();
  const c = await conCuenta(env);
  const ids = {};
  for (const estado of ["recibido", "pago_confirmado", "preparando", "despachado", "entregado"]) {
    const p = (await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }]))).datos.pedido;
    env.DB.db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(estado, p.id);
    ids[estado] = p.id;
  }
  for (const estado of ["recibido", "pago_confirmado", "preparando"]) {
    const r = await c.post(`/api/pedidos/${ids[estado]}/cancelar`);
    assert.equal(r.status, 200, estado);
    assert.equal(r.datos.pedido.estado, "cancelado", estado);
  }
  for (const estado of ["despachado", "entregado"]) {
    const r = await c.post(`/api/pedidos/${ids[estado]}/cancelar`);
    assert.equal(r.status, 409, estado);
    assert.equal(r.datos.error, "no_cancelable");
    assert.equal(env.DB.db.prepare("SELECT status FROM orders WHERE id = ?").get(ids[estado]).status, estado); // no se tocó
  }
  // Cancelar dos veces no hace nada raro.
  assert.equal((await c.post(`/api/pedidos/${ids.recibido}/cancelar`)).datos.error, "ya_cancelado");
});

test("al arrepentirse, el cliente y el dueño reciben un mail y queda registrado en el recorrido", async () => {
  const env = crearEntorno();
  const c = await conCuenta(env, "cliente@ejemplo.com");
  const sinPagar = (await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }]))).datos.pedido;
  const pagado = (await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-25-01", cantidad: 1 }]))).datos.pedido;
  env.DB.db.prepare("UPDATE orders SET status = 'pago_confirmado' WHERE id = ?").run(pagado.id);

  let antes = mailsEnviados(env).length;
  const r1 = await c.post(`/api/pedidos/${sinPagar.id}/cancelar`);
  assert.equal(r1.datos.devolucion, false);
  let nuevos = mailsEnviados(env).slice(antes);
  assert.deepEqual(nuevos.map((m) => m.to_addr).sort(), ["cliente@ejemplo.com", "dueno@ejemplo.com"]);
  assert.match(nuevos.find((m) => m.to_addr === "cliente@ejemplo.com").body, /no hay nada que devolver/);
  assert.match(nuevos.find((m) => m.to_addr === "dueno@ejemplo.com").body, /No había pago confirmado/);

  antes = mailsEnviados(env).length;
  const r2 = await c.post(`/api/pedidos/${pagado.id}/cancelar`);
  assert.equal(r2.datos.devolucion, true);
  nuevos = mailsEnviados(env).slice(antes);
  assert.match(nuevos.find((m) => m.to_addr === "cliente@ejemplo.com").body, /te devolvemos el importe/);
  assert.match(nuevos.find((m) => m.to_addr === "dueno@ejemplo.com").body, /devolver el dinero/);

  const historial = (await c.get(`/api/pedidos/${pagado.id}`)).datos.pedido.historial;
  const ultimo = historial[historial.length - 1];
  assert.equal(ultimo.estado, "cancelado");
  assert.match(ultimo.nota, /botón de arrepentimiento/);
  assert.match(ultimo.nota, /Pago confirmado/);
});

test("arrepentimiento: nadie puede cancelar pedidos ajenos ni sin sesión", async () => {
  const env = crearEntorno();
  const ana = await conCuenta(env, "ana@ejemplo.com");
  const beto = await conCuenta(env, "beto@ejemplo.com");
  const p = (await ana.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }]))).datos.pedido;
  assert.equal((await beto.post(`/api/pedidos/${p.id}/cancelar`)).status, 404);
  assert.equal((await cliente(env).post(`/api/pedidos/${p.id}/cancelar`)).status, 401);
  assert.equal(env.DB.db.prepare("SELECT status FROM orders WHERE id = ?").get(p.id).status, "recibido");
});

test("el panel del dueño: solo para el administrador verificado", async () => {
  const env = crearEntorno();
  const cli = await conCuenta(env, "cliente@ejemplo.com");
  assert.equal((await cliente(env).get("/api/admin/pedidos")).status, 401);
  assert.equal((await cli.get("/api/admin/pedidos")).status, 403);

  // Una cuenta con el mail del dueño pero SIN verificar tampoco entra (alguien podría registrarse con ese mail).
  const falso = cliente(env);
  await registrar(falso, "dueno@ejemplo.com");
  assert.equal((await falso.get("/api/admin/pedidos")).status, 403);
});

test("el dueño cambia el estado, carga el seguimiento y el cliente recibe un mail", async () => {
  const env = crearEntorno();
  const cli = await conCuenta(env, "cliente@ejemplo.com");
  const p = (await cli.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }]))).datos.pedido;

  const adm = await entrarComoDueno(env);
  const lista = await adm.get("/api/admin/pedidos");
  assert.equal(lista.status, 200);
  assert.equal(lista.datos.pedidos[0].clienteMail, "cliente@ejemplo.com");

  assert.equal((await adm.patch(`/api/admin/pedidos/${p.id}`, { estado: "inventado" })).datos.error, "estado_invalido");
  assert.equal((await adm.patch(`/api/admin/pedidos/${p.id}`, { seguimiento: "<script>" })).datos.error, "seguimiento_invalido");

  const antes = mailsEnviados(env).length;
  const r = await adm.patch(`/api/admin/pedidos/${p.id}`, { estado: "despachado", seguimiento: "CA123456789AR" });
  assert.equal(r.datos.pedido.estado, "despachado");
  assert.equal(r.datos.pedido.seguimiento, "CA123456789AR");
  const mails = mailsEnviados(env).slice(antes);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to_addr, "cliente@ejemplo.com");
  assert.match(mails[0].subject, /Despachado/);
  assert.match(mails[0].body, /CA123456789AR/);

  const historial = (await cli.get(`/api/pedidos/${p.id}`)).datos.pedido.historial;
  assert.deepEqual(historial.map((h) => h.estado), ["recibido", "despachado"]);

  // Repetir el mismo cambio no manda otro mail.
  await adm.patch(`/api/admin/pedidos/${p.id}`, { estado: "despachado" });
  assert.equal(mailsEnviados(env).length, antes + 1);

  const resumen = await adm.get("/api/admin/resumen");
  assert.equal(resumen.datos.pedidosPorEstado.despachado, 1);
});

test("un pedido nuevo le avisa al dueño y le confirma al cliente", async () => {
  const env = crearEntorno();
  const c = await conCuenta(env, "cliente@ejemplo.com");
  const antes = mailsEnviados(env).length;
  await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }]));
  const nuevos = mailsEnviados(env).slice(antes);
  assert.deepEqual(nuevos.map((m) => m.to_addr).sort(), ["cliente@ejemplo.com", "dueno@ejemplo.com"]);
});

test("al eliminar la cuenta, los pedidos quedan sin datos personales", async () => {
  const env = crearEntorno();
  const c = await conCuenta(env);
  await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }], { entrega: "envio", provincia: "Chubut", cp: "9100", localidad: "Trelew, Calle 1", notas: "dejar en portería" }));
  await c.del("/api/cuenta", { confirmacion: "ELIMINAR" });
  const fila = env.DB.db.prepare("SELECT * FROM orders").get();
  assert.equal(fila.user_id, null);
  assert.equal(fila.customer_name, "(cuenta eliminada)");
  assert.equal(fila.locality, null);
  assert.equal(fila.notes, "");
});

test("el mail al dueño y el panel muestran qué diseños lleva un pack prearmado", async () => {
  const env = crearEntorno();
  const c = await conCuenta(env);
  const r = await c.post("/api/pedidos", pedidoRetiro([{ id: "pack-10-01", cantidad: 1 }]));
  assert.equal(r.status, 201);
  const mail = mailsEnviados(env).find((m) => /Pedido nuevo/.test(m.subject));
  assert.match(mail.body, /Lleva: DS-\d{4}(, DS-\d{4}){9}/);
  const dueno = await entrarComoDueno(env);
  const lista = (await dueno.get("/api/admin/pedidos")).datos.pedidos;
  assert.equal(lista[0].items[0].disenos.length, 10);
});
