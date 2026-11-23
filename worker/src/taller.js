import { json, error } from './util.js';
import { usuarioTaller } from './taller-acceso.js';
import { pedidoPublico } from './pedidos.js';
import { PACKS_CONTENIDO } from './packs-contenido.js';

export async function pedidosTaller(request, env) {
  if (!(await usuarioTaller(request, env))) return error('sin_vinculo', 'Vinculá este equipo desde el panel web.', 401);
  const q = new URL(request.url).searchParams;
  const despues = q.get('despues') || '';
  if (despues && !/^[a-f0-9-]{36}$/.test(despues)) return error('cursor_invalido', 'Cursor de pedidos inválido.');
  const limite = Math.max(1, Math.min(100, Math.floor(Number(q.get('limite')) || 100)));
  const { results } = await env.DB.prepare(`SELECT o.*, u.email AS customer_email FROM orders o
    LEFT JOIN users u ON u.id = o.user_id WHERE o.id > ? ORDER BY o.id LIMIT ?`).bind(despues, limite + 1).all();
  const filas = results.slice(0, limite);
  return json({ pedidos: filas.map(f => {
    const p = pedidoPublico(f);
    p.clienteMail = f.customer_email || null;
    p.problemaPago = f.payment_issue || '';
    p.items = p.items.map(i => i.tipo !== 'pack' ? i : ({ ...i,
      disenos: i.disenos || PACKS_CONTENIDO[i.id] || null,
      contenidoActual: !Array.isArray(i.disenos) }));
    return p;
  }), siguiente: results.length > limite ? filas.at(-1).id : null });
}
