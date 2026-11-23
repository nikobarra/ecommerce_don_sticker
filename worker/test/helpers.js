// Ayudantes de prueba: una base SQLite en memoria que imita a D1, y un cliente HTTP simple.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker from "../src/index.js";

// Se aplican todas las migraciones, en orden, igual que en la base de verdad.
const CARPETA = new URL("../migrations/", import.meta.url);
const MIGRACIONES = readdirSync(CARPETA).filter((n) => n.endsWith(".sql")).sort();

export function crearD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const nombre of MIGRACIONES) db.exec(readFileSync(new URL(nombre, CARPETA), "utf8"));
  const sentencia = (sql, params = []) => ({
    bind: (...p) => sentencia(sql, p),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), meta: {} }),
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
  });
  return {
    db,
    prepare: (sql) => sentencia(sql),
    batch: async (lista) => {
      db.exec("BEGIN");
      try {
        const salida = [];
        for (const s of lista) salida.push(await s.run());
        db.exec("COMMIT");
        return salida;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

// Caché falsa, como la que da Cloudflare.
const almacenCache = new Map();
globalThis.caches = {
  default: {
    match: async (req) => almacenCache.get(req.url)?.clone(),
    put: async (req, res) => void almacenCache.set(req.url, res),
  },
};
export const vaciarCache = () => almacenCache.clear();

export function crearEntorno(extra = {}) {
  return {
    DB: crearD1(),
    ASSETS: { fetch: async () => new Response("web") },
    ADMIN_EMAILS: "dueno@ejemplo.com",
    GOOGLE_CLIENT_ID: "cliente-de-prueba.apps.googleusercontent.com",
    MAIL_PROVIDER: "log",
    MICORREO_BASE: "https://test.invalid/micorreo/v1",
    CP_ORIGEN: "7620",
    ...extra,
  };
}

const ctx = { waitUntil: (p) => p };

// Cliente que recuerda la cookie de sesión, como un navegador.
export function cliente(env, origen = "https://donsticker.test") {
  let galleta = "";
  const llamar = async (metodo, ruta, cuerpo, opciones = {}) => {
    const cabeceras = { origin: origen, ...(opciones.cabeceras || {}) };
    if (cuerpo !== undefined) cabeceras["content-type"] = "application/json";
    if (galleta) cabeceras.cookie = galleta;
    const res = await worker.fetch(new Request(origen + ruta, { method: metodo, headers: cabeceras, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) }), env, ctx);
    const nueva = res.headers.get("set-cookie");
    if (nueva) {
      const valor = nueva.split(";")[0];
      galleta = valor.endsWith("=") ? "" : valor;
    }
    const copia = res.clone();            // el cuerpo se puede leer dos veces: como texto y, para archivos (PDF), como bytes
    const texto = await res.text();
    let datos = null;
    try { datos = JSON.parse(texto); } catch { /* no era JSON */ }
    return { status: res.status, datos, texto, res: copia };
  };
  return {
    get: (r, o) => llamar("GET", r, undefined, o),
    post: (r, c = {}, o) => llamar("POST", r, c, o),
    patch: (r, c = {}, o) => llamar("PATCH", r, c, o),
    del: (r, c = {}, o) => llamar("DELETE", r, c, o),
    cookie: () => galleta,
    ponerCookie: (g) => { galleta = g; },
  };
}

export const PASSWORD_OK = "una-clave-larga-123";

export async function registrar(c, mail = "cliente@ejemplo.com", extra = {}) {
  return c.post("/api/auth/registro", { email: mail, password: PASSWORD_OK, nombre: "Cliente Prueba", ...extra });
}

export const mailsEnviados = (env) => env.DB.db.prepare("SELECT * FROM mail_log ORDER BY id").all();

// Saca el token de un enlace dentro del último mail enviado a esa dirección.
export function tokenDelUltimoMail(env, destino) {
  const filas = env.DB.db.prepare("SELECT body FROM mail_log WHERE to_addr = ? ORDER BY id DESC").all(destino);
  const m = filas[0]?.body.match(/token=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// El dueño entra con una cuenta verificada Y con Google vinculado (así es administrador).
export async function entrarComoDueno(env, { googleSub = 'google-sub-del-dueno' } = {}) {
  const c = cliente(env);
  env.DB.db.prepare('INSERT OR IGNORE INTO users (id, email, name, email_verified, google_sub, unsubscribe_token, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
    .run('dueno-id', 'dueno@ejemplo.com', 'Dueño', googleSub, 'baja-dueno-token', new Date().toISOString());
  const valor = 'token-de-sesion-del-dueno-de-prueba-123456';
  const { sha256 } = await import('../src/util.js');
  env.DB.db.prepare('INSERT OR REPLACE INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(await sha256(valor), 'dueno-id', Date.now() + 1e8, new Date().toISOString());
  c.ponerCookie('ds_sesion=' + valor);
  return c;
}
