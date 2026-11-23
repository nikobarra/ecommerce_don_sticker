// Pruebas de la banda de más vendidos: público, sin datos personales y sin pedidos cancelados.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crearEntorno, cliente, registrar } from "./helpers.js";

test("más vendidos: ordena por cantidad, ignora packs y cancelados, y no expone datos personales", async () => {
  const env = crearEntorno();
  const comprador = cliente(env);
  await registrar(comprador, "destacados@ejemplo.com");
  await comprador.post("/api/pedidos", { items: [{ id: "ds-0002", cantidad: 2 }, { id: "ds-0001", cantidad: 5 }, { id: "pack-10-01", cantidad: 1 }], entrega: "Balcarce", nombre: "Compradora", pago: "transferencia" });
  const cancelado = await comprador.post("/api/pedidos", { items: [{ id: "ds-0003", cantidad: 40 }], entrega: "Balcarce", nombre: "Compradora", pago: "transferencia" });
  await comprador.post(`/api/pedidos/${cancelado.datos.pedido.id}/cancelar`, {});

  const r = await cliente(env).get("/api/destacados");
  assert.equal(r.status, 200);
  assert.deepEqual(r.datos.ids, ["ds-0001", "ds-0002"]);
  assert.equal(JSON.stringify(r.datos).includes("Compradora"), false);
});

test("sin pedidos, la lista de más vendidos viene vacía", async () => {
  const env = crearEntorno();
  const r = await cliente(env).get("/api/destacados");
  assert.equal(r.status, 200);
  assert.deepEqual(r.datos.ids, []);
});
