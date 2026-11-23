-- Esquema inicial de Don Sticker: cuentas, sesiones, pedidos y consentimientos.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,            -- siempre en minúsculas
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,                    -- NULL si la cuenta se creó solo con Google
  google_sub TEXT UNIQUE,                -- identificador estable de la cuenta de Google
  email_verified INTEGER NOT NULL DEFAULT 0,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  marketing_consent_at TEXT,
  unsubscribe_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

-- Se guarda el hash (SHA-256) del identificador de sesión, nunca el valor que viaja en la cookie.
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,           -- milisegundos desde 1970
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Enlaces de un solo uso: verificar mail y restablecer contraseña.
CREATE TABLE auth_tokens (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('verify', 'reset')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_tokens_user ON auth_tokens(user_id);

-- Registro de cuándo y cómo se dio o retiró el consentimiento para recibir novedades.
CREATE TABLE consent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('granted', 'revoked')),
  channel TEXT NOT NULL,                 -- registro, cuenta, google, baja
  text_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_consent_user ON consent_events(user_id);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,           -- el que ve el cliente, ej. DS-7K3M9Q
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  items_json TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  shipping INTEGER NOT NULL,
  shipping_source TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL,
  delivery TEXT NOT NULL,                -- Balcarce, Mar del Plata o envio
  province TEXT,
  postal_code TEXT,
  locality TEXT,
  customer_name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  tracking_number TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_orders_user ON orders(user_id, created_at);
CREATE INDEX idx_orders_status ON orders(status, created_at);

CREATE TABLE order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_order_events_order ON order_events(order_id);

-- Límite de intentos (ingreso, registro, recuperación).
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- Mientras no haya un servicio de mail configurado, los mails se guardan acá para poder verlos.
CREATE TABLE mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
