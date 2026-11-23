// Recordatorio único para pedidos de Mercado Pago sin pagar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crearEntorno, cliente, registrar, mailsEnviados } from "./helpers.js";
import { recordatoriosDePago } from "../src/avisos.js";

const HORA = 3600000;

async function pedido(env, c, { pago = "mercadopago", horasAtras = 25, estado = "recibido" } = {}) {
  const r = await c.post("/api/pedidos", { items: [{ id: "ds-0001", cantidad: 2 }], entrega: "Balcarce", nombre: "Compradora", pago: "transferencia" });
  assert.equal(r.status, 201);
  env.DB.db.prepare("UPDATE orders SET payment_method = ?, status = ?, created_at = ? WHERE id = ?")
    .run(pago, estado, new Date(Date.now() - horasAtras * HORA).toISOString(), r.datos.pedido.id);
  return r.datos.pedido;
}

const recordatorios = (env) => mailsEnviados(env).filter((m) => m.subject.includes("sigue esperando el pago"));

test("el mail del pedido sale al confirmar, como siempre", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "compra@ejemplo.com");
  await c.post("/api/pedidos", { items: [{ id: "ds-0001", cantidad: 1 }], entrega: "Balcarce", nombre: "Compradora", pago: "transferencia" });
  assert.equal(mailsEnviados(env).filter((m) => m.to_addr === "compra@ejemplo.com" && m.subject.startsWith("Recibí tu pedido")).length, 1);
});

test("un pedido de Mercado Pago sin pagar a las 24 horas recibe UN recordatorio, una sola vez", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "compra@ejemplo.com");
  const p = await pedido(env, c);
  assert.equal((await recordatoriosDePago(env)).enviados, 1);
  assert.equal((await recordatoriosDePago(env)).enviados, 0, "no se repite");
  const r = recordatorios(env);
  assert.equal(r.length, 1);
  assert.equal(r[0].to_addr, "compra@ejemplo.com");
  assert.match(r[0].subject, new RegExp(p.numero));
  assert.match(r[0].body, /único recordatorio/);
});

test("no hay recordatorio antes de las 24 horas, si ya pagó, si es transferencia o si es muy viejo", async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c, "compra@ejemplo.com");
  await pedido(env, c, { horasAtras: 5 });
  await pedido(env, c, { estado: "pago_confirmado" });
  await pedido(env, c, { pago: "transferencia" });
  await pedido(env, c, { estado: "cancelado" });
  await pedido(env, c, { horasAtras: 24 * 10 });
  assert.equal((await recordatoriosDePago(env)).enviados, 0);
  assert.equal(recordatorios(env).length, 0);
});
