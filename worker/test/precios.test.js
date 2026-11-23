// Verifica que los precios del servidor sean los mismos que muestra la web (web/js/data.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { TIENDA, PACKS, PRODUCTOS, ENVIO, aTransferencia, totalSueltos } from "../src/precios.js";
import { PACKS_CONTENIDO } from "../src/packs-contenido.js";

const codigo = readFileSync(new URL("../../web/js/data.js", import.meta.url), "utf8");
const catalogo = readFileSync(new URL("../../web/js/catalogo.js", import.meta.url), "utf8");
// Se pasa por JSON para que los objetos del contexto aislado se comparen por su contenido.
const web = JSON.parse(JSON.stringify(vm.runInNewContext(`${codigo}\n${catalogo}\n({ CONFIG, PACKS, PRODUCTOS, ENVIO })`)));

test("las reglas de la tienda coinciden con la web", () => {
  assert.deepEqual(TIENDA.puntosDeEntrega, web.CONFIG.puntosDeEntrega);
  assert.equal(TIENDA.precioUnitario, web.CONFIG.precioUnitario);
  assert.equal(TIENDA.descuentoTransferencia, web.CONFIG.descuentoTransferencia);
  assert.deepEqual(TIENDA.tramos, web.CONFIG.tramos);
  // Ya no existen el precio mayorista de 51 en adelante ni el envío gratis.
  for (const clave of ["envioGratisDesde", "mayorDesde", "precioMayor", "precioMayorTransferencia"]) {
    assert.ok(!(clave in TIENDA) && !(clave in web.CONFIG), clave);
  }
});

test("los packs coinciden con la web", () => {
  assert.deepEqual(PACKS, web.PACKS.map(({ id, nombre, unidades, precio, precioTransferencia }) => ({ id, nombre, unidades, precio, precioTransferencia })));
});

test("los precios bajan con la cantidad y la transferencia nunca es mayor que la lista", () => {
  assert.equal(TIENDA.precioUnitario, 700);
  let anterior = TIENDA.precioUnitario;
  for (const t of TIENDA.tramos) {
    assert.ok(t.precio < anterior, `el tramo de ${t.desde} tiene que ser más barato que el anterior`);
    anterior = t.precio;
  }
  assert.ok(aTransferencia(TIENDA.precioUnitario) < TIENDA.precioUnitario);
  for (const p of PACKS) assert.ok(p.precioTransferencia < p.precio, `${p.id} sin descuento por transferencia`);
});

test("los packs prearmados salen más baratos que armar la misma cantidad a elección", () => {
  for (const p of PACKS) {
    assert.ok(p.precio < totalSueltos(p.unidades, "mercadopago"), `${p.id}: lista`);
    assert.ok(p.precioTransferencia < totalSueltos(p.unidades, "transferencia"), `${p.id}: transferencia`);
  }
});

test("hay 10 packs prearmados de 10, 25, 50 y 100 stickers, y packs temáticos", () => {
  for (const n of [10, 25, 50, 100]) assert.equal(PACKS.filter((p) => p.id.startsWith(`pack-${n}-`)).length, 10, `packs de ${n}`);
  assert.ok(PACKS.filter((p) => p.id.startsWith("tema-")).length >= 8);
  assert.equal(new Set(PACKS.map((p) => p.id)).size, PACKS.length, "ids repetidos");
});

test("cada pack lleva la cantidad exacta de diseños que existen, y no se repiten entre packs del mismo tamaño", () => {
  const ids = new Set(PRODUCTOS.map((p) => p.id));
  for (const p of PACKS) {
    const lista = PACKS_CONTENIDO[p.id];
    assert.equal(lista.length, p.unidades, p.id);
    assert.equal(new Set(lista).size, p.unidades, `${p.id} repite diseños`);
    for (const d of lista) assert.ok(ids.has(d), `${p.id}: ${d} no está en el catálogo`);
  }
  for (const n of [10, 25, 50, 100]) {
    const todos = PACKS.filter((p) => p.id.startsWith(`pack-${n}-`)).flatMap((p) => PACKS_CONTENIDO[p.id]);
    assert.equal(new Set(todos).size, todos.length, `hay diseños repetidos entre los packs de ${n}`);
  }
});

test("el catálogo coincide con la web", () => {
  assert.deepEqual(PRODUCTOS, web.PRODUCTOS.map(({ id, nombre }) => ({ id, nombre })));
});

test("la tabla de envío de respaldo coincide con la web", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(ENVIO)), JSON.parse(JSON.stringify(web.ENVIO)));
});
