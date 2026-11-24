// Página «Packs prearmados»: el cliente elige cuál pack quiere. El pedido se guarda en el navegador
// con el mismo formato que usa la portada ({ id: cantidad }), y «Ver mi pedido» abre el carrito allá.
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");
  const CLAVE = "donsticker-pedido";
  const GRUPOS = [
    { g: "10", texto: "10 stickers" }, { g: "25", texto: "25 stickers" },
    { g: "50", texto: "50 stickers" }, { g: "100", texto: "100 stickers" }, { g: "tematicos", texto: "Temáticos" },
  ];
  const validos = new Set(PACKS.map((p) => p.id));

  function leer() { try { return JSON.parse(localStorage.getItem(CLAVE) || "{}") || {}; } catch (e) { return {}; } }
  function guardar(pedido) { try { localStorage.setItem(CLAVE, JSON.stringify(pedido)); } catch (e) { /* sin almacenamiento */ } }
  let pedido = leer();
  window.DonPedido = { cantidad: (id) => Number(pedido[id]) || 0 };
  let grupo = (location.hash || "").replace("#", "");
  if (!GRUPOS.some((x) => x.g === grupo)) grupo = "10";

  const control = (p) => {
    const n = Number(pedido[p.id]) || 0;
    if (!n) return `<button type="button" class="agregar" data-sumar="${p.id}" aria-label="Agregar ${p.nombre} al pedido">Agregar</button>`;
    return `<div class="cantidad" role="group" aria-label="${p.nombre}">
      <button type="button" data-restar="${p.id}" aria-label="Quitar un ${p.nombre}">−</button>
      <span>${n}<span class="oculto"> en el pedido</span></span>
      <button type="button" data-sumar="${p.id}" aria-label="Agregar otro ${p.nombre}">+</button>
    </div>`;
  };

  function pintarPestanas() {
    $("#pestanas").innerHTML = GRUPOS.filter((x) => PACKS.some((p) => p.grupo === x.g))
      .map((x) => `<button type="button" class="chip" data-grupo="${x.g}" aria-pressed="${x.g === grupo}">${x.texto}</button>`).join("");
  }

  function pintarLista() {
    const lista = PACKS.filter((p) => p.grupo === grupo);
    $("#packs-cuenta").textContent = `${lista.length} packs`;
    $("#lista-packs").innerHTML = lista.map((p, i) => `<article class="tarjeta tarjeta--pack" data-id="${p.id}" style="--r:${i % 2 ? 1 : -1}deg">
        <button type="button" class="tarjeta__arte" data-ver="${p.id}" aria-label="Ver qué trae ${p.nombre}"><img src="${p.imagen}" alt="" loading="${i < 6 ? "eager" : "lazy"}" width="320" height="320"></button>
        <h3>${p.nombre}</h3>
        <p class="tarjeta__dato">${p.unidades} stickers · ${pesos(p.precio / p.unidades)} cada uno</p>
        <div class="tarjeta__pie">
          <span class="tarjeta__precio">${pesos(p.precio)}<small>${pesos(p.precioTransferencia)} transfiriendo</small></span>
          ${control(p)}
        </div>
      </article>`).join("");
    document.querySelectorAll("#lista-packs .tarjeta__arte img").forEach((img) => {
      if (img.complete) return;
      const caja = img.parentElement;
      caja.classList.add("cargando");
      const listo = () => caja.classList.remove("cargando");
      img.addEventListener("load", listo, { once: true });
      img.addEventListener("error", listo, { once: true });
    });
  }

  function pintarBarra() {
    const total = Object.values(pedido).reduce((a, n) => a + (Number(n) || 0), 0);
    $("#barra-pedido").hidden = total === 0;
    $("#bp-cantidad").textContent = total === 1 ? "1 producto" : `${total} productos`;
    $("#ir-pedido-n").textContent = total ? `(${total})` : "";
    $("#ir-pedido-n").classList.toggle("oculto", total === 0);
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const d = b.dataset;
    if (d.grupo) {
      grupo = d.grupo;
      history.replaceState(null, "", "#" + grupo);
      pintarPestanas();
      pintarLista();
      return;
    }
    const id = d.sumar || d.restar;
    if (!id || !validos.has(id)) return;
    const n = Math.max(0, Math.min(999, (Number(pedido[id]) || 0) + (d.sumar ? 1 : -1)));
    if (n) pedido[id] = n; else delete pedido[id];
    guardar(pedido);
    // El botón puede estar en la tarjeta o en la ventana de vista rápida (que se actualiza sola con «pedido:cambio»).
    const tarjeta = b.closest("#lista-packs [data-id]");
    const p = PACKS.find((x) => x.id === id);
    const enLista = document.querySelector(`#lista-packs [data-id="${id}"]`);
    const actual = enLista && enLista.querySelector(".agregar, .cantidad");
    if (actual) actual.outerHTML = control(p);
    if (tarjeta) {
      const foco = tarjeta.querySelector(`[data-sumar="${id}"]`);
      if (foco) foco.focus();
    }
    pintarBarra();
    if (d.sumar && window.Aviso) window.Aviso.mostrar(`Agregado: ${p.nombre}`, { clave: "pedido", accion: { texto: "Ver pedido", href: "/?carrito=1" } });
    document.dispatchEvent(new CustomEvent("pedido:cambio", { detail: { id } }));
  });

  window.addEventListener("hashchange", () => {
    const g = location.hash.replace("#", "");
    if (GRUPOS.some((x) => x.g === g) && g !== grupo) { grupo = g; pintarPestanas(); pintarLista(); }
  });
  // Si el pedido cambió en otra pestaña, se vuelve a leer.
  window.addEventListener("storage", () => { pedido = leer(); pintarLista(); pintarBarra(); document.dispatchEvent(new CustomEvent("pedido:cambio", { detail: {} })); });

  pintarPestanas();
  pintarLista();
  pintarBarra();
})();
