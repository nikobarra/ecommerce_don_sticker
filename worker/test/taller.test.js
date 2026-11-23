import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno, cliente, entrarComoDueno, registrar, mailsEnviados } from './helpers.js';
import { sha256 } from '../src/util.js';
import { PACKS_CONTENIDO } from '../src/packs-contenido.js';

const secret = '1234567890abcdef'.repeat(4);
const auth = { cabeceras: { authorization: `Bearer ${secret}` } };
async function linked(env) {
  const c = cliente(env);
  const start = await c.post('/api/taller/vincular', { hash: await sha256(secret), equipo: 'Taller PC' });
  assert.equal(start.status, 201);
  const owner = await entrarComoDueno(env);
  const approve = await owner.post('/api/admin/taller/aprobar', { codigo: start.datos.codigo });
  assert.equal(approve.status, 200);
  return { c, owner, start };
}

test('taller exige aprobación de Google admin, vence y se revoca', async () => {
  const env = crearEntorno();
  const c = cliente(env);
  const start = await c.post('/api/taller/vincular', { hash: await sha256(secret), equipo: 'PC' });
  assert.equal(start.status, 201);
  assert.equal((await c.get('/api/taller/pedidos', auth)).status, 401);
  assert.equal((await c.post('/api/admin/taller/aprobar', { codigo: start.datos.codigo })).status, 401);
  const owner = await entrarComoDueno(env);
  assert.equal((await owner.post('/api/admin/taller/aprobar', { codigo: start.datos.codigo })).status, 200);
  assert.equal((await c.get('/api/taller/sesion', auth)).status, 200);
  // Una clave de taller no abre otras funciones administrativas.
  assert.equal((await c.get('/api/admin/resumen', auth)).status, 401);
  const teams = await owner.get('/api/admin/taller/equipos');
  assert.equal(teams.datos.equipos.length, 1);
  assert.ok(!JSON.stringify(teams.datos).includes(await sha256(secret)));
  await owner.post('/api/admin/taller/revocar', { id: teams.datos.equipos[0].id });
  assert.equal((await c.get('/api/taller/pedidos', auth)).status, 401);
});

test('taller incluye contenido de packs, pagina y usa los avisos de estado', async () => {
  const env = crearEntorno();
  const buyer = cliente(env);
  await registrar(buyer);
  const order = await buyer.post('/api/pedidos', { nombre: 'Ana', entrega: 'Balcarce', items: [{ id: 'pack-10-01', cantidad: 2 }] });
  assert.equal(order.status, 201);
  const { c } = await linked(env);
  const r = await c.get('/api/taller/pedidos?limite=1', auth);
  assert.equal(r.status, 200);
  assert.deepEqual(r.datos.pedidos[0].items[0].disenos, PACKS_CONTENIDO['pack-10-01']);
  assert.equal(r.datos.pedidos[0].items[0].contenidoActual, false);
  const page = await c.get('/api/taller/pedidos?despues=' + order.datos.pedido.id, auth);
  assert.equal(page.datos.pedidos.length, 0);
  const before = mailsEnviados(env).length;
  const updated = await c.patch('/api/taller/pedidos/' + order.datos.pedido.id, { estado: 'preparando', nota: 'En taller' }, auth);
  assert.equal(updated.status, 200);
  assert.equal(mailsEnviados(env).length, before + 1);
  await c.patch('/api/taller/pedidos/' + order.datos.pedido.id, { estado: 'preparando' }, auth);
  assert.equal(mailsEnviados(env).length, before + 1);
});

test('un código pendiente vence, no se puede reaprobar ni reutilizar el hash', async () => {
  const env = crearEntorno();
  const { c, owner, start } = await linked(env);
  assert.equal((await owner.post('/api/admin/taller/aprobar', { codigo: start.datos.codigo })).status, 400);
  assert.equal((await c.post('/api/taller/vincular', { hash: await sha256(secret) })).status, 409);
  env.DB.db.prepare('UPDATE taller_equipos SET expires_at = ?').run(Date.now() - 1);
  assert.equal((await c.get('/api/taller/sesion', auth)).status, 401);
});

test('sesión común no autoriza taller ni permite aprobar, origen cruzado se rechaza', async () => {
  const env = crearEntorno();
  const c = cliente(env);
  await registrar(c);
  assert.equal((await c.post('/api/admin/taller/aprobar', { codigo: 'ABCD-EFGH-JKLM' })).status, 403);
  const { owner } = await linked(env);
  assert.equal((await owner.get('/api/taller/pedidos')).status, 401);
  const cross = await owner.post('/api/admin/taller/revocar', { id: 'x' }, { cabeceras: { origin: 'https://otro.test' } });
  assert.equal(cross.status, 403);
});

test('taller conserva la instantánea y señala los packs históricos', async () => {
  const env = crearEntorno();
  const buyer = cliente(env);
  await registrar(buyer);
  const order = await buyer.post('/api/pedidos', { nombre: 'Ana', entrega: 'Balcarce', items: [{ id: 'pack-10-01', cantidad: 1 }] });
  const { c } = await linked(env);
  const items = [{ id: 'pack-10-01', tipo: 'pack', cantidad: 1, unidades: 1, disenos: ['ds-0001'] }];
  env.DB.db.prepare('UPDATE orders SET items_json = ? WHERE id = ?').run(JSON.stringify(items), order.datos.pedido.id);
  let r = await c.get('/api/taller/pedidos', auth);
  assert.deepEqual(r.datos.pedidos[0].items[0].disenos, ['ds-0001']);
  assert.equal(r.datos.pedidos[0].items[0].contenidoActual, false);
  delete items[0].disenos;
  env.DB.db.prepare('UPDATE orders SET items_json = ? WHERE id = ?').run(JSON.stringify(items), order.datos.pedido.id);
  r = await c.get('/api/taller/pedidos', auth);
  assert.deepEqual(r.datos.pedidos[0].items[0].disenos, PACKS_CONTENIDO['pack-10-01']);
  assert.equal(r.datos.pedidos[0].items[0].contenidoActual, true);
  env.DB.db.prepare('UPDATE users SET email_verified = 0 WHERE id = ?').run('dueno-id');
  assert.equal((await c.get('/api/taller/pedidos', auth)).status, 401);
});
