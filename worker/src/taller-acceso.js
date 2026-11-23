import { json, error, sha256, uuid, ahora, leerJson, limitarPor, ipDe, limpiarTexto } from './util.js';
import { usuarioActual, usuarioPublico, esAdmin } from './auth.js';

export async function usuarioTaller(request, env) {
  const token = (request.headers.get('authorization') || '').match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) return null;
  const u = await env.DB.prepare(`SELECT u.*, t.expires_at AS taller_expira FROM taller_equipos t
    JOIN users u ON u.id = t.user_id WHERE t.device_hash = ? AND t.expires_at > ? AND t.approved_at IS NOT NULL`)
    .bind(await sha256(token), Date.now()).first();
  return u && esAdmin(env, u) ? u : null;
}

export async function accesoTaller(request, env, ruta) {
  if (ruta === '/api/taller/vincular' && request.method === 'POST') {
    if (!(await limitarPor(env, 'taller-inicio', ipDe(request), 10, 3600))) return error('limite', 'Esperá un rato antes de pedir otro código.', 429);
    const d = await leerJson(request, 1500);
    if (!d.ok) return d.respuesta;
    if (!/^[a-f0-9]{64}$/.test(d.datos.hash || '')) return error('hash_invalido', 'Clave del equipo inválida.');
    await env.DB.prepare('DELETE FROM taller_equipos WHERE expires_at < ?').bind(Date.now()).run();
    if (await env.DB.prepare('SELECT id FROM taller_equipos WHERE device_hash = ?').bind(d.datos.hash).first()) return error('ya_existe', 'Esta clave ya se usó. Generá una nueva.', 409);
    const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const codigo = Array.from(crypto.getRandomValues(new Uint8Array(12)), x => alfabeto[x % alfabeto.length]).join('');
    await env.DB.prepare('INSERT INTO taller_equipos (id, device_hash, codigo_hash, nombre, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(uuid(), d.datos.hash, await sha256(codigo), limpiarTexto(d.datos.equipo, 80) || 'Taller local', Date.now() + 10 * 60000, ahora()).run();
    return json({ codigo: codigo.match(/.{4}/g).join('-'), venceEn: 600 }, 201);
  }
  if (ruta === '/api/taller/sesion' && request.method === 'GET') {
    const u = await usuarioTaller(request, env);
    return u ? json({ usuario: usuarioPublico(env, u), vence: u.taller_expira }) : error('sin_vinculo', 'Equipo sin vincular o acceso vencido. Vinculalo desde el panel web.', 401);
  }
  if (!ruta.startsWith('/api/admin/taller/')) return null;
  const u = await usuarioActual(env, request);
  if (!u) return error('sin_sesion', 'Ingresá con Google en la web.', 401);
  if (!esAdmin(env, u)) return error('prohibido', 'Solo el administrador puede vincular equipos.', 403);
  if (ruta === '/api/admin/taller/equipos' && request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT id, nombre, created_at, approved_at, expires_at FROM taller_equipos WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC').bind(u.id, Date.now()).all();
    return json({ equipos: results });
  }
  if (request.method !== 'POST') return null;
  const d = await leerJson(request, 1500);
  if (!d.ok) return d.respuesta;
  if (ruta === '/api/admin/taller/aprobar') {
    if (!(await limitarPor(env, 'taller-aprobar', u.id, 20, 3600))) return error('limite', 'Demasiados intentos.', 429);
    const codigo = String(d.datos.codigo || '').toUpperCase().replace(/[-\s]/g, '');
    if (!/^[A-Z2-9]{12}$/.test(codigo)) return error('codigo_invalido', 'Copiá el código de 12 caracteres que muestra la app.');
    const r = await env.DB.prepare('UPDATE taller_equipos SET user_id = ?, approved_at = ?, expires_at = ?, codigo_hash = NULL WHERE codigo_hash = ? AND user_id IS NULL AND expires_at > ?')
      .bind(u.id, ahora(), Date.now() + 7 * 86400000, await sha256(codigo), Date.now()).run();
    return r.meta?.changes ? json({ ok: true }) : error('codigo_vencido', 'Código vencido, incorrecto o ya utilizado.');
  }
  if (ruta === '/api/admin/taller/revocar') {
    await env.DB.prepare('DELETE FROM taller_equipos WHERE id = ? AND user_id = ?').bind(String(d.datos.id || ''), u.id).run();
    return json({ ok: true });
  }
  return null;
}
