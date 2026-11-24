// Vista rápida: una ventana (<dialog> nativo) con el sticker en grande y zoom, o con lo que trae cada pack prearmado.
// Sirve en la portada (stickers a elección) y en packs.html (packs). Usa window.DonPedido, que publican app.js y packs.js,
// y el evento «pedido:cambio» para mostrar siempre la cantidad real del pedido.
(function () {
  "use strict";
  const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");
  const aTransferencia = (lista) => Math.round((lista * (1 - CONFIG.descuentoTransferencia)) / 10) * 10;
  const medir = (nombre, datos) => { try { if (window.Analitica) window.Analitica.evento(nombre, datos); } catch (e) { /* medir nunca rompe la compra */ } };

  const dlg = document.createElement("dialog");
  dlg.className = "modal vista";
  dlg.id = "vista";
  dlg.setAttribute("aria-labelledby", "vista-titulo");
  dlg.innerHTML = `
    <div class="modal__cabeza">
      <h2 id="vista-titulo"></h2>
      <button type="button" class="cerrar" data-vista-cerrar aria-label="Cerrar la vista">×</button>
    </div>
    <div class="modal__cuerpo vista__cuerpo" id="vista-cuerpo"></div>
    <p class="oculto" id="vista-anuncio" role="status" aria-live="polite"></p>`;
  document.body.appendChild(dlg);
  const cuerpo = dlg.querySelector("#vista-cuerpo");
  const titulo = dlg.querySelector("#vista-titulo");

  let actual = null; // { tipo: "sticker" | "pack", id, desde: { tipo, id } | null }
  let catalogoPendiente = null;

  const esPack = (id) => PACKS.some((p) => p.id === id);
  const diseno = (id) => (typeof PRODUCTOS !== "undefined" ? PRODUCTOS.find((p) => p.id === id) : null);
  const cantidad = (id) => (window.DonPedido ? window.DonPedido.cantidad(id) : 0);

  function control(id, nombre) {
    const n = cantidad(id);
    if (!n) return `<button type="button" class="agregar" data-sumar="${id}" aria-label="Agregar ${nombre} al pedido">Agregar al pedido</button>`;
    return `<div class="cantidad" role="group" aria-label="${nombre}">
      <button type="button" data-restar="${id}" aria-label="Quitar un ${nombre}">−</button>
      <span>${n}<span class="oculto"> en el pedido</span></span>
      <button type="button" data-sumar="${id}" aria-label="Agregar otro ${nombre}">+</button>
    </div>`;
  }

  // La portada ya carga el catálogo; packs.html lo trae recién cuando alguien abre un pack (pesa unos 84 KB comprimido).
  function cargarCatalogo() {
    if (typeof PRODUCTOS !== "undefined") return Promise.resolve();
    if (catalogoPendiente) return catalogoPendiente;
    catalogoPendiente = new Promise((ok, mal) => {
      const s = document.createElement("script");
      s.src = "js/catalogo.js";
      s.onload = ok;
      s.onerror = () => { catalogoPendiente = null; mal(new Error("catalogo")); };
      document.head.appendChild(s);
    });
    return catalogoPendiente;
  }

  // Los vecinos son las tarjetas que se ven ahora (respetan filtros y página): sirve para ir de a uno con ← y →.
  const vecinos = () => [...document.querySelectorAll("#grilla .tarjeta[data-id], #lista-packs .tarjeta[data-id]")].map((t) => t.dataset.id);

  function pintarControl() {
    const caja = cuerpo.querySelector("[data-vista-control]");
    if (!caja || !actual) return;
    const nombre = actual.tipo === "pack" ? (PACKS.find((p) => p.id === actual.id) || {}).nombre : (diseno(actual.id) || {}).nombre;
    const foco = document.activeElement && dlg.contains(document.activeElement) ? document.activeElement.getAttribute("data-sumar") ? "sumar" : "restar" : null;
    caja.innerHTML = control(actual.id, nombre || actual.id);
    if (foco) { const b = caja.querySelector(`[data-${foco}]`) || caja.querySelector("button"); if (b) b.focus(); }
  }

  function navegacion() {
    if (actual.desde) return `<button type="button" class="vista__nav vista__nav--volver" data-vista-volver>← Volver al pack</button>`;
    const ids = vecinos();
    const i = ids.indexOf(actual.id);
    if (i < 0 || ids.length < 2) return "";
    return `<div class="vista__nav">
      <button type="button" data-vista-ir="-1"${i === 0 ? " disabled" : ""}>← Anterior</button>
      <button type="button" data-vista-ir="1"${i === ids.length - 1 ? " disabled" : ""}>Siguiente →</button>
    </div>`;
  }

  function vistaSticker(p) {
    titulo.textContent = p.nombre;
    const cats = (p.categorias || [p.categoria]).join(", ");
    cuerpo.innerHTML = `
      <div class="vista__arte" data-vista-arte>
        <button type="button" class="vista__zoom" data-vista-zoom aria-label="Acercar el sticker" aria-pressed="false">
          <img src="${p.imagen}" alt="${p.nombre}">
        </button>
        <span class="vista__pista" aria-hidden="true">Tocá para acercar</span>
      </div>
      <p class="tarjeta__codigo">Código <strong>${p.id.toUpperCase()}</strong></p>
      <p class="tarjeta__dato">${cats} · ${CONFIG.tamano}</p>
      <p class="vista__precio">${pesos(CONFIG.precioUnitario)}<small>${pesos(aTransferencia(CONFIG.precioUnitario))} transfiriendo</small></p>
      <div class="vista__accion" data-vista-control>${control(p.id, p.nombre)}</div>
      ${navegacion()}`;
  }

  function vistaPack(p) {
    titulo.textContent = p.nombre;
    const ids = (typeof PACKS_CONTENIDO !== "undefined" && PACKS_CONTENIDO[p.id]) || [];
    cuerpo.innerHTML = `
      <div class="vista__arte vista__arte--pack"><img src="${p.imagen}" alt="${p.nombre}"></div>
      <p class="tarjeta__dato">${p.unidades} stickers · ${pesos(p.precio / p.unidades)} cada uno</p>
      <p class="vista__precio">${pesos(p.precio)}<small>${pesos(p.precioTransferencia)} transfiriendo</small></p>
      <div class="vista__accion" data-vista-control>${control(p.id, p.nombre)}</div>
      <h3 class="vista__subtitulo">Qué trae este pack</h3>
      <ul class="vista__lista" id="vista-contenido" aria-busy="true">
        ${ids.map(() => '<li class="esqueleto" aria-hidden="true"></li>').join("")}
      </ul>
      ${navegacion()}`;
    if (!ids.length) { cuerpo.querySelector("#vista-contenido").outerHTML = '<p class="nota">Este pack lo arma la casa con diseños surtidos.</p>'; return; }
    cargarCatalogo().then(() => {
      if (!actual || actual.id !== p.id) return;
      const lista = cuerpo.querySelector("#vista-contenido");
      if (!lista) return;
      lista.innerHTML = ids.map((id) => {
        const d = diseno(id);
        return d ? `<li><button type="button" class="vista__mini" data-vista-sticker="${d.id}" aria-label="Ver ${d.nombre} en grande">
            <img src="${d.imagen}" alt="" loading="lazy" width="120" height="120"><span>${d.nombre}</span></button></li>` : "";
      }).join("");
      lista.setAttribute("aria-busy", "false");
      lista.setAttribute("aria-label", `${ids.length} diseños de este pack`);
    }).catch(() => {
      const lista = cuerpo.querySelector("#vista-contenido");
      if (lista) lista.outerHTML = '<p class="nota">No pudimos cargar los diseños ahora. Probá de nuevo en un momento.</p>';
    });
  }

  function mostrar(tipo, id, desde) {
    actual = { tipo, id, desde: desde || null };
    dlg.classList.toggle("vista--pack", tipo === "pack");
    if (tipo === "pack") {
      const p = PACKS.find((x) => x.id === id);
      if (!p) return;
      vistaPack(p);
      medir("view_item", { currency: "ARS", value: p.precio, items: [{ item_id: p.id, item_name: p.nombre, item_category: "Packs", price: p.precio, quantity: 1 }] });
    } else {
      const p = diseno(id);
      if (!p) return;
      vistaSticker(p);
      medir("view_item", { currency: "ARS", value: CONFIG.precioUnitario, items: [{ item_id: p.id, item_name: p.nombre, item_category: p.categoria, price: CONFIG.precioUnitario, quantity: 1 }] });
    }
    cuerpo.scrollTop = 0;
    dlg.scrollTop = 0;
    dlg.querySelector("#vista-anuncio").textContent = titulo.textContent;
  }

  function abrir(tipo, id) {
    mostrar(tipo, id, null);
    if (!dlg.open) dlg.showModal();
  }

  // ---------- Zoom ----------
  function alternarZoom(forzar) {
    const arte = cuerpo.querySelector("[data-vista-arte]");
    if (!arte) return;
    const activo = typeof forzar === "boolean" ? forzar : !arte.classList.contains("zoom");
    arte.classList.toggle("zoom", activo);
    const b = arte.querySelector("[data-vista-zoom]");
    b.setAttribute("aria-pressed", String(activo));
    b.setAttribute("aria-label", activo ? "Alejar el sticker" : "Acercar el sticker");
    const pista = arte.querySelector(".vista__pista");
    if (pista) pista.textContent = activo ? "Movelo para ver los detalles" : "Tocá para acercar";
  }
  function moverZoom(e) {
    const arte = e.target.closest && e.target.closest("[data-vista-arte].zoom");
    if (!arte) return;
    const r = arte.getBoundingClientRect();
    arte.style.setProperty("--zx", Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)) + "%");
    arte.style.setProperty("--zy", Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100)) + "%");
  }
  dlg.addEventListener("pointermove", moverZoom);

  // ---------- Eventos ----------
  document.addEventListener("click", (e) => {
    const ver = e.target.closest("[data-ver]");
    if (ver) { abrir(esPack(ver.dataset.ver) ? "pack" : "sticker", ver.dataset.ver); }
  });

  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) { dlg.close(); return; }
    const b = e.target.closest("button");
    if (!b || !actual) return;
    if (b.hasAttribute("data-vista-cerrar")) dlg.close();
    else if (b.hasAttribute("data-vista-zoom")) alternarZoom();
    else if (b.dataset.vistaSticker) mostrar("sticker", b.dataset.vistaSticker, { tipo: "pack", id: actual.id });
    else if (b.hasAttribute("data-vista-volver")) mostrar(actual.desde.tipo, actual.desde.id, null);
    else if (b.dataset.vistaIr) {
      const ids = vecinos();
      const sig = ids[ids.indexOf(actual.id) + Number(b.dataset.vistaIr)];
      if (sig) { mostrar(actual.tipo, sig, null); const nuevo = cuerpo.querySelector(`[data-vista-ir="${b.dataset.vistaIr}"]:not([disabled])`) || cuerpo.querySelector("[data-vista-zoom]"); if (nuevo) nuevo.focus(); }
    }
  });

  dlg.addEventListener("keydown", (e) => {
    if (!actual || actual.desde || e.target.closest("input, select, textarea")) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const b = cuerpo.querySelector(`[data-vista-ir="${e.key === "ArrowLeft" ? -1 : 1}"]:not([disabled])`);
      if (b) { e.preventDefault(); b.click(); }
    }
  });

  dlg.addEventListener("close", () => { actual = null; });
  document.addEventListener("pedido:cambio", pintarControl);
})();
