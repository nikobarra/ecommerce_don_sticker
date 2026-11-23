-- Mail semanal de novedades.
-- newsletters: un envío por semana ISO (p. ej. 2026-W47), con los diseños que incluyó.
-- newsletter_envios: a quién le toca cada envío y en qué quedó. Solo guarda el id del usuario
-- (el mail se lee de users al momento de enviar), así una cuenta borrada no deja datos personales acá.

CREATE TABLE newsletters (
  id TEXT PRIMARY KEY,
  semana TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  items_json TEXT NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('enviando', 'terminado', 'sin_novedades')),
  total INTEGER NOT NULL DEFAULT 0,
  enviados INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE newsletter_envios (
  newsletter_id TEXT NOT NULL REFERENCES newsletters(id),
  user_id TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'enviado', 'omitido', 'error')),
  intentos INTEGER NOT NULL DEFAULT 0,
  enviado_at TEXT,
  PRIMARY KEY (newsletter_id, user_id)
);

CREATE INDEX idx_newsletter_envios_estado ON newsletter_envios (newsletter_id, estado);
CREATE INDEX idx_newsletter_envios_dia ON newsletter_envios (enviado_at);
