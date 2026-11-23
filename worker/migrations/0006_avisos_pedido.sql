-- Recordatorio único de pago.
-- recordatorio_pago_at: cuándo salió el ÚNICO recordatorio de un pedido de Mercado Pago que quedó sin pagar
-- (a las 24 horas de confirmado). Ver worker/src/avisos.js.
ALTER TABLE orders ADD COLUMN recordatorio_pago_at TEXT;

-- Los pedidos que ya existían no reciben recordatorio.
UPDATE orders SET recordatorio_pago_at = created_at;
