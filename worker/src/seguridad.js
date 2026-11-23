// Seguridad de las respuestas DINÁMICAS del Worker (la API y /baja).
//
// Los archivos estáticos (HTML, JS, CSS, imágenes) los sirve Cloudflare sin pasar por el Worker y
// sus cabeceras salen de web/_headers: lo que se cambie acá NO las alcanza. Lo mismo vale para el
// redirect a https de las páginas: ver Docs/INFORME_AUDITORIA_WEB.md, sección «Pasos de borde».

import { error, esLocal } from "./util.js";

// 6 meses. Sin includeSubDomains ni preload: no se verificó que todos los subdominios (mail., news.,
// www.) respondan siempre por https, y el preload es prácticamente irreversible. Se sube por etapas.
export const HSTS = "max-age=15552000";

const CSP_JSON = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// /baja arma una página con un <style> en línea: es lo único que se permite, y solo ahí.
const CSP_HTML = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Agrega las cabeceras de seguridad sin pisar las que la respuesta ya trae.
export function conSeguridad(respuesta, request, env) {
  const cabeceras = new Headers(respuesta.headers);
  const poner = (k, v) => { if (!cabeceras.has(k)) cabeceras.set(k, v); };
  const esHtml = (cabeceras.get("content-type") || "").startsWith("text/html");

  poner("x-content-type-options", "nosniff");
  poner("x-frame-options", "DENY");
  poner("referrer-policy", "strict-origin-when-cross-origin");
  poner("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  poner("content-security-policy", esHtml ? CSP_HTML : CSP_JSON);
  poner("x-robots-tag", "noindex, nofollow");
  if (!esLocal(env) && new URL(request.url).protocol === "https:") poner("strict-transport-security", HSTS);

  return new Response(respuesta.body, { status: respuesta.status, statusText: respuesta.statusText, headers: cabeceras });
}

const redireccion = (destino, request, env) =>
  conSeguridad(new Response(null, { status: 308, headers: { location: destino, "cache-control": "no-store" } }), request, env);

// 1) Nada se procesa por http. Las lecturas se mandan a https con la misma ruta y consulta; todo lo
//    demás se rechaza SIN leer el cuerpo, porque una contraseña enviada por http ya viajó sin cifrar
//    y un redirect 308 la volvería a mandar: lo que hay que hacer es no aceptarla.
// 2) El dominio canónico es el de SITE_URL: www.<canónico> se redirige a él.
export function exigirDominioYHttps(request, env) {
  if (esLocal(env)) return null;
  const url = new URL(request.url);
  const lectura = request.method === "GET" || request.method === "HEAD";

  let canonico = null;
  try { canonico = env.SITE_URL ? new URL(env.SITE_URL) : null; } catch { canonico = null; }
  const desviado = Boolean(canonico) && url.hostname === `www.${canonico.hostname}`;

  if (url.protocol === "https:" && !desviado) return null;

  if (!lectura) {
    return conSeguridad(error(desviado ? "dominio_incorrecto" : "https_requerido", desviado ? "Usá la dirección principal del sitio." : "Este sitio solo funciona por https.", 403), request, env);
  }
  const destino = new URL(url);
  destino.protocol = "https:";
  destino.port = "";
  if (desviado) destino.hostname = canonico.hostname;
  return redireccion(destino.toString(), request, env);
}

// Política de origen para las peticiones que CAMBIAN algo (todo lo que no es GET/HEAD):
//  - Si el navegador declara Origin, tiene que ser exactamente este sitio (esquema + host + puerto).
//    Se compara el origen completo, no solo el host: http://sitio y https://sitio no son lo mismo.
//  - Si no hay Origin pero sí Sec-Fetch-Site, tiene que ser del mismo sitio o una acción directa del usuario.
//  - Si no hay ninguno de los dos, no viene de un navegador moderno: se rechaza, salvo las rutas que
//    no usan la sesión y reciben tráfico de servidores o de sendBeacon.
// Quedan fuera de la regla el aviso de Mercado Pago (servidor a servidor; se valida por firma) y la
// baja de mails (/baja no pasa por acá). Esos no dependen de la cookie, así que CSRF no aplica.
const SIN_ORIGEN_OBLIGATORIO = new Set(["/api/pagos/mercadopago"]);
const SIN_SESION = new Set(["/api/visita"]);

export function origenPermitido(request, pathname) {
  if (request.method === "GET" || request.method === "HEAD") return true;
  if (SIN_ORIGEN_OBLIGATORIO.has(pathname)) return true;
  const propio = new URL(request.url).origin;
  const origen = request.headers.get("origin");
  if (origen) return origen === propio;
  const sitio = request.headers.get("sec-fetch-site");
  if (sitio) return sitio === "same-origin" || sitio === "none";
  return SIN_SESION.has(pathname);
}

export const METODOS_API = new Set(["GET", "HEAD", "POST", "PATCH", "DELETE"]);
