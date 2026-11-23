-- Facturación electrónica (ARCA). Aditiva: no toca ninguna tabla existente.
--
-- Una factura por pedido: el UNIQUE sobre order_id impide emitir dos veces por el mismo pago, aunque el aviso de
-- Mercado Pago llegue repetido o dos procesos intenten a la vez.
-- estado: pendiente (falta emitir o reintentar), emitida (ARCA devolvió CAE), error (ARCA la rechazó: revisar a mano).
CREATE TABLE invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  status TEXT NOT NULL,
  ambiente TEXT NOT NULL,                -- prueba | produccion
  pto_vta INTEGER NOT NULL,
  cbte_tipo INTEGER NOT NULL,            -- 11 = Factura C
  cbte_nro INTEGER,                      -- se anota ANTES de pedir el CAE: si se corta, al reintentar se consulta antes de volver a pedir
  cbte_fecha TEXT,                       -- AAAAMMDD
  total INTEGER NOT NULL,
  cae TEXT NOT NULL DEFAULT '',
  cae_vto TEXT NOT NULL DEFAULT '',      -- AAAAMMDD
  intentos INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT NOT NULL DEFAULT '',
  bloqueo_hasta TEXT,                    -- mientras un proceso está emitiendo, ningún otro lo toca
  mail_enviado_en TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_invoices_status ON invoices(status, updated_at);

-- Acceso temporal a los servicios de ARCA (dura unas 12 horas). ARCA no entrega uno nuevo mientras el anterior
-- sigue vigente, por eso se guarda y se reutiliza.
CREATE TABLE arca_tickets (
  servicio TEXT NOT NULL,
  ambiente TEXT NOT NULL,
  token TEXT NOT NULL,
  sign TEXT NOT NULL,
  vence TEXT NOT NULL,                   -- ISO 8601
  PRIMARY KEY (servicio, ambiente)
);
