(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");
  const CLAVE = "donsticker-pedido";
  const CLAVE_BORRADOR = "donsticker-borrador";
  const TODO = [...PACKS, ...PRODUCTOS]; // todo lo que se puede pedir
  const esPack = (id) => PACKS.some((p) => p.id === id);
  const nombreDe = (id) => (TODO.find((p) => p.id === id) || {}).nombre || id;

  // Analítica: si no está habilitada (sin identificadores configurados), estas llamadas no hacen nada.
  const medir = (nombre, datos) => { try { if (window.Analitica) window.Analitica.evento(nombre, datos); } catch (e) { /* medir nunca rompe la compra */ } };

  // El almacenamiento del navegador puede no estar (modo privado, bloqueado): todo funciona igual sin él.
  const almacen = {
    leer(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    guardar(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } },
    borrar(k) { try { localStorage.removeItem(k); } catch (e) { /* sin almacenamiento */ } },
  };

  // ---------- Estado del pedido: { id: cantidad } ----------
  let pedido = {};
  try {
    const guardado = JSON.parse(almacen.leer(CLAVE) || "{}");
    for (const p of TODO) {
      const n = Number(guardado[p.id]);
      if (Number.isInteger(n) && n > 0) pedido[p.id] = n;
    }
  } catch (e) { pedido = {}; }

  const guardar = () => almacen.guardar(CLAVE, JSON.stringify(pedido));
  // Lo usa la vista rápida (js/vista.js) para mostrar la cantidad real; avisa cada cambio con el evento «pedido:cambio».
  window.DonPedido = { cantidad: (id) => pedido[id] || 0 };
  const sinMovimiento = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ---------- Anuncios para lectores de pantalla ----------
  // Un solo mensaje corto por acción. Con el carrito abierto el resto de la página está inerte, así que
  // el anuncio sale de la zona que está dentro del carrito.
  const carrito = $("#carrito");
  let temporizadorAnuncio = null;
  function anunciar(texto) {
    const zona = carrito.open ? $("#anuncio-carrito") : $("#anuncio");
    zona.textContent = "";
    clearTimeout(temporizadorAnuncio);
    temporizadorAnuncio = setTimeout(() => { zona.textContent = texto; }, 60);
  }

  // ---------- Precios ----------
  // Hay dos precios: el de LISTA (el que se publica y el que se cobra por Mercado Pago)
  // y el de TRANSFERENCIA, más barato. El medio de pago se elige en el carrito.
  let medioDePago = "transferencia";
  const esTransferencia = (pago) => pago === "transferencia";

  // Todos los totales se redondean al $10 más cercano. Misma fórmula que worker/src/precios.js.
  const redondear10 = (n) => Math.round(n / 10) * 10;
  const precioUnitarioLista = (cantidad) => {
    let precio = CONFIG.precioUnitario;
    for (const t of CONFIG.tramos) if (cantidad >= t.desde) precio = t.precio;
    return precio;
  };
  const aTransferencia = (lista) => redondear10(lista * (1 - CONFIG.descuentoTransferencia));
  // Los stickers a elección: la cantidad completa toma el precio por unidad de su tramo (10, 25, 50, 100).
  const totalSueltos = (cantidad, pago) => {
    const lista = cantidad * precioUnitarioLista(cantidad);
    return esTransferencia(pago) ? aTransferencia(lista) : lista;
  };
  const precioSuelto = (cantidad, pago) => (cantidad > 0 ? Math.round(totalSueltos(cantidad, pago) / cantidad) : CONFIG.precioUnitario);
  const precioPack = (p, pago) => (esTransferencia(pago) ? p.precioTransferencia : p.precio);

  function resumen() {
    const sueltos = PRODUCTOS.reduce((a, p) => a + (pedido[p.id] || 0), 0);
    const unitario = precioSuelto(sueltos, medioDePago);
    const unitarioLista = precioUnitarioLista(sueltos);
    const totalSueltosPago = totalSueltos(sueltos, medioDePago);
    const totalSueltosLista = totalSueltos(sueltos, "mercadopago");
    const packs = PACKS.reduce((a, p) => a + (pedido[p.id] || 0), 0);
    const totalPacks = PACKS.reduce((a, p) => a + (pedido[p.id] || 0) * precioPack(p, medioDePago), 0);
    const totalPacksLista = PACKS.reduce((a, p) => a + (pedido[p.id] || 0) * p.precio, 0);
    const total = totalSueltosPago + totalPacks;
    const totalLista = totalSueltosLista + totalPacksLista;
    const stickers = sueltos + PACKS.reduce((a, p) => a + (pedido[p.id] || 0) * p.unidades, 0);
    return {
      sueltos, unitario, unitarioLista, totalSueltos: totalSueltosPago, totalSueltosLista,
      packs, totalPacks, totalPacksLista, total, totalLista, descuento: totalLista - total,
      stickers, items: sueltos + packs,
    };
  }

  // ---------- Textos fijos que salen de los datos ----------
  const lugares = CONFIG.puntosDeEntrega.join(" o ");
  const poner = (attr, texto) => document.querySelectorAll(`[${attr}]`).forEach((el) => (el.textContent = texto));
  poner("data-lugares", lugares);
  poner("data-unitario", pesos(CONFIG.precioUnitario));
  poner("data-unitario-transferencia", pesos(aTransferencia(CONFIG.precioUnitario)));
  poner("data-tramo-minimo", pesos(CONFIG.tramos[CONFIG.tramos.length - 1].precio));
  poner("data-cantidad-disenos", `${PRODUCTOS.length} diseños`);
  // Contacto: se toma de la configuración, así no queda desactualizado.
  const wa = String(CONFIG.whatsapp || "");
  document.querySelectorAll("[data-whatsapp]").forEach((el) => {
    el.href = `https://wa.me/${wa}`;
    el.target = "_blank";
    el.rel = "noopener";
    el.textContent = wa.replace(/^(\d{2})(\d)(\d{4})(\d+)$/, "+$1 $2 $3 $4");
    el.addEventListener("click", () => medir("contacto_whatsapp", { contexto: "contacto" }));
  });
  document.querySelectorAll("[data-email-enlace]").forEach((el) => {
    el.href = `mailto:${CONFIG.email}`;
    el.textContent = CONFIG.email;
  });

  // ---------- Tabla de precios ----------
  $("#escalones").innerHTML = [{ desde: 1, hasta: 9, precio: CONFIG.precioUnitario }, ...CONFIG.tramos.map((t, i, a) => ({ desde: t.desde, hasta: i < a.length - 1 ? a[i + 1].desde - 1 : null, precio: t.precio }))]
    .map((t, i, todos) => `
    <div class="escalon${i === todos.length - 1 ? " escalon--destacado" : ""}">
      <p class="escalon__cant">${t.hasta === null ? `${t.desde} o más` : t.desde === t.hasta ? `${t.desde}` : `${t.desde} a ${t.hasta}`} a elección</p>
      <p class="escalon__precio">${pesos(t.precio)}</p>
      <p class="escalon__nota">cada uno. Elegís los diseños.</p>
      <p class="escalon__transferencia">${pesos(t.precio * (1 - CONFIG.descuentoTransferencia))} por transferencia</p>
    </div>`).join("");

  // ---------- Control de cantidad (packs, catálogo y carrito) ----------
  function controlCantidad(id, nombre) {
    const n = pedido[id] || 0;
    if (!n) return `<button type="button" class="agregar" data-sumar="${id}" aria-label="Agregar ${nombre} al pedido">Agregar</button>`;
    return `<div class="cantidad" role="group" aria-label="${nombre}">
      <button type="button" data-restar="${id}" aria-label="Quitar un ${nombre}">−</button>
      <span>${n}<span class="oculto"> en el pedido</span></span>
      <button type="button" data-sumar="${id}" aria-label="Agregar otro ${nombre}">+</button>
    </div>`;
  }

  // ---------- Packs prearmados ----------
  // En la portada cada tamaño es un acceso a packs.html, donde el cliente elige cuál pack quiere.
  const GRUPOS_PACKS = [
    { g: "10", titulo: "Packs de 10", unidades: 10 },
    { g: "25", titulo: "Packs de 25", unidades: 25 },
    { g: "50", titulo: "Packs de 50", unidades: 50 },
    { g: "100", titulo: "Packs de 100", unidades: 100 },
    { g: "tematicos", titulo: "Packs temáticos", unidades: 0 },
  ];
  function pintarPacks() {
    $("#grilla-packs").innerHTML = GRUPOS_PACKS.map((gr, i) => {
      const lista = PACKS.filter((p) => p.grupo === gr.g);
      if (!lista.length) return "";
      const desde = Math.min(...lista.map((p) => p.precio));
      const arte = `<img src="assets/packs/${gr.unidades ? "tramo-" + gr.unidades : "tema-simpson-10"}.webp" alt="" loading="lazy" width="320" height="320">`;
      const detalle = gr.unidades
        ? `${lista.length} packs prearmados de ${gr.unidades} stickers`
        : `${lista.length} packs de una sola temática`;
      return `<a class="tarjeta tarjeta--pack tarjeta--enlace" href="/packs#${gr.g}" data-id="grupo-${gr.g}" style="--r:${i % 2 ? 1.5 : -1.5}deg">
        <div class="tarjeta__arte">${arte}</div>
        <h3>${gr.titulo}</h3>
        <p class="tarjeta__dato">${detalle}</p>
        <div class="tarjeta__pie">
          <span class="tarjeta__precio">${gr.unidades ? "" : "Desde "}${pesos(desde)}<small>${pesos(aTransferencia(desde))} transfiriendo</small></span>
          <span class="agregar agregar--ver" aria-hidden="true">Ver packs</span>
        </div>
      </a>`;
    }).join("");
  }

  // ---------- Catálogo a elección ----------
  let categoria = "Todos";
  let busqueda = "";
  // Un diseño puede estar en varias temáticas (p. ej. Los Simpson y Exclusivos).
  const categoriasDe = (p) => p.categorias || [p.categoria];
  // «Novedades»: los últimos 100 diseños que entraron por catalogo/nuevos. Al llegar el 101, el más viejo
  // sale de Novedades y queda solo en sus temáticas.
  const NOVEDADES_MAX = 100;
  const NOVEDADES = new Set(PRODUCTOS.filter((p) => p.nuevo)
    .sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "") || (b.numero || 0) - (a.numero || 0))
    .slice(0, NOVEDADES_MAX).map((p) => p.id));
  const categorias = ["Todos", ...(NOVEDADES.size ? ["Novedades"] : []), ...new Set(PRODUCTOS.flatMap(categoriasDe))];
  const enCategoria = (p) => categoria === "Todos" || (categoria === "Novedades" ? NOVEDADES.has(p.id) : categoriasDe(p).includes(categoria));

  $("#categorias").innerHTML = categorias
    .map((c) => `<button type="button" class="chip" data-cat="${c}" aria-pressed="${c === categoria}">${c}</button>`)
    .join("");
  // En celular, las temáticas van en un desplegable (los 22 chips ocupaban media pantalla).
  const selCategoria = $("#categoria-select");
  selCategoria.innerHTML = categorias
    .map((c) => `<option value="${c}">${c === "Todos" ? "Todas las temáticas" : c}</option>`)
    .join("");

  // ---------- Paginación ----------
  // Escritorio: páginas numeradas. Celular: «Ver más» suma otra tanda debajo, sin perder lo que ya se vio.
  const POR_PAGINA = 24;
  const escritorio = window.matchMedia("(min-width: 821px)");
  let pagina = 1;
  let visibles = POR_PAGINA;
  const reiniciarPaginas = () => { pagina = 1; visibles = POR_PAGINA; };

  function elegirCategoria(c) {
    categoria = c;
    document.querySelectorAll(".chip").forEach((ch) => ch.setAttribute("aria-pressed", ch.dataset.cat === categoria));
    selCategoria.value = c;
    reiniciarPaginas();
    anunciarResultados(pintarCatalogo());
  }

  // Números de página a mostrar: la primera, la última y las vecinas de la actual, con «…» en los saltos.
  function paginasVisibles(actual, total) {
    const orden = [...new Set([1, total, actual - 1, actual, actual + 1])].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
    const salida = [];
    orden.forEach((n, i) => { if (i && n - orden[i - 1] > 1) salida.push("…"); salida.push(n); });
    return salida;
  }

  function pintarPaginas(total, paginas, hasta) {
    const nav = $("#paginas");
    const mas = $("#ver-mas");
    if (escritorio.matches) {
      mas.hidden = true;
      nav.hidden = paginas <= 1;
      nav.innerHTML = paginas <= 1 ? "" :
        `<button type="button" class="pagina-btn" data-pagina="${pagina - 1}"${pagina === 1 ? " disabled" : ""}>Anterior</button>` +
        paginasVisibles(pagina, paginas).map((n) => n === "…"
          ? '<span class="pagina-salto" aria-hidden="true">…</span>'
          : `<button type="button" class="pagina-btn" data-pagina="${n}" aria-label="Página ${n}"${n === pagina ? ' aria-current="page"' : ""}>${n}</button>`).join("") +
        `<button type="button" class="pagina-btn" data-pagina="${pagina + 1}"${pagina === paginas ? " disabled" : ""}>Siguiente</button>`;
    } else {
      nav.hidden = true;
      nav.innerHTML = "";
      const quedan = total - hasta;
      mas.hidden = quedan <= 0;
      $("#btn-ver-mas").textContent = `Ver más diseños (quedan ${quedan})`;
    }
  }

  const normalizar = (t) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Orden: "novedades" = fecha de alta más reciente primero (y, a igualdad, el número de diseño más alto).
  let orden = "novedades";
  const COMPARAR = {
    novedades: (a, b) => (b.fecha || "").localeCompare(a.fecha || "") || (b.numero || 0) - (a.numero || 0),
    nombre: (a, b) => a.nombre.localeCompare(b.nombre, "es"),
  };

  function pintarCatalogo() {
    const q = normalizar(busqueda.trim());
    const lista = PRODUCTOS.filter((p) =>
      enCategoria(p) &&
      (!q || (p.busqueda || normalizar(p.nombre + " " + p.categoria)).includes(q)))
      .sort(COMPARAR[orden]);

    const total = lista.length;
    const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    if (pagina > paginas) pagina = paginas;
    const desde = escritorio.matches ? (pagina - 1) * POR_PAGINA : 0;
    const hasta = escritorio.matches ? Math.min(total, pagina * POR_PAGINA) : Math.min(total, visibles);

    $("#grilla").innerHTML = lista.slice(desde, hasta).map((p, i) => {
      const arte = p.imagen
        ? `<img src="${p.imagen}" alt="" loading="lazy">`
        : `<div class="muestra" style="--c:${p.color};--r:${i % 2 ? 5 : -5}deg" aria-hidden="true">${p.texto}</div>`;
      return `<article class="tarjeta" data-id="${p.id}">
        ${p.exclusivo ? '<span class="etiqueta">De la casa</span>' : NOVEDADES.has(p.id) ? '<span class="etiqueta">Nuevo</span>' : ""}
        <button type="button" class="tarjeta__arte" data-ver="${p.id}" aria-label="Ver ${p.nombre} en grande">${arte}</button>
        <h3>${p.nombre}</h3>
        <p class="tarjeta__codigo">Código <strong>${p.id.toUpperCase()}</strong></p>
        <p class="tarjeta__dato">${categoriasDe(p).join(", ")} · ${CONFIG.tamano}</p>
        <div class="tarjeta__pie">
          <span class="tarjeta__precio">${pesos(CONFIG.precioUnitario)}<small>${pesos(aTransferencia(CONFIG.precioUnitario))} transfiriendo</small></span>
          ${controlCantidad(p.id, p.nombre)}
        </div>
      </article>`;
    }).join("");
    esqueletos($("#grilla"));
    $("#sin-resultados").hidden = total > 0;
    $("#catalogo-cuenta").textContent = !total ? "" : total === 1 ? "1 diseño" : `Mostrando ${desde + 1} a ${hasta} de ${total} diseños`;
    pintarPaginas(total, paginas, hasta);
    return total;
  }

  // Al filtrar se anuncia la CANTIDAD de resultados, una vez y con una pausa: la grilla entera no es una zona en vivo.
  let temporizadorFiltro = null;
  function anunciarResultados(n) {
    clearTimeout(temporizadorFiltro);
    temporizadorFiltro = setTimeout(() => anunciar(n === 0 ? "No encontré ese diseño." : n === 1 ? "1 diseño." : `${n} diseños.`), 500);
  }

  // Mientras una imagen carga, su cuadro muestra un esqueleto brillante (clase «cargando»). Sin JS o con la imagen ya
  // en caché no se agrega nada, así que nunca queda un esqueleto pegado.
  function esqueletos(raiz) {
    raiz.querySelectorAll(".tarjeta__arte img").forEach((img) => {
      if (img.complete) return;
      const caja = img.parentElement;
      caja.classList.add("cargando");
      const listo = () => caja.classList.remove("cargando");
      img.addEventListener("load", listo, { once: true });
      img.addEventListener("error", listo, { once: true });
    });
  }

  // Respuesta al sumar: el contador del botón «Mi pedido» rebota y, si se ve la tarjeta, el sticker vuela hasta el carrito.
  function rebotar(el) {
    if (!el || sinMovimiento.matches) return;
    el.classList.remove("rebota");
    void el.offsetWidth; // reinicia la animación aunque se sume rápido
    el.classList.add("rebota");
    el.addEventListener("animationend", () => el.classList.remove("rebota"), { once: true });
  }
  function volarAlCarrito(origen) {
    if (sinMovimiento.matches || !origen || document.querySelector("dialog[open]")) return;
    const img = origen.querySelector("img");
    const meta = $("#abrir-carrito");
    if (!img || !meta) return;
    const a = img.getBoundingClientRect();
    const b = meta.getBoundingClientRect();
    if (!a.width || a.bottom < 0 || a.top > innerHeight) return;
    const vuelo = img.cloneNode(false);
    vuelo.className = "vuelo";
    vuelo.setAttribute("aria-hidden", "true");
    vuelo.style.cssText = `left:${a.left}px;top:${a.top}px;width:${a.width}px;height:${a.height}px`;
    document.body.appendChild(vuelo);
    const dx = b.left + b.width / 2 - (a.left + a.width / 2);
    const dy = b.top + b.height / 2 - (a.top + a.height / 2);
    const anim = vuelo.animate(
      [{ transform: "translate(0,0) scale(1)", opacity: 1 }, { transform: `translate(${dx}px,${dy}px) scale(.12)`, opacity: .4 }],
      { duration: 560, easing: "cubic-bezier(.5,-0.2,.7,.4)" });
    anim.onfinish = () => { vuelo.remove(); rebotar($("#contador")); rebotar($("#abrir-carrito")); };
  }

  // ---------- Carrito ----------
  function pintarCarrito() {
    const r = resumen();
    // Barra fija abajo (celular): cuánto lleva y un acceso directo al pedido.
    $("#barra-pedido").hidden = r.items === 0;
    document.body.classList.toggle("con-barra-pedido", r.items > 0);
    $("#bp-cantidad").textContent = r.items === 1 ? "1 producto" : `${r.items} productos`;
    $("#bp-total").textContent = `· ${pesos(r.total)}${esTransferencia(medioDePago) ? " por transferencia" : ""}`;
    $("#contador").textContent = r.items;
    $("#contador-texto").textContent = r.items === 0 ? ", vacío" : r.items === 1 ? ", 1 producto" : `, ${r.items} productos`;
    if (r.items > 0) $("#pedido-hecho").hidden = true; // si empieza otro pedido, se oculta la confirmación anterior
    $("#carrito-vacio").hidden = r.items > 0 || !$("#pedido-hecho").hidden;
    $("#carrito-detalle").hidden = r.items === 0;

    $("#lineas").innerHTML = TODO.filter((p) => pedido[p.id]).map((p) => `<li class="linea">
        <span class="linea__nombre">${p.nombre}${esPack(p.id) ? ' <small>prearmado</small>' : ` <small class="linea__codigo">${p.id.toUpperCase()}</small>`}</span>
        ${controlCantidad(p.id, p.nombre)}
        <button type="button" class="quitar" data-quitar="${p.id}" aria-label="Sacar ${p.nombre} del pedido">Sacar</button>
      </li>`).join("");

    if (!r.items) return;

    // Aviso del precio por cantidad: el tramo alcanzado y cuánto falta para el siguiente.
    const aviso = $("#aviso-escalon");
    const sig = CONFIG.tramos.find((t) => t.desde > r.sueltos);
    const partes = [];
    if (r.sueltos >= CONFIG.tramos[0].desde) partes.push(`Tus ${r.sueltos} stickers a elección quedan a ${pesos(r.unitario)} cada uno.`);
    aviso.textContent = partes.join(" ");
    aviso.hidden = partes.length === 0;
    pintarProgreso(r.sueltos);

    // Las líneas muestran el precio de lista, y abajo se resta el descuento: así se ve lo que se ahorra.
    $("#fila-sueltos").hidden = r.sueltos === 0;
    $("#t-sueltos-detalle").textContent = `${r.sueltos} a elección × ${pesos(r.unitarioLista)}`;
    $("#t-sueltos").textContent = pesos(r.totalSueltosLista);
    $("#fila-packs").hidden = r.packs === 0;
    $("#t-packs-detalle").textContent = r.packs === 1 ? "1 pack prearmado" : `${r.packs} packs prearmados`;
    $("#t-packs").textContent = pesos(r.totalPacksLista);
    $("#fila-descuento").hidden = r.descuento === 0;
    $("#t-descuento").textContent = "−" + pesos(r.descuento);
    const e = costoEnvio(r);
    const conEnvio = e.cobra && e.costo !== null;
    $("#fila-subtotal").hidden = !conEnvio && r.descuento === 0;
    $("#t-subtotal").textContent = pesos(r.total);
    $("#t-total").textContent = pesos(r.total + (conEnvio ? e.costo : 0));
    $("#t-envio").textContent = textoEnvio(r);
    $("#nota-envio").hidden = !e.cobra;
    pintarTextosDelMedio();
    // Si hubo que volver a transferencia, los totales cambian: se vuelven a pintar una vez.
    if (pintarPago(e)) pintarCarrito();
  }

  // Barra de progreso hacia el siguiente precio por cantidad (solo cuenta los stickers a elección).
  function pintarProgreso(sueltos) {
    const caja = $("#progreso");
    if (!caja) return;
    if (sueltos === 0) { caja.hidden = true; const m0 = $("#bp-progreso-barra"); if (m0) m0.style.width = "0%"; return; }
    const sig = CONFIG.tramos.find((t) => t.desde > sueltos);
    const base = [...CONFIG.tramos].reverse().find((t) => t.desde <= sueltos);
    const desde = base ? base.desde : 0;
    const pct = sig ? Math.round(((sueltos - desde) / (sig.desde - desde)) * 100) : 100;
    caja.hidden = false;
    $("#progreso-texto").textContent = sig
      ? `Llevás ${sueltos} a elección: sumá ${sig.desde - sueltos} y cada uno sale ${pesos(sig.precio)}`
      : `¡Precio mínimo! Tus ${sueltos} a elección salen ${pesos(precioUnitarioLista(sueltos))} cada uno`;
    $("#progreso-barra").style.width = pct + "%";
    const mini = $("#bp-progreso-barra");
    if (mini) mini.style.width = pct + "%";
    caja.querySelector('[role="progressbar"]').setAttribute("aria-valuenow", String(pct));
    caja.classList.toggle("meta--completa", !sig);
  }

  // El texto de abajo y el botón dicen lo que realmente va a pasar según cómo se paga.
  function pintarTextosDelMedio() {
    const mp = medioDePago === "mercadopago";
    $("#btn-confirmar").textContent = mp ? "Confirmar y pagar con Mercado Pago" : "Confirmar mi pedido";
    $("#nota-medio").textContent = mp
      ? "Al confirmar te llevamos a Mercado Pago para pagar, con 3 cuotas sin interés. Tu pedido queda guardado: si el pago se corta, lo retomás desde Mi cuenta."
      : "No se paga acá. Te respondemos con los datos para la transferencia. Tu pedido queda guardado en tu cuenta.";
  }

  // ---------- Medio de pago ----------
  // Mercado Pago solo aparece si está configurado en el servidor. Además necesita el total
  // cerrado: con un envío estimado (el Correo no cotizó) se cobraría un importe que después cambia.
  function pintarPago(e) {
    const hayMercadoPago = Boolean(window.Cuenta && window.Cuenta.config && window.Cuenta.config.mercadoPago);
    const envioEstimado = e.cobra && e.fuente === "estimado";
    $("#campo-pago").hidden = !hayMercadoPago;
    const radioMP = document.querySelector('input[name="pago"][value="mercadopago"]');
    if (!radioMP) return false;
    radioMP.disabled = envioEstimado;
    radioMP.closest(".opcion").classList.toggle("opcion--apagada", envioEstimado);
    const nota = $("#nota-pago");
    nota.textContent = envioEstimado
      ? "Mercado Pago queda para cuando tengamos el costo exacto del envío: el Correo no está respondiendo. Por transferencia lo coordinamos sin problema."
      : "";
    nota.hidden = !envioEstimado;

    const hayQueVolver = (envioEstimado || !hayMercadoPago) && medioDePago === "mercadopago";
    if (hayQueVolver) {
      medioDePago = "transferencia";
      document.querySelector('input[name="pago"][value="transferencia"]').checked = true;
    }
    return hayQueVolver;
  }

  const entrega = () => document.querySelector('input[name="entrega"]:checked').value;

  // ---------- Costo de envío a cargo del comprador ----------
  // 1) Se consulta al Correo Argentino (servicio /api/envio) con el código postal y el peso.
  // 2) Si no está disponible (o es una tarifa de prueba), se usa la tabla de respaldo (ENVIO en data.js)
  //    y el costo se muestra como ESTIMADO.
  let cotizacion = { clave: "", estado: "nada", precio: null, definitivo: false }; // estado: nada | cargando | ok | error
  let temporizador = null;

  const pesoPedido = (r) => r.stickers * ENVIO.gramosPorSticker + ENVIO.gramosEmbalaje;
  const cpIngresado = () => ($("#f-cp").value || "").trim();

  function pedirCotizacion(r) {
    const cp = cpIngresado();
    if (!/^\d{4}$/.test(cp)) { cotizacion = { clave: "", estado: "nada", precio: null, definitivo: false }; return; }
    const gramos = pesoPedido(r);
    const clave = `${cp}|${gramos}`;
    if (cotizacion.clave === clave) return; // ya está pedida o resuelta
    cotizacion = { clave, estado: "cargando", precio: null, definitivo: false };
    clearTimeout(temporizador);
    temporizador = setTimeout(async () => {
      try {
        const resp = await fetch(`/api/envio?cp=${cp}&gramos=${gramos}`);
        if (!resp.ok) throw new Error(String(resp.status));
        const d = await resp.json();
        if (typeof d.precio !== "number") throw new Error("sin precio");
        if (cotizacion.clave === clave) cotizacion = { clave, estado: "ok", precio: d.precio, definitivo: d.definitivo !== false };
      } catch (e) {
        if (cotizacion.clave === clave) cotizacion = { clave, estado: "error", precio: null, definitivo: false };
      }
      pintarCarrito();
    }, 350);
  }

  function tablaRespaldo() {
    const prov = ENVIO.provincias.find((p) => p.nombre === $("#f-provincia").value);
    if (!prov) return null;
    const z = ENVIO.zonas.find((x) => x.zona === prov.zona);
    return z ? z.precio : null;
  }

  // Devuelve { cobra, costo, fuente }. costo = null cuando todavía no se puede calcular.
  function costoEnvio(r) {
    if (entrega() !== "envio") return { cobra: false, costo: 0, fuente: "" };
    pedirCotizacion(r);
    if (cotizacion.estado === "ok" && cotizacion.definitivo) return { cobra: true, costo: cotizacion.precio, fuente: "correo" };
    if (cotizacion.estado === "cargando") return { cobra: true, costo: null, fuente: "cargando" };
    // Sin cotización real del Correo (error, sin configurar o tarifa de prueba): tarifa fija por zona de la provincia.
    const respaldo = tablaRespaldo();
    if (respaldo !== null) return { cobra: true, costo: respaldo, fuente: "zona" };
    return { cobra: true, costo: null, fuente: "falta" };
  }

  function textoEnvio(r) {
    if (entrega() !== "envio") return `Punto de entrega en ${entrega()}, sin cargo`;
    const e = costoEnvio(r);
    if (e.fuente === "cargando") return "Calculando con el Correo Argentino…";
    if (e.costo === null) return `Ingresá tu código postal para calcularlo.`;
    return e.fuente === "correo" ? `${pesos(e.costo)} (Correo Argentino)` : `${pesos(e.costo)} (según tu provincia)`;
  }

  function pintar() { pintarPacks(); pintarCatalogo(); pintarCarrito(); guardar(); }

  // Al cambiar una cantidad solo se reemplaza el control de ESA tarjeta (Agregar o − n +) y se repinta el carrito.
  // El precio de una tarjeta no depende de lo que haya en el pedido, así que no hace falta volver a armar las grillas:
  // con 600 tarjetas, repintarlas todas costaba 150–190 ms en una PC (medido, ver el informe de auditoría).
  function refrescarControles(id) {
    const nombre = nombreDe(id);
    document.querySelectorAll(`#grilla-packs [data-id="${id}"], #grilla [data-id="${id}"]`).forEach((tarjeta) => {
      const actual = tarjeta.querySelector(".agregar, .cantidad");
      if (actual) actual.outerHTML = controlCantidad(id, nombre);
    });
    pintarCarrito();
    guardar();
    document.dispatchEvent(new CustomEvent("pedido:cambio", { detail: { id } }));
  }

  // Avisos visibles (toast). Solo dos casos, para no molestar: (1) se llegó a un precio por cantidad mejor, siempre;
  // (2) se sumó algo desde la vista rápida, donde no se ve el contador del carrito. En la grilla alcanza con el vuelo del sticker.
  function avisarAlSumar(id, antes, n) {
    if (!window.Aviso || n <= antes) return;
    const sueltos = resumen().sueltos;
    if (!esPack(id)) {
      const antesSueltos = sueltos - (n - antes);
      if (precioUnitarioLista(sueltos) < precioUnitarioLista(antesSueltos)) {
        const hito = [...CONFIG.tramos].reverse().find((t) => t.desde <= sueltos).desde;
        window.Aviso.mostrar(`¡Llegaste a ${hito}! Ahora cada uno sale ${pesos(precioUnitarioLista(sueltos))}.`, { clave: "pedido" });
        return;
      }
    }
    if (document.querySelector("dialog.vista[open]")) {
      window.Aviso.mostrar(`Agregado: ${nombreDe(id)}`, {
        clave: "pedido", lector: false,
        accion: { texto: "Ver pedido", fn: () => { const v = document.getElementById("vista"); if (v && v.open) v.close(); abrir(); } },
      });
    }
  }

  function cambiar(id, delta) {
    const antes = pedido[id] || 0;
    const n = Math.max(0, Math.min(999, antes + delta));
    if (n) pedido[id] = n; else delete pedido[id];
    refrescarControles(id);
    if (n === antes) return;
    const nombre = nombreDe(id);
    anunciar(n ? `${nombre}: ${n} en el pedido. Total ${pesos(resumen().total)}.` : `${nombre} sacado del pedido.`);
    avisarAlSumar(id, antes, n);
    medir(delta > 0 ? "add_to_cart" : "remove_from_cart", { items: [itemParaMedir(id, Math.abs(n - antes))] });
    guardarBorrador();
  }

  function itemParaMedir(id, cantidad) {
    const p = TODO.find((x) => x.id === id) || {};
    const precio = esPack(id) ? p.precio : CONFIG.precioUnitario;
    return { item_id: id, item_name: p.nombre || id, item_category: esPack(id) ? "Packs" : (p.categoria || "A elección"), price: precio, quantity: cantidad };
  }

  // Un solo manejador para los botones de cantidad, en packs, catálogo y carrito.
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const d = b.dataset;
    const zonaId = (b.closest("#carrito, #grilla-packs, #grilla") || {}).id;
    let foco = null;
    if (d.sumar) {
      volarAlCarrito(b.closest("#grilla .tarjeta, #grilla-packs .tarjeta, .vista__cuerpo")?.querySelector(".tarjeta__arte, .vista__arte"));
      cambiar(d.sumar, 1); foco = `[data-sumar="${d.sumar}"]`;
    }
    else if (d.restar) { cambiar(d.restar, -1); foco = pedido[d.restar] ? `[data-restar="${d.restar}"]` : `[data-sumar="${d.restar}"]`; }
    else if (d.quitar) {
      const nombre = nombreDe(d.quitar);
      const cant = pedido[d.quitar] || 0;
      delete pedido[d.quitar];
      refrescarControles(d.quitar);
      guardarBorrador();
      anunciar(`${nombre} sacado del pedido.`);
      medir("remove_from_cart", { items: [itemParaMedir(d.quitar, cant)] });
      foco = "#cerrar-carrito";
    } else if (d.cat) {
      elegirCategoria(d.cat);
    } else if (d.pagina && !b.disabled) {
      pagina = Number(d.pagina);
      pintarCatalogo();
      $("#catalogo-cuenta").scrollIntoView({ block: "start" });
      $("#grilla").focus({ preventScroll: true });
      anunciar(`Página ${pagina}.`);
    }
    // Al repintar se pierde el foco: lo devolvemos al control equivalente dentro de la misma zona.
    if (foco && zonaId) {
      const destino = document.getElementById(zonaId).querySelector(foco) || document.querySelector(foco);
      if (destino) destino.focus();
    }
  });

  $("#buscar").addEventListener("input", (e) => { busqueda = e.target.value; reiniciarPaginas(); anunciarResultados(pintarCatalogo()); });
  $("#orden").addEventListener("change", (e) => { orden = e.target.value; reiniciarPaginas(); anunciarResultados(pintarCatalogo()); });
  selCategoria.addEventListener("change", () => elegirCategoria(selCategoria.value));
  $("#btn-ver-mas").addEventListener("click", () => {
    const antes = visibles;
    visibles += POR_PAGINA;
    pintarCatalogo();
    // El foco pasa al primer diseño nuevo, para seguir con el teclado desde ahí.
    const primero = document.querySelectorAll("#grilla .tarjeta")[antes];
    const control = primero && primero.querySelector(".agregar, .cantidad button");
    if (control) control.focus();
  });
  // Al pasar de celular a escritorio (o al revés) se vuelve a la primera página.
  escritorio.addEventListener("change", () => { reiniciarPaginas(); pintarCatalogo(); });
  $("#bp-abrir").addEventListener("click", () => $("#abrir-carrito").click());

  // ---------- Abrir y cerrar el carrito (<dialog> nativo) ----------
  // showModal() deja el resto de la página inerte, mantiene el foco adentro, cierra con Escape y devuelve
  // el foco a quien lo abrió. Si arriba se abre la ventana de ingreso (otro <dialog>), el navegador la apila
  // y el carrito queda inerte debajo: nunca hay dos trampas de foco activas a la vez.
  let empezoCheckout = false;
  function abrir() {
    if (carrito.open) return;
    carrito.showModal();
    document.body.classList.add("sin-scroll");
    const r = resumen();
    if (r.items && !empezoCheckout) {
      empezoCheckout = true;
      medir("begin_checkout", { currency: "ARS", value: r.totalLista, items: TODO.filter((p) => pedido[p.id]).map((p) => itemParaMedir(p.id, pedido[p.id])) });
    }
  }
  // El estado se limpia acá mismo al cerrar por código; el evento "close" cubre el cierre con Escape.
  const liberarScroll = () => { if (!document.querySelector("dialog[open]")) document.body.classList.remove("sin-scroll"); };
  const cerrar = () => { if (carrito.open) carrito.close(); liberarScroll(); };
  carrito.addEventListener("close", liberarScroll);
  // Un clic en el fondo oscuro (que el navegador dirige al propio <dialog>) lo cierra.
  carrito.addEventListener("click", (e) => { if (e.target === carrito) cerrar(); });
  $("#abrir-carrito").addEventListener("click", abrir);
  $("#cerrar-carrito").addEventListener("click", cerrar);

  // ---------- Formulario y envío del pedido ----------
  $("#opciones-pago").innerHTML = `
    <label class="opcion"><input type="radio" name="pago" value="transferencia" checked> Transferencia bancaria <small>con descuento</small></label>
    <label class="opcion"><input type="radio" name="pago" value="mercadopago"> Mercado Pago <small>3 cuotas sin interés, débito o efectivo</small></label>`;
  document.querySelectorAll('input[name="pago"]').forEach((r) =>
    r.addEventListener("change", () => { medioDePago = r.value; pintarCarrito(); guardarBorrador(); }));

  $("#opciones-entrega").innerHTML =
    CONFIG.puntosDeEntrega.map((l, i) =>
      `<label class="opcion"><input type="radio" name="entrega" value="${l}"${i === 0 ? " checked" : ""}> Punto de entrega en ${l}</label>`).join("") +
    `<label class="opcion"><input type="radio" name="entrega" value="envio"> Envío a domicilio (todo el país)</label>`;

  function mostrarCamposDeEnvio() {
    const conEnvio = entrega() === "envio";
    ["#campo-provincia", "#campo-cp", "#campo-calle", "#campo-destino"].forEach((s) => { $(s).hidden = !conEnvio; });
  }
  document.querySelectorAll('input[name="entrega"]').forEach((r) =>
    r.addEventListener("change", () => { mostrarCamposDeEnvio(); pintarCarrito(); guardarBorrador(); }));

  $("#f-provincia").innerHTML = '<option value="">Elegí tu provincia</option>' +
    ENVIO.provincias.map((p) => `<option>${p.nombre}</option>`).join("");
  $("#f-provincia").addEventListener("change", pintarCarrito);
  $("#f-cp").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4); pintarCarrito(); });

  // ---------- Borrador: lo que escribió no se pierde al cerrar, ingresar o fallar la red ----------
  const CAMPOS = { nombre: "#f-nombre", provincia: "#f-provincia", cp: "#f-cp", calle: "#f-calle", localidad: "#f-destino", notas: "#f-notas" };
  let borrador = { clave: "", huella: "" };
  let temporizadorBorrador = null;

  function guardarBorrador() {
    clearTimeout(temporizadorBorrador);
    temporizadorBorrador = setTimeout(() => {
      const datos = { entrega: entrega(), pago: medioDePago, clave: borrador.clave, huella: borrador.huella };
      for (const [k, sel] of Object.entries(CAMPOS)) datos[k] = $(sel).value;
      almacen.guardar(CLAVE_BORRADOR, JSON.stringify(datos));
    }, 250);
  }

  function restaurarBorrador() {
    let d = null;
    try { d = JSON.parse(almacen.leer(CLAVE_BORRADOR) || "null"); } catch (e) { d = null; }
    if (!d || typeof d !== "object") return;
    for (const [k, sel] of Object.entries(CAMPOS)) if (typeof d[k] === "string") $(sel).value = d[k];
    const radioEntrega = [...document.querySelectorAll('input[name="entrega"]')].find((r) => r.value === d.entrega);
    if (radioEntrega) radioEntrega.checked = true;
    if (d.pago === "mercadopago" || d.pago === "transferencia") {
      medioDePago = d.pago;
      document.querySelector(`input[name="pago"][value="${d.pago}"]`).checked = true;
    }
    if (typeof d.clave === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(d.clave)) borrador = { clave: d.clave, huella: String(d.huella || "") };
    mostrarCamposDeEnvio();
  }

  const formPedido = $("#form-pedido");
  formPedido.addEventListener("input", guardarBorrador);

  // Mensaje para avisarle a Don Sticker por WhatsApp (el pedido ya quedó guardado con su número).
  function mensajeWhatsApp(p) {
    const lineas = [`Hola, Don Sticker. Hice el pedido ${p.numero} por ${pesos(p.total)}.`];
    const donde = [p.calle, p.localidad].filter(Boolean).join(", ");
    lineas.push(p.entrega === "envio" ? `Es con envío a ${donde}, CP ${p.cp}, ${p.provincia}.` : `Lo retiro en el punto de entrega de ${p.entrega}.`);
    lineas.push(p.pago === "mercadopago" ? "Elegí pagar con Mercado Pago." : "Quiero coordinar el pago. ¡Gracias!");
    return lineas.join("\n");
  }

  // Después de pedir, si hay sesión y el dispositivo admite avisos, se ofrece una sola vez (sin pedir permiso solo).
  async function ofrecerAvisos() {
    const caja = $("#ph-push");
    if (!caja || !window.DonPush || !(window.Cuenta && window.Cuenta.usuario)) return;
    $("#ph-push-mensaje").hidden = true;
    caja.hidden = (await window.DonPush.estado()) !== "disponible";
  }
  const btnAvisos = $("#ph-push-activar");
  if (btnAvisos) btnAvisos.addEventListener("click", async () => {
    btnAvisos.disabled = true;
    const r = await window.DonPush.activar();
    btnAvisos.disabled = false;
    const m = $("#ph-push-mensaje");
    m.textContent = r.ok ? "Hecho. Te aviso cuando cambie el estado." : r.mensaje;
    m.hidden = false;
    btnAvisos.hidden = r.ok;
  });

  let pedidoHecho = null;
  function mostrarPedidoHecho(p, problema) {
    pedidoHecho = p;
    $("#carrito-detalle").hidden = true;
    $("#carrito-vacio").hidden = true;
    $("#pedido-hecho").hidden = false;
    ofrecerAvisos();
    $("#ph-numero").textContent = p.numero;
    $("#ph-total").textContent = pesos(p.total);
    $("#ph-envio").textContent = p.entrega !== "envio" ? `Punto de entrega en ${p.entrega}, sin cargo` : p.envio === 0 ? "Envío gratis" : `Envío ${pesos(p.envio)}${p.envioFuente === "correo" ? "" : p.envioFuente === "zona" ? " (según tu provincia)" : " (estimado, te lo confirmamos)"}`;
    $("#ph-whatsapp").href = `https://wa.me/${CONFIG.whatsapp}?text=${encodeURIComponent(mensajeWhatsApp(p))}`;
    const pendienteMP = p.pago === "mercadopago";
    // Si Mercado Pago no abrió, el pedido igual quedó guardado: se puede reintentar acá o desde Mi cuenta.
    $("#ph-reintentar").hidden = !(pendienteMP && problema);
    $("#ph-texto").textContent = problema
      ? `${problema} Tu pedido quedó guardado: podés reintentar el pago ahora, retomarlo desde «Mi cuenta» o avisarme por WhatsApp.`
      : "Avisame por WhatsApp para coordinar el pago. Te mandé el detalle por mail y lo podés seguir en tu cuenta.";
    $("#ph-titulo").focus(); // el foco pasa al aviso: quien navega con teclado o lector de pantalla se entera
  }

  $("#ph-whatsapp").addEventListener("click", () => medir("contacto_whatsapp", { contexto: "pedido_pendiente", transaction_id: pedidoHecho && pedidoHecho.numero }));

  function datosDelPedido() {
    const entrega_ = entrega();
    return {
      items: Object.entries(pedido).map(([id, cantidad]) => ({ id, cantidad })),
      entrega: entrega_,
      nombre: $("#f-nombre").value.trim(),
      provincia: entrega_ === "envio" ? $("#f-provincia").value : undefined,
      cp: entrega_ === "envio" ? cpIngresado() : undefined,
      calle: entrega_ === "envio" ? $("#f-calle").value.trim() : undefined,
      localidad: entrega_ === "envio" ? $("#f-destino").value.trim() : undefined,
      notas: $("#f-notas").value.trim(),
      pago: medioDePago,
      atribucion: window.Analitica ? window.Analitica.atribucion() : undefined,
    };
  }

  // Una clave por pedido: si la respuesta se pierde y el cliente reintenta, el servidor le devuelve el pedido
  // que ya creó en vez de crear otro. Si cambia lo que se pide, la clave cambia.
  function claveParaEnviar(datos) {
    const huella = JSON.stringify([datos.items, datos.entrega, datos.provincia, datos.cp, datos.calle, datos.localidad, datos.pago]);
    if (!borrador.clave || borrador.huella !== huella) {
      const azar = (window.crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
      borrador = { clave: azar.slice(0, 40).padEnd(16, "0"), huella };
      guardarBorrador();
    }
    return borrador.clave;
  }

  // ---------- Errores del formulario, asociados a su campo ----------
  function limpiarInvalidos() {
    formPedido.querySelectorAll("[aria-invalid]").forEach((c) => { c.removeAttribute("aria-invalid"); c.removeAttribute("aria-describedby"); });
  }
  function mostrarError(texto, campo) {
    const p = $("#form-error");
    p.textContent = texto;
    p.hidden = !texto;
    limpiarInvalidos();
    if (campo && texto) {
      campo.setAttribute("aria-invalid", "true");
      campo.setAttribute("aria-describedby", "form-error");
      campo.focus();
    }
  }
  // Al corregir el campo marcado, el error desaparece.
  formPedido.addEventListener("input", (e) => {
    if (!e.target.hasAttribute || !e.target.hasAttribute("aria-invalid")) return;
    e.target.removeAttribute("aria-invalid");
    e.target.removeAttribute("aria-describedby");
    if (!formPedido.querySelector("[aria-invalid]")) { $("#form-error").hidden = true; $("#form-error").textContent = ""; }
  });

  function validarFormulario() {
    if (!$("#f-nombre").value.trim()) return ["Decime tu nombre, así sé a quién le preparo el pedido.", $("#f-nombre")];
    if (entrega() === "envio") {
      if (!$("#f-provincia").value) return ["Elegí tu provincia para calcular el envío.", $("#f-provincia")];
      if (!/^\d{4}$/.test(cpIngresado())) return ["Ingresá tu código postal de 4 números para calcular el envío.", $("#f-cp")];
      if ($("#f-calle").value.trim().length < 3) return ["Decime tu calle y número para el envío.", $("#f-calle")];
      if ($("#f-destino").value.trim().length < 2) return ["Decime tu localidad para el envío.", $("#f-destino")];
    }
    return null;
  }

  // Lleva al cliente a pagar a Mercado Pago. Devuelve el motivo si no se pudo.
  async function irAMercadoPago(pedidoId) {
    const r = await window.Cuenta.api(`/pedidos/${pedidoId}/pago`, { method: "POST", cuerpo: {} });
    if (r.ok && r.datos.url) { window.location.href = r.datos.url; return null; }
    if (r.status === 0) return "No pude conectarme con Mercado Pago. Revisá tu conexión.";
    return (r.datos && r.datos.mensaje) || "No pude abrir Mercado Pago.";
  }

  $("#ph-reintentar").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (!pedidoHecho) return;
    b.disabled = true;
    b.textContent = "Abriendo Mercado Pago…";
    const problema = await irAMercadoPago(pedidoHecho.id);
    if (problema) {
      b.disabled = false;
      b.textContent = "Reintentar el pago con Mercado Pago";
      $("#ph-texto").textContent = `${problema} Tu pedido sigue guardado: probá de nuevo, retomalo desde «Mi cuenta» o avisame por WhatsApp.`;
    }
  });

  let enviando = false;
  formPedido.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (enviando) return;
    const falta = validarFormulario();
    if (falta) return mostrarError(falta[0], falta[1]);
    mostrarError("");

    // El pedido se guarda en tu cuenta para que puedas seguirlo: hace falta ingresar. La ventana de ingreso se
    // abre ENCIMA del carrito: lo cargado, el destino y el medio de pago siguen donde estaban.
    if (!window.Cuenta) return mostrarError("No pude cargar tu cuenta. Recargá la página.");
    let usuario = window.Cuenta.usuario;
    if (!usuario) {
      usuario = await window.Cuenta.abrirIngreso("Para hacer tu pedido, ingresá o creá tu cuenta. Así podés seguirlo y ver tu historial.");
      if (!usuario) return;
    }

    const boton = $("#btn-confirmar");
    const textoOriginal = boton.textContent;
    enviando = true;
    boton.disabled = true;
    boton.textContent = "Guardando tu pedido…";
    formPedido.setAttribute("aria-busy", "true");
    const datos = datosDelPedido();
    datos.claveIdempotencia = claveParaEnviar(datos);
    const r = await window.Cuenta.api("/pedidos", { method: "POST", cuerpo: datos });
    enviando = false;
    formPedido.removeAttribute("aria-busy");
    boton.disabled = false;
    boton.textContent = textoOriginal;

    if (r.status === 0) return mostrarError("No pude conectarme. Tu pedido todavía no se envió y tus datos siguen acá: probá de nuevo en un momento.");
    if (r.status === 401) {
      mostrarError("Tu sesión se cerró. Ingresá de nuevo y confirmá el pedido.");
      window.Cuenta.abrirIngreso("Tu sesión se cerró. Ingresá de nuevo: tu pedido sigue armado.");
      return;
    }
    if (!r.ok) return mostrarError(r.datos.mensaje || "No pude guardar el pedido. Probá de nuevo.");

    const hecho = r.datos.pedido;
    medir("pedido_creado", { transaction_id: hecho.numero, currency: "ARS", value: hecho.total, payment_type: hecho.pago });
    pedido = {};
    borrador = { clave: "", huella: "" };
    almacen.borrar(CLAVE_BORRADOR);
    empezoCheckout = false;
    pintar();

    // Con Mercado Pago el pedido ya quedó guardado: ahora se va a pagar a su sitio.
    let problema = null;
    if (hecho.pago === "mercadopago") {
      boton.disabled = true;
      boton.textContent = "Abriendo Mercado Pago…";
      problema = await irAMercadoPago(hecho.id);
      boton.disabled = false;
      boton.textContent = textoOriginal;
      if (!problema) return; // se está yendo a Mercado Pago
    }
    mostrarPedidoHecho(hecho, problema);
  });

  if (window.Cuenta) {
    // La configuración del servidor (si hay Mercado Pago) llega después: se repinta el carrito.
    window.Cuenta.alCambiar((u) => {
      if (u && !$("#f-nombre").value) $("#f-nombre").value = u.nombre || "";
      pintarCarrito();
    });
    if (window.Cuenta.usuario && !$("#f-nombre").value) $("#f-nombre").value = window.Cuenta.usuario.nombre || "";
  }

  restaurarBorrador();
  pintar();

  // Se mide qué listas se ven (packs y catálogo) una sola vez, cuando entran en pantalla.
  if ("IntersectionObserver" in window) {
    const vistas = new IntersectionObserver((entradas) => {
      entradas.forEach((en) => {
        if (!en.isIntersecting) return;
        vistas.unobserve(en.target);
        const esPacks = en.target.id === "grilla-packs";
        medir("view_item_list", { item_list_id: esPacks ? "packs" : "a_eleccion", item_list_name: esPacks ? "Packs prearmados" : "Stickers a elección" });
      });
    }, { threshold: 0.2 });
    vistas.observe($("#grilla-packs"));
    vistas.observe($("#grilla"));
  }

  // packs.html manda al cliente acá con su pedido ya guardado: se abre el carrito.
  if (/[?&]carrito=1/.test(location.search)) {
    try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) { /* sin historial */ }
    setTimeout(() => abrir(), 0);
  }
})();
