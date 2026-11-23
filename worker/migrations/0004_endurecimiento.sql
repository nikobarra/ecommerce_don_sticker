-- Endurecimiento (auditoría 16/11/2026). Solo AGREGA columnas e índices: no modifica ni borra datos.
--
-- street               calle y número, separados de la localidad. Los pedidos viejos tienen NULL y
--                      conservan «localidad y dirección» juntas en `locality`.
-- idempotency_key      clave que genera el navegador por pedido: un reintento no crea un pedido doble.
-- request_fingerprint  huella del contenido del pedido, para detectar una clave reutilizada con otros datos.
-- payment_issue        '' si todo está bien. Si un cobro necesita decisión del dueño: pago_en_pedido_cancelado,
--                      pago_duplicado, importe_distinto, pago_devuelto, contracargo.
-- payment_checked_at   última vez que se consultó a Mercado Pago por este pedido (conciliación).
-- attribution_json     UTM e identificadores de clic de la campaña que trajo el pedido (sin datos personales).

ALTER TABLE orders ADD COLUMN street TEXT;
ALTER TABLE orders ADD COLUMN idempotency_key TEXT;
ALTER TABLE orders ADD COLUMN request_fingerprint TEXT;
ALTER TABLE orders ADD COLUMN payment_issue TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN payment_checked_at TEXT;
ALTER TABLE orders ADD COLUMN attribution_json TEXT;

-- Un mismo cliente no puede tener dos pedidos con la misma clave. Los NULL (pedidos sin clave) no cuentan.
CREATE UNIQUE INDEX idx_orders_idempotency ON orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Los pedidos con Mercado Pago sin pagar se revisan seguido: el índice evita recorrer toda la tabla.
CREATE INDEX idx_orders_pendientes_mp ON orders(payment_method, status, created_at);
