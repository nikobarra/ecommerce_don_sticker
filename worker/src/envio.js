// Cotización del envío con la API de MiCorreo (Correo Argentino).
// Las claves viven como secretos del Worker: nunca llegan al navegador.
//
// AMBIENTE: MICORREO_AMBIENTE vale "produccion" o "prueba". Cualquier otro valor, o su ausencia, se
// trata como PRUEBA. Una tarifa del ambiente de prueba se informa como no definitiva: se muestra como
// estimada, bloquea el cobro con Mercado Pago y el panel avisa que hay que confirmarla. Así una
// configuración olvidada en «prueba» no termina cobrando precios de mentira como si fueran reales.

import { json, limitarPor, ipDe, fetchExterno } from "./util.js";
import { tarifaRespaldo, ENVIO } from "./precios.js";

const DIMENSIONES_POR_DEFECTO = { height: 3, width: 18, length: 25 }; // cm, sobre chico de stickers
const PESO_MAXIMO = 25000; // gramos, límite de la API de MiCorreo
const VIDA_TOKEN_MS = 10 * 60 * 1000;
const VIDA_COTIZACION_S = 3600;
const BASE_PRUEBA = "https://apitest.correoargentino.com.ar/micorreo/v1";
const BASE_PRODUCCION = "https://api.correoargentino.com.ar/micorreo/v1";

// Consultas por IP al Correo cada 10 minutos. Solo cuentan las que NO salen de la caché.
const MAX_COTIZACIONES = 40;
const VENTANA_COTIZACIONES_S = 600;

let tokenEnMemoria = null; // { valor, vence }
let tokenEnCurso = null;
const cotizacionesEnCurso = new Map(); // misma consulta al mismo tiempo: una sola llamada al Correo

export const ambienteCorreo = (env) => (String(env.MICORREO_AMBIENTE || "").toLowerCase() === "produccion" ? "produccion" : "prueba");
const baseApi = (env) => (env.MICORREO_BASE || (ambienteCorreo(env) === "produccion" ? BASE_PRODUCCION : BASE_PRUEBA)).replace(/\/+$/, "");
export const correoConfigurado = (env) => Boolean(env.MICORREO_USER && env.MICORREO_PASSWORD && env.MICORREO_CUSTOMER_ID);

async function obtenerToken(env, forzar = false) {
  if (!forzar && tokenEnMemoria && tokenEnMemoria.vence > Date.now()) return tokenEnMemoria.valor;
  if (!forzar && tokenEnCurso) return tokenEnCurso;
  tokenEnCurso = (async () => {
    const basic = btoa(`${env.MICORREO_USER}:${env.MICORREO_PASSWORD}`);
    const r = await fetchExterno(env, `${baseApi(env)}/token`, { method: "POST", headers: { Authorization: `Basic ${basic}` } });
    if (!r.ok) throw new Error(`token ${r.status}`);
    const { token } = await r.json();
    if (!token) throw new Error("token vacío");
    tokenEnMemoria = { valor: token, vence: Date.now() + VIDA_TOKEN_MS };
    return token;
  })().finally(() => { tokenEnCurso = null; });
  return tokenEnCurso;
}

