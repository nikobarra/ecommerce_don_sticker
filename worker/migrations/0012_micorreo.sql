-- Carga automática de los envíos en MiCorreo (Correo Argentino). Ver worker/src/micorreo.js.
-- Una fila por pedido con envío. estado:
--   importado  el envío ya está cargado en la cuenta de MiCorreo (falta pagarlo y bajar el rótulo desde «Mis envíos»).
--   error      no se pudo cargar. permanente = 1: hay que cargarlo a mano (dirección que no se pudo separar, dato
--              rechazado por el Correo); permanente = 0: fue un corte del Correo y se reintenta solo.
CREATE TABLE micorreo_envios (
  order_id       TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  estado         TEXT NOT NULL,
  error          TEXT NOT NULL DEFAULT '',
  permanente     INTEGER NOT NULL DEFAULT 0,
  intentos       INTEGER NOT NULL DEFAULT 0,
  creado_en      TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  importado_en   TEXT
);
