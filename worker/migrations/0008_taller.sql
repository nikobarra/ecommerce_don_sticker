-- Vinculación del taller local: clave del dispositivo solo como hash.
CREATE TABLE IF NOT EXISTS taller_equipos (
  id TEXT PRIMARY KEY,
  device_hash TEXT NOT NULL UNIQUE,
  codigo_hash TEXT UNIQUE,
  nombre TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT
);