async function pedirTarifa(env, cp, gramos, intento = 0) {
  const token = await obtenerToken(env, intento > 0);
  const r = await fetchExterno(env, `${baseApi(env)}/rates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      customerId: env.MICORREO_CUSTOMER_ID,
      postalCodeOrigin: String(env.CP_ORIGEN || "7620"),
      postalCodeDestination: cp,
      deliveredType: "D", // entrega a domicilio
      dimensions: { weight: gramos, ...DIMENSIONES_POR_DEFECTO },
    }),
  });
  if (r.status === 401 && intento === 0) return pedirTarifa(env, cp, gramos, 1); // token vencido
  if (!r.ok) throw new Error(`rates ${r.status}`);
  const datos = await r.json();
  const tarifas = (datos.rates || []).filter((t) => typeof t.price === "number");
  if (!tarifas.length) throw new Error("sin tarifas");
  return tarifas.reduce((a, b) => (b.price < a.price ? b : a)); // la más barata
}

// Cotiza con el Correo y usa la caché. Lanza un error si el Correo no está disponible.
// `antesDeConsultar` se llama solo cuando hace falta salir al Correo (la caché no cuenta).
export async function cotizarCorreo(env, ctx, cp, gramos, { antesDeConsultar } = {}) {
  if (!correoConfigurado(env)) throw new Error("sin_configurar");
  const ambiente = ambienteCorreo(env);
  const gramosCotizados = Math.min(Math.ceil(gramos / 100) * 100, PESO_MAXIMO); // se agrupa de a 100 g para la caché
  const clave = `${baseApi(env)}/${env.CP_ORIGEN || "7620"}/${cp}/${gramosCotizados}`;
  const claveCache = new Request(`https://cache.donsticker/envio/${clave}`);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const guardada = cache ? await cache.match(claveCache) : null;
  if (guardada) return { ...(await guardada.json()), ambiente };

  if (cotizacionesEnCurso.has(clave)) return { ...(await cotizacionesEnCurso.get(clave)), ambiente };
  const tarea = (async () => {
    if (antesDeConsultar) await antesDeConsultar();
    const t = await pedirTarifa(env, cp, gramosCotizados);
    const recargo = Number(env.RECARGO_PORCENTAJE || 0);
    const resultado = { precio: Math.round(t.price * (1 + recargo / 100)), producto: t.productName || "Correo Argentino" };
    if (cache && ctx) {
      const respuesta = new Response(JSON.stringify(resultado), { headers: { "cache-control": `public, max-age=${VIDA_COTIZACION_S}` } });
      ctx.waitUntil(cache.put(claveCache, respuesta));
    }
    return resultado;
  })().finally(() => cotizacionesEnCurso.delete(clave));
  cotizacionesEnCurso.set(clave, tarea);
  return { ...(await tarea), ambiente };
}

// Costo de envío para un pedido: primero el Correo (solo si está en PRODUCCIÓN) y, si no responde o no está
// configurado, la tarifa fija por zona que definió el dueño (precios.js, ENVIO.zonas).
// fuente: "correo" (cotización real del Correo) | "zona" (tarifa por zona del dueño). Las dos son definitivas.
// Una tarifa del ambiente de PRUEBA del Correo nunca se usa: no es un precio real.
export async function costoEnvioPedido(env, ctx, { cp, provincia, stickers }) {
  const gramos = stickers * ENVIO.gramosPorSticker + ENVIO.gramosEmbalaje;
  if (ambienteCorreo(env) === "produccion") {
    try {
      const c = await cotizarCorreo(env, ctx, cp, gramos);
      return { precio: c.precio, fuente: "correo" };
    } catch (e) {
      if (e.message !== "sin_configurar") console.error("Cotización fallida:", e.message);
    }
  }
  const t = tarifaRespaldo(provincia, stickers);
  return t ? { precio: t.precio, fuente: "zona" } : null;
}

// ¿El costo de envío ya es el definitivo? Si no, el pedido no se puede cobrar en el momento.
// "estimado" y "correo_prueba" solo quedan en pedidos viejos.
export const envioDefinitivo = (fuente) => fuente === "correo" || fuente === "zona" || fuente === "gratis" || fuente === "";

// GET /api/envio?cp=7600&gramos=120
export async function rutaEnvio(request, env, ctx) {
  const url = new URL(request.url);
  const cp = (url.searchParams.get("cp") || "").trim();
  const gramos = Number(url.searchParams.get("gramos"));
  if (!/^\d{4}$/.test(cp)) return json({ error: "cp_invalido" }, 400);
  if (!Number.isInteger(gramos) || gramos < 1 || gramos > PESO_MAXIMO) return json({ error: "peso_invalido" }, 400);
  if (!correoConfigurado(env)) return json({ error: "sin_configurar" }, 503);
  try {
    const c = await cotizarCorreo(env, ctx, cp, gramos, {
      antesDeConsultar: async () => {
        if (env.DB && !(await limitarPor(env, "envio", ipDe(request), MAX_COTIZACIONES, VENTANA_COTIZACIONES_S))) throw new Error("limite");
      },
    });
    return json({ precio: c.precio, producto: c.producto, definitivo: c.ambiente === "produccion" }, 200, { "cache-control": `public, max-age=${VIDA_COTIZACION_S}` });
  } catch (e) {
    if (e.message === "limite") return json({ error: "demasiadas_consultas" }, 429, { "retry-after": String(VENTANA_COTIZACIONES_S) });
    console.error("Cotización fallida:", e.message); // sin claves ni datos del cliente
    return json({ error: "no_disponible" }, 502);
  }
}
