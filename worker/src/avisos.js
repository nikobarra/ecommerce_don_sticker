// Recordatorio único para pedidos de Mercado Pago que quedaron sin pagar.
//
// El mail con el detalle del pedido sale al confirmar (pedidos.js), como siempre. Si a las
// RECORDATORIO_HORAS el pedido de Mercado Pago sigue sin pagar, sale UN recordatorio, una sola vez.
// El recordatorio se «reserva» con un UPDATE condicional antes de mandarlo: aunque dos procesos corran
// a la vez, sale una sola vez.

import { ahora } from "./util.js";
import { enviarMail, mailRecordatorioPago, urlSitio } from "./mail.js";

export const RECORDATORIO_HORAS = 24;
const RECORDATORIO_HASTA_DIAS = 7; // un pedido más viejo que esto ya no recibe recordatorio
const MAX_POR_CORRIDA = 20;

const antes = (fecha, ms) => new Date(fecha.getTime() - ms).toISOString();

export async function recordatoriosDePago(env, fecha = new Date()) {
  const sitio = urlSitio(env);
  const { results } = await env.DB.prepare(
    `SELECT * FROM orders WHERE payment_method = 'mercadopago' AND status = 'recibido' AND recordatorio_pago_at IS NULL
       AND created_at <= ? AND created_at >= ? ORDER BY created_at LIMIT ?`,
  ).bind(antes(fecha, RECORDATORIO_HORAS * 3600000), antes(fecha, RECORDATORIO_HASTA_DIAS * 86400000), MAX_POR_CORRIDA).all();

  let enviados = 0;
  for (const fila of results || []) {
    try {
      const r = await env.DB.prepare("UPDATE orders SET recordatorio_pago_at = ? WHERE id = ? AND recordatorio_pago_at IS NULL").bind(ahora(), fila.id).run();
      if (!r.meta?.changes) continue;
      const u = fila.user_id ? await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(fila.user_id).first() : null;
      if (!u?.email) continue;
      await enviarMail(env, { to: u.email, ...mailRecordatorioPago({ ...fila, items: JSON.parse(fila.items_json) }, `${sitio}/cuenta.html`) });
      enviados++;
    } catch (e) {
      console.error("Recordatorio de pago fallido:", e.message); // sin datos personales
    }
  }
  return { enviados };
}
