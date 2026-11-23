// Cada diseño del pedido lleva su código (DS-0001), que coincide con el nombre del archivo para imprimir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crearEntorno, cliente, registrar } from "./helpers.js";

test("el pedido guarda el código de cada diseño, y los packs no llevan código", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "codigos@ejemplo.com");
  const r = await c.post("/api/pedidos", { items: [{ id: "ds-0001", cantidad: 2 }, { id: "pack-10-01", cantidad: 1 }], entrega: "Balcarce", nombre: "Compradora", pago: "transferencia" });
  assert.equal(r.status, 201);
  const items = r.datos.pedido.items;
  const suelto = items.find((i) => i.tipo === "suelto");
  const pack = items.find((i) => i.tipo === "pack");
  assert.equal(suelto.codigo, "DS-0001");
  assert.equal(pack.codigo, undefined);
});
