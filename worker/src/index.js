// Servicio de Don Sticker en Cloudflare.
// - Sirve la web (carpeta ../web) como archivos estáticos.
// - Expone la API en /api/*: cuentas, pedidos, panel del dueño y cotización del envío.
// - Responde la baja de novedades en /baja.
//
// Orden de cada petición dinámica: https y dominio canónico -> método y origen -> ruta -> cabeceras.

import { json, error, mercadoPagoActivo, limpiarVencidos } from "./util.js";
import { exigirDominioYHttps, conSeguridad, origenPermitido, METODOS_API } from "./seguridad.js";
import { rutaEnvio } from "./envio.js";
import { TEXTO_CONSENTIMIENTO, VERSION_CONSENTIMIENTO, registro, ingreso, salida, yo, olvide, restablecer, verificarMail, reenviarVerificacion, cambiarPassword, google } from "./auth.js";
import { crearPedido, misPedidos, miPedido, cancelarPedido } from "./pedidos.js";
import { listarPedidos, actualizarPedido, resumen } from "./admin.js";
import { crearPreferencia, webhookMercadoPago, estadoPago, conciliarPendientes, conciliarAdmin } from "./pagos.js";
import { registrarVisita } from "./visitas.js";
import { analiticas } from "./analiticas.js";
import { destacados } from "./destacados.js";
import { tareaNovedades, estadoNovedades, vistaPreviaNovedades, pruebaNovedades } from "./novedades.js";
import { recordatoriosDePago } from "./avisos.js";
import { reintentarFacturas, miFactura, facturarDesdePanel, notaCreditoDesdePanel, comprobanteDesdePanel, listarFacturas } from "./facturacion.js";
import { actualizarPerfil, misDatos, eliminarCuenta, baja } from "./cuenta.js";
import { crearSugerencia } from "./sugerencias.js";
import { accesoTaller } from './taller-acceso.js';
import { pedidosTaller } from './taller.js';

async function api(request, env, ctx, pathname) {
  const metodo = request.method;
  if (!METODOS_API.has(metodo)) return json({ error: "metodo_no_permitido", mensaje: "Método no permitido." }, 405, { allow: [...METODOS_API].join(", ") });
  if (!origenPermitido(request, pathname)) return error("origen_invalido", "Pedido no permitido.", 403);

  if (pathname === "/api/config" && metodo === "GET") {
    return json({ googleClientId: env.GOOGLE_CLIENT_ID || "", mercadoPago: mercadoPagoActivo(env), analitica: analiticaPublica(env), textoConsentimiento: TEXTO_CONSENTIMIENTO, versionConsentimiento: VERSION_CONSENTIMIENTO });
  }
  if (pathname === "/api/envio" && metodo === "GET") return rutaEnvio(request, env, ctx);
  if (pathname === "/api/destacados" && metodo === "GET") return destacados(env);

  if (!env.DB) return error("sin_base", "El servicio no está disponible.", 503);

  if (pathname.startsWith('/api/taller/') || pathname.startsWith('/api/admin/taller/')) {
    const acceso = await accesoTaller(request, env, pathname);
    if (acceso) return acceso;
    if (pathname === '/api/taller/pedidos' && metodo === 'GET') return pedidosTaller(request, env);
    const tallerPedido = pathname.match(/^\/api\/taller\/pedidos\/([0-9a-f-]{36})$/);
    if (tallerPedido && metodo === 'PATCH') return actualizarPedido(request, env, ctx, tallerPedido[1]);
    return error('no_encontrado', 'No existe esa función del taller.', 404);
  }

  // El aviso de Mercado Pago viene de sus servidores, no del navegador: no lleva sesión
  // y se valida por firma. Por eso va antes de todo lo demás.
  if (pathname === "/api/pagos/mercadopago" && metodo === "POST") return webhookMercadoPago(request, env, ctx);

  if (metodo === "POST") {
    switch (pathname) {
      case "/api/auth/registro": return registro(request, env, ctx);
      case "/api/auth/ingreso": return ingreso(request, env, ctx);
      case "/api/auth/salida": return salida(request, env);
      case "/api/auth/olvide": return olvide(request, env, ctx);
      case "/api/auth/restablecer": return restablecer(request, env);
      case "/api/auth/verificar": return verificarMail(request, env);
      case "/api/auth/reenviar": return reenviarVerificacion(request, env, ctx);
      case "/api/auth/password": return cambiarPassword(request, env);
      case "/api/auth/google": return google(request, env, ctx);
      case "/api/pedidos": return crearPedido(request, env, ctx);
      case "/api/sugerencias": return crearSugerencia(request, env);
      case "/api/visita": return registrarVisita(request, env);
      case "/api/admin/conciliar": return conciliarAdmin(request, env, ctx);
      case "/api/admin/novedades/prueba": return pruebaNovedades(request, env);
    }
    const facturar = pathname.match(/^\/api\/admin\/pedidos\/([0-9a-f-]{36})\/facturar$/);
    if (facturar) return facturarDesdePanel(request, env, ctx, facturar[1]);
    const nota = pathname.match(/^\/api\/admin\/pedidos\/([0-9a-f-]{36})\/nota-credito$/);
    if (nota) return notaCreditoDesdePanel(request, env, ctx, nota[1]);
    const cancelar = pathname.match(/^\/api\/pedidos\/([0-9a-f-]{36})\/cancelar$/);
    if (cancelar) return cancelarPedido(request, env, ctx, cancelar[1]);
    const pagar = pathname.match(/^\/api\/pedidos\/([0-9a-f-]{36})\/pago$/);
    if (pagar) return crearPreferencia(request, env, ctx, pagar[1]);
  }

  if (metodo === "GET" || metodo === "HEAD") {
    if (pathname === "/api/auth/yo") return yo(request, env);
    if (pathname === "/api/pedidos") return misPedidos(request, env);
    if (pathname === "/api/cuenta/datos") return misDatos(request, env);
    if (pathname === "/api/admin/pedidos") return listarPedidos(request, env);
    if (pathname === "/api/admin/resumen") return resumen(request, env);
    if (pathname === "/api/admin/analiticas") return analiticas(request, env);
    if (pathname === "/api/admin/novedades") return estadoNovedades(request, env);
    if (pathname === "/api/admin/novedades/vista-previa") return vistaPreviaNovedades(request, env);
    if (pathname === "/api/admin/facturas") return listarFacturas(request, env);
    const comprobante = pathname.match(/^\/api\/admin\/pedidos\/([0-9a-f-]{36})\/comprobante$/);
    if (comprobante) return comprobanteDesdePanel(request, env, comprobante[1]);
    const factura = pathname.match(/^\/api\/pedidos\/([0-9a-f-]{36})\/factura$/);
    if (factura) return miFactura(request, env, factura[1]);
    const uno = pathname.match(/^\/api\/pedidos\/([0-9a-f-]{36})$/);
    if (uno) return miPedido(request, env, uno[1]);
    const porNumero = pathname.match(/^\/api\/pedidos\/numero\/(DS-[A-Z0-9]{6})$/);
    if (porNumero) return estadoPago(request, env, ctx, porNumero[1]);
  }

  if (metodo === "PATCH") {
    if (pathname === "/api/cuenta") return actualizarPerfil(request, env);
    const admin = pathname.match(/^\/api\/admin\/pedidos\/([0-9a-f-]{36})$/);
    if (admin) return actualizarPedido(request, env, ctx, admin[1]);
  }

  if (metodo === "DELETE" && pathname === "/api/cuenta") return eliminarCuenta(request, env);

  return error("no_encontrado", "No existe esa dirección.", 404);
}

