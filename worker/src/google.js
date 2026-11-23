// Verificación de "Continuar con Google" (Google Identity Services).
// El navegador recibe de Google un token firmado (ID token). Acá se comprueba la firma con las
// claves públicas de Google, el destinatario (nuestro ID de cliente), el vencimiento y el mail.

import { fetchExterno } from "./util.js";

const URL_CLAVES = "https://www.googleapis.com/oauth2/v3/certs";
const EMISORES = ["https://accounts.google.com", "accounts.google.com"];

let clavesEnMemoria = null; // { jwks, vence }

// Solo para las pruebas: vacía la copia en memoria de las claves de Google.
export const olvidarClavesDeGoogle = () => { clavesEnMemoria = null; };

const base64UrlABytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const decodificar = (s) => JSON.parse(new TextDecoder().decode(base64UrlABytes(s)));

async function obtenerClaves(env, forzar = false) {
  if (!forzar && clavesEnMemoria && clavesEnMemoria.vence > Date.now()) return clavesEnMemoria.jwks;
  try {
    const r = await fetchExterno(env, URL_CLAVES);
    if (!r.ok) throw Object.assign(new Error("claves de Google no disponibles"), { transitorio: true });
    const jwks = await r.json();
    clavesEnMemoria = { jwks, vence: Date.now() + 60 * 60 * 1000 };
    return jwks;
  } catch (e) {
    // Si Google no responde pero ya teníamos sus claves de hace un rato, se siguen usando: las claves
    // de firma cambian cada varios días, no cada hora. Una clave desconocida igual se rechaza.
    if (!forzar && clavesEnMemoria) return clavesEnMemoria.jwks;
    throw e;
  }
}

// Devuelve { sub, email, name } o lanza un Error con el motivo.
export async function verificarTokenGoogle(credencial, clientId, env) {
  if (!clientId) throw new Error("google_sin_configurar");
  const partes = String(credencial || "").split(".");
  if (partes.length !== 3) throw new Error("token_mal_formado");
  const [cabeceraB64, cargaB64, firmaB64] = partes;
  const cabecera = decodificar(cabeceraB64);
  if (cabecera.alg !== "RS256") throw new Error("algoritmo_no_permitido");

  let jwks = await obtenerClaves(env);
  let jwk = jwks.keys.find((k) => k.kid === cabecera.kid);
  if (!jwk) { jwks = await obtenerClaves(env, true); jwk = jwks.keys.find((k) => k.kid === cabecera.kid); }
  if (!jwk) throw new Error("clave_desconocida");

  const clave = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valida = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", clave, base64UrlABytes(firmaB64), new TextEncoder().encode(`${cabeceraB64}.${cargaB64}`));
  if (!valida) throw new Error("firma_invalida");

  const carga = decodificar(cargaB64);
  if (!EMISORES.includes(carga.iss)) throw new Error("emisor_invalido");
  if (carga.aud !== clientId) throw new Error("destinatario_invalido");
  if (!carga.exp || carga.exp * 1000 < Date.now()) throw new Error("token_vencido");
  if (!carga.sub || !carga.email) throw new Error("datos_incompletos");
  if (carga.email_verified !== true && carga.email_verified !== "true") throw new Error("mail_no_verificado");
  return { sub: String(carga.sub), email: String(carga.email).toLowerCase(), name: String(carga.name || "") };
}
