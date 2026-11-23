-- Medio de pago del pedido y datos del cobro por Mercado Pago.

ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'transferencia';
-- Lo que se ahorró el cliente por pagar con transferencia (0 si pagó con Mercado Pago).
ALTER TABLE orders ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;
-- Datos que devuelve Mercado Pago. Vacíos mientras no haya un cobro.
ALTER TABLE orders ADD COLUMN payment_preference_id TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN payment_id TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT '';
