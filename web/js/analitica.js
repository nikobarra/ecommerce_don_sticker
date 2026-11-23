// Analítica y atribución de campañas. APAGADA POR DEFECTO.
//
// Sin identificadores configurados en el servidor (GA4_ID / ADS_ID) este archivo no carga ningún script de
// terceros, no hace ninguna llamada de red y no muestra ningún aviso: solo recuerda los parámetros UTM de la
// visita para saber de qué campaña vino un pedido (dato propio, sin identificar a nadie).
//
// Con identificadores configurados:
//  - Antes de que la persona acepte, no se carga nada de Google.
//  - Se pide consentimiento con un aviso corto (sin ventana modal) y se puede cambiar desde el pie de la página.
//  - Los eventos llevan solo datos comerciales (producto, precio, total, número de pedido). Nunca nombre, mail,
//    dirección, teléfono, notas ni enlaces con tokens.
//  - `purchase` se manda solo cuando el pago está CONFIRMADO, con el número de pedido como transaction_id, una vez.
//
// Ver Docs/ANALITICA.md para activarla, la política de contenido (CSP) y cómo validarla.
(function () {
  "use strict";

  const CLAVE_PERMISO = "donsticker-medicion";      // "si" | "no"
  const CLAVE_ATRIBUCION = "donsticker-atribucion";  // sessionStorage: UTM de la visita
  const CLAVE_CLICS = "donsticker-clics";            // sessionStorage: identificadores de clic (solo con permiso)
  const CLAVE_COMPRAS = "donsticker-compras-medidas";
  const UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
  const CLICS = ["gclid", "gbraid", "wbraid"];

  const almacen = (tipo) => ({
    leer(k) { try { return window[tipo].getItem(k); } catch (e) { return null; } },
    guardar(k, v) { try { window[tipo].setItem(k, v); } catch (e) { /* sin almacenamiento */ } },
  });
  const local = almacen("localStorage");
  const sesion = almacen("sessionStorage");

  let config = { ga4: "", ads: "", etiquetaCompra: "" };
  let listo = false;
  const habilitada = () => Boolean(config.ga4 || config.ads);
  const permiso = () => local.leer(CLAVE_PERMISO) === "si";

  // ---------- Atribución: de qué campaña vino la visita ----------
  const limpio = (v, max, patron) => { const t = String(v || "").trim().slice(0, max); return t && patron.test(t) ? t : ""; };

  function capturar() {
    const params = new URLSearchParams(location.search);
    const utm = {};
    for (const k of UTM) { const v = limpio(params.get(k), 100, /^[\w.\-+ %]+$/); if (v) utm[k] = v; }
    // La primera campaña de la sesión manda; una visita interna sin parámetros no la borra.
    if (Object.keys(utm).length) sesion.guardar(CLAVE_ATRIBUCION, JSON.stringify(utm));
    // Los identificadores de clic de anuncios solo se guardan con permiso.
    if (permiso() && habilitada()) {
      const clics = {};
      for (const k of CLICS) { const v = limpio(params.get(k), 150, /^[\w-]+$/); if (v) clics[k] = v; }
      if (Object.keys(clics).length) sesion.guardar(CLAVE_CLICS, JSON.stringify(clics));
    }
  }

  function atribucion() {
    const leer = (k) => { try { return JSON.parse(sesion.leer(k) || "{}") || {}; } catch (e) { return {}; } };
    const a = { ...leer(CLAVE_ATRIBUCION) };
    if (permiso() && habilitada()) Object.assign(a, leer(CLAVE_CLICS));
    return Object.keys(a).length ? a : undefined;
  }

  // ---------- Qué se manda: lista blanca, sin datos personales ----------
  function sanear(datos) {
    const d = datos || {};
    const salida = {};
    for (const k of ["currency", "value", "transaction_id", "shipping", "payment_type", "item_list_id", "item_list_name", "contexto"]) {
      if (d[k] !== undefined && d[k] !== null && d[k] !== "") salida[k] = typeof d[k] === "number" ? d[k] : String(d[k]).slice(0, 80);
    }
    if (Array.isArray(d.items)) {
      salida.items = d.items.slice(0, 50).map((i) => ({
        item_id: String(i.item_id || "").slice(0, 60),
        item_name: String(i.item_name || "").slice(0, 100),
        item_category: String(i.item_category || "").slice(0, 60),
        price: Number(i.price) || 0,
        quantity: Number(i.quantity) || 1,
      }));
    }
    return salida;
  }

  // ---------- Carga de Google (solo con identificadores Y con permiso) ----------
  function cargarGoogle() {
    if (listo || !habilitada() || !permiso()) return;
    listo = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag("consent", "default", { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" });
    window.gtag("js", new Date());
    const principal = config.ga4 || config.ads;
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(principal);
    document.head.appendChild(s);
    // send_page_view false: la URL puede traer tokens en páginas de cuenta; solo se miden las páginas públicas a mano.
    if (config.ga4) window.gtag("config", config.ga4, { anonymize_ip: true, allow_google_signals: false, allow_ad_personalization_signals: false, send_page_view: false });
    if (config.ads) window.gtag("config", config.ads, { allow_ad_personalization_signals: false });
    window.gtag("consent", "update", { analytics_storage: "granted", ad_storage: "granted", ad_user_data: "granted", ad_personalization: "denied" });
    if (/^\/(index(\.html)?)?$/.test(location.pathname)) window.gtag("event", "page_view", { page_location: location.origin + location.pathname, page_title: document.title });
  }

  // ---------- Eventos ----------
  function evento(nombre, datos) {
    if (!habilitada() || !permiso()) return;
    cargarGoogle();
    if (typeof window.gtag === "function") window.gtag("event", nombre, sanear(datos));
  }

  // purchase = cobro CONFIRMADO. Se llama con un pedido de la API cuando ya está pago; se mide una sola vez por
  // navegador (y Google deduplica por transaction_id). Un pedido por transferencia se mide cuando el dueño lo
  // confirma y la persona vuelve a ver su pedido; un pedido de Mercado Pago, al volver o desde «Mi cuenta».
  const ESTADOS_COBRADOS = ["pago_confirmado", "preparando", "despachado", "entregado"];
  function compra(pedido) {
    if (!habilitada() || !permiso() || !pedido || !ESTADOS_COBRADOS.includes(pedido.estado)) return false;
    let medidas = [];
    try { medidas = JSON.parse(local.leer(CLAVE_COMPRAS) || "[]"); } catch (e) { medidas = []; }
    if (medidas.includes(pedido.numero)) return false;
    medidas.push(pedido.numero);
    local.guardar(CLAVE_COMPRAS, JSON.stringify(medidas.slice(-200)));
    const items = (pedido.items || []).map((i) => ({ item_id: i.id, item_name: i.nombre, item_category: i.tipo === "pack" ? "Packs" : "A elección", price: i.precio, quantity: i.cantidad }));
    evento("purchase", { transaction_id: pedido.numero, currency: "ARS", value: pedido.total, shipping: pedido.envio || 0, payment_type: pedido.pago, items });
    if (config.ads && config.etiquetaCompra && typeof window.gtag === "function") {
      window.gtag("event", "conversion", { send_to: `${config.ads}/${config.etiquetaCompra}`, value: pedido.total, currency: "ARS", transaction_id: pedido.numero });
    }
    return true;
  }

  // ---------- Aviso de consentimiento (solo si hay identificadores configurados) ----------
  function mostrarAviso() {
    if (document.getElementById("aviso-medicion")) return;
    const aviso = document.createElement("section");
    aviso.id = "aviso-medicion";
    aviso.className = "aviso-medicion";
    aviso.setAttribute("aria-label", "Medición de la web");
    aviso.innerHTML = `
      <p>Usamos una medición básica para saber qué se mira y de qué campaña llegan los pedidos. No guardamos tu nombre ni tu mail en esa medición. <a href="/privacidad#medicion">Más información</a></p>
      <div class="aviso-medicion__botones">
        <button type="button" class="boton boton--primario" data-medicion="si">Aceptar</button>
        <button type="button" class="boton boton--claro" data-medicion="no">No, gracias</button>
      </div>`;
    aviso.addEventListener("click", (e) => {
      const b = e.target.closest("[data-medicion]");
      if (!b) return;
      decidir(b.dataset.medicion === "si");
      aviso.remove();
    });
    document.body.append(aviso);
  }

  function decidir(acepta) {
    local.guardar(CLAVE_PERMISO, acepta ? "si" : "no");
    if (acepta) { capturar(); cargarGoogle(); } else { try { sessionStorage.removeItem(CLAVE_CLICS); } catch (e) { /* nada */ } }
  }

  // Enlace permanente en el pie para cambiar la decisión.
  function agregarPreferencias() {
    const lugar = document.querySelector(".pie__legal:last-of-type") || document.querySelector(".pie");
    if (!lugar || document.getElementById("preferencias-medicion")) return;
    const b = document.createElement("button");
    b.type = "button";
    b.id = "preferencias-medicion";
    b.className = "enlace enlace--pie";
    b.textContent = "Preferencias de medición";
    b.addEventListener("click", () => { local.guardar(CLAVE_PERMISO, ""); mostrarAviso(); });
    lugar.append(" ", b);
  }

  function iniciar(cfg) {
    config = { ga4: (cfg && cfg.ga4) || "", ads: (cfg && cfg.ads) || "", etiquetaCompra: (cfg && cfg.etiquetaCompra) || "" };
    if (!habilitada()) return;
    agregarPreferencias();
    const decision = local.leer(CLAVE_PERMISO);
    if (decision === "si") { capturar(); cargarGoogle(); } else if (decision !== "no") mostrarAviso();
  }

  capturar();
  document.addEventListener("cuenta:config", (e) => iniciar(e.detail && e.detail.analitica));
  window.Analitica = { evento, compra, atribucion, habilitada, permiso };
})();