// Lo único de analítica que sabe el navegador: si está habilitada y con qué identificadores.
// Sin identificadores configurados no se carga nada ni se muestra ningún aviso.
function analiticaPublica(env) {
  const ga4 = String(env.GA4_ID || "").trim();
  const ads = String(env.ADS_ID || "").trim();
  const valido = (id, patron) => (patron.test(id) ? id : "");
  return { ga4: valido(ga4, /^G-[A-Z0-9]{4,20}$/), ads: valido(ads, /^AW-[0-9]{6,15}$/), etiquetaCompra: /^[A-Za-z0-9_-]{4,40}$/.test(env.ADS_ETIQUETA_COMPRA || "") ? env.ADS_ETIQUETA_COMPRA : "" };
}

// De vez en cuando (y en el cron, si se configura) se limpian sesiones, enlaces y contadores vencidos.
function mantenimientoOportunista(env, ctx) {
  if (!env.DB || Math.random() > 0.005) return;
  ctx?.waitUntil?.(limpiarVencidos(env).catch((e) => console.error("Limpieza fallida:", e.message)));
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const dinamica = pathname.startsWith("/api/") || pathname === "/baja";
    if (!dinamica) return env.ASSETS.fetch(request);

    const desvio = exigirDominioYHttps(request, env);
    if (desvio) return desvio;

    let respuesta;
    try {
      if (pathname === "/baja" && (request.method === "GET" || request.method === "POST")) respuesta = await baja(request, env);
      else respuesta = await api(request, env, ctx, pathname);
    } catch (e) {
      console.error("Error:", e.message); // sin datos del cliente
      respuesta = error("error_interno", "Algo salió mal de nuestro lado. Probá de nuevo.", 500);
    }
    mantenimientoOportunista(env, ctx);
    return conSeguridad(respuesta, request, env);
  },

  // Tarea periódica (Cron Trigger). Hay que declararla en la configuración de despliegue; ver el informe.
  async scheduled(_evento, env, ctx) {
    ctx.waitUntil(Promise.all([
      limpiarVencidos(env).catch((e) => console.error("Limpieza fallida:", e.message)),
      conciliarPendientes(env, ctx).catch((e) => console.error("Conciliación fallida:", e.message)),
      tareaNovedades(env).catch((e) => console.error("Novedades fallidas:", e.message)),
      recordatoriosDePago(env).catch((e) => console.error("Recordatorios de pago fallidos:", e.message)),
      reintentarFacturas(env, ctx, env.SITE_URL || "https://donsticker.com.ar").catch((e) => console.error("Facturas pendientes fallidas:", e.message)),
    ]));
  },
};
