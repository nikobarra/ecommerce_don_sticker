-- Avisos al celular (Web Push) sobre el estado del pedido.
-- Una fila por dispositivo que la persona activó desde «Mi cuenta». Se guarda lo mínimo que exige el estándar:
--   endpoint: la dirección que el navegador (Google, Mozilla o Apple) nos da para escribirle a ese dispositivo.
--   p256dh y auth: las claves públicas con las que se cifra cada aviso, para que solo ese dispositivo pueda leerlo.
-- No se guarda ningún dato del aparato. Si la persona desactiva los avisos, o elimina su cuenta, la fila se borra.
CREATE TABLE push_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  last_ok_at  TEXT
);
CREATE INDEX idx_push_user ON push_subscriptions(user_id);
