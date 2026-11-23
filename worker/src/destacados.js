// Stickers más vendidos para la banda de la portada. Público, sin datos personales:
// solo los identificadores de diseño, ordenados por cantidad vendida (pedidos no cancelados).

import { json } from "./util.js";

export async function destacados(env) {
  if (!env.DB) return json({ ids: [] }, 200, { "cache-control": "public, max-age=900" });
  const { results } = await env.DB.prepare(
    `SELECT json_extract(i.value, '$.id') AS diseno, SUM(json_extract(i.value, '$.cantidad')) AS cantidad
     FROM orders o, json_each(o.items_json) i
     WHERE o.status != 'cancelado' AND json_extract(i.value, '$.id') LIKE 'ds-%'
     GROUP BY json_extract(i.value, '$.id') ORDER BY cantidad DESC LIMIT 12`,
  ).all();
  return json({ ids: (results || []).map((r) => r.diseno) }, 200, { "cache-control": "public, max-age=900" });
}
