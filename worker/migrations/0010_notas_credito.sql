-- Notas de Crédito C (anulan una factura, total o por devolución) y origen de cada factura. Aditiva.
-- Una nota de crédito por factura (UNIQUE sobre invoice_id): no se puede anular dos veces.
CREATE TABLE credit_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  status TEXT NOT NULL,                  -- pendiente | emitida | error
  ambiente TEXT NOT NULL,
  pto_vta INTEGER NOT NULL,
  cbte_tipo INTEGER NOT NULL,            -- 13 = Nota de Crédito C
  cbte_nro INTEGER,
  cbte_fecha TEXT,
  total INTEGER NOT NULL,
  cae TEXT NOT NULL DEFAULT '',
  cae_vto TEXT NOT NULL DEFAULT '',
  motivo TEXT NOT NULL DEFAULT '',
  intentos INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT NOT NULL DEFAULT '',
  bloqueo_hasta TEXT,
  mail_enviado_en TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_credit_notes_order ON credit_notes(order_id);

-- automatica: salió sola al acreditarse un pago de Mercado Pago. manual: la pidió el dueño con el botón «Facturar».
ALTER TABLE invoices ADD COLUMN origen TEXT NOT NULL DEFAULT 'automatica';
