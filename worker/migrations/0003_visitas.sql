-- Conteo de visitas, sin datos personales: solo un contador por día y por página.
-- No se guarda IP, ni navegador, ni identificador de visitante, así que no hace falta
-- consentimiento ni cambia lo declarado ante la AAIP.
--   views  = páginas abiertas
--   visits = veces que alguien llegó a la web (una por pestaña nueva)

CREATE TABLE page_views (
  day TEXT NOT NULL,                     -- AAAA-MM-DD
  path TEXT NOT NULL,                    -- ruta, sin datos de la consulta
  views INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path)
);
CREATE INDEX idx_page_views_day ON page_views(day);
