// Pruebas del conteo de visitas y de las analíticas del panel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crearEntorno, cliente, registrar, entrarComoDueno } from "./helpers.js";
import { normalizarRuta } from "../src/visitas.js";
import { periodoDe } from "../src/analiticas.js";

const hoy = () => new Date().toISOString().slice(0, 10);

const visitar = (c, ruta, nueva) => c.post("/api/visita", { ruta, nueva });

// ---------- Rutas ----------

test("las rutas se normalizan y las desconocidas caen en «otra»", () => {
  assert.equal(normalizarRuta("/"), "/");
  assert.equal(normalizarRuta("/index.html"), "/");
  assert.equal(normalizarRuta("/cuenta.html?x=1"), "/cuenta");
  assert.equal(normalizarRuta("/CUENTA"), "/cuenta");
  assert.equal(normalizarRuta("/terminos/"), "/terminos");
  assert.equal(normalizarRuta("/lo-que-sea"), "otra");
  assert.equal(normalizarRuta(undefined), "/");
});

// ---------- Conteo ----------

test("cuenta páginas y visitas por separado", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await visitar(c, "/", true);
  await visitar(c, "/terminos", false);
  await visitar(c, "/", false);
  const filas = env.DB.db.prepare("SELECT path, views, visits FROM page_views ORDER BY path").all().map((f) => ({ ...f }));
  assert.deepEqual(filas, [
    { path: "/", views: 2, visits: 1 },
    { path: "/terminos", views: 1, visits: 0 },
  ]);
});

test("el conteo no guarda ningún dato de quien visita", async () => {
  const env = crearEntorno();
  await visitar(cliente(env), "/", true);
  const columnas = env.DB.db.prepare("PRAGMA table_info(page_views)").all().map((c) => c.name);
  assert.deepEqual(columnas.sort(), ["day", "path", "views", "visits"]);
});

test("una recarga infinita no infla los números", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  for (let i = 0; i < 130; i++) await visitar(c, "/", false);
  const fila = env.DB.db.prepare("SELECT views FROM page_views WHERE path = '/'").get();
  assert.equal(fila.views, 120); // el tope por hora
});

// ---------- Período ----------

test("el período por defecto son los últimos 30 días", () => {
  const p = periodoDe(new URL("https://x.test/api/admin/analiticas"));
  assert.equal(p.dias, 30);
  assert.equal(p.hasta, hoy());
});

test("un período al revés o inventado no rompe nada", () => {
  const p = periodoDe(new URL("https://x.test/a?desde=2026-11-20&hasta=2026-11-10"));
  assert.equal(p.desde, "2026-11-10");
  assert.equal(p.dias, 1);
  const q = periodoDe(new URL("https://x.test/a?desde=cualquiera&hasta=1"));
  assert.equal(q.hasta, hoy());
});

// ---------- Analíticas ----------

test("las analíticas son solo para el dueño", async () => {
  const env = crearEntorno();
  assert.equal((await cliente(env).get("/api/admin/analiticas")).status, 401);
  const c = cliente(env);
  await registrar(c, "cualquiera@ejemplo.com");
  assert.equal((await c.get("/api/admin/analiticas")).status, 403);
});

test("resume ventas, productos y visitas del período", async () => {
  const env = crearEntorno();
  const comprador = cliente(env);
  await registrar(comprador, "compra@ejemplo.com");
  await comprador.post("/api/pedidos", { items: [{ id: "pack-25-01", cantidad: 2 }, { id: "ds-0001", cantidad: 3 }], entrega: "Balcarce", nombre: "Compradora", pago: "transferencia" });
  await comprador.post("/api/pedidos", { items: [{ id: "ds-0001", cantidad: 1 }], entrega: "Mar del Plata", nombre: "Compradora", pago: "transferencia" });
  await visitar(comprador, "/", true);
  await visitar(comprador, "/", false);

  const dueno = await entrarComoDueno(env);
  const r = await dueno.get("/api/admin/analiticas");
  assert.equal(r.status, 200);
  const d = r.datos;

  assert.equal(d.ventas.pedidos, 2);
  assert.equal(d.ventas.facturado, 2 * 12050 + 1890 + 630);
  assert.equal(d.ventas.ticket, Math.round(d.ventas.facturado / 2));
  assert.equal(d.ventas.descuentos, 2 * 1340 + 210 + 70);

  // El gato se vendió en los dos pedidos: 4 unidades.
  const gato = d.productos.find((p) => p.id === "ds-0001");
  assert.equal(gato.cantidad, 4);
  assert.equal(gato.pedidos, 2);
  const pack = d.productos.find((p) => p.id === "pack-25-01");
  assert.equal(pack.stickers, 50); // 2 packs de 25
  assert.equal(d.productos[0].id, "ds-0001"); // ordenado por cantidad

  assert.equal(d.mayoresVentas[0].total, 2 * 12050 + 1890);
  assert.equal(d.porMedioDePago[0].medio, "transferencia");
  assert.equal(d.porEntrega.length, 2);
  assert.equal(d.visitas.visitas, 1);
  assert.equal(d.visitas.paginas, 2);
  assert.equal(d.visitas.conversion, 200); // 2 pedidos sobre 1 visita
  assert.equal(d.clientes.nuevos, 2); // la compradora y el dueño
  assert.equal(d.ventasPorDia[0].pedidos, 2);
});

test("los pedidos cancelados no suman a lo facturado", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "cancela@ejemplo.com");
  const p = (await c.post("/api/pedidos", { items: [{ id: "pack-10-01", cantidad: 1 }], entrega: "Balcarce", nombre: "Quien Sea" })).datos.pedido;
  await c.post(`/api/pedidos/${p.id}/cancelar`, {});

  const dueno = await entrarComoDueno(env);
  const d = (await dueno.get("/api/admin/analiticas")).datos;
  assert.equal(d.ventas.pedidos, 0);
  assert.equal(d.ventas.facturado, 0);
  assert.equal(d.ventas.cancelados, 1);
  assert.equal(d.ventas.facturadoCancelado, 5100);
  assert.equal(d.productos.length, 0);
});

test("un período sin movimiento devuelve todo en cero, sin romperse", async () => {
  const env = crearEntorno();
  const dueno = await entrarComoDueno(env);
  const d = (await dueno.get("/api/admin/analiticas?desde=2020-01-01&hasta=2020-01-31")).datos;
  assert.equal(d.ventas.pedidos, 0);
  assert.equal(d.ventas.ticket, 0);
  assert.equal(d.visitas.conversion, null);
  assert.deepEqual(d.productos, []);
  assert.deepEqual(d.mayoresVentas, []);
});
