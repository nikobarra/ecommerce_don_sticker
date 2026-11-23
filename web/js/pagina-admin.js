// Panel del dueño: ver pedidos y cambiar su estado.
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const { api, esc } = window.Cuenta;
  const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");
  const fecha = (iso) => new Date(iso).toLocaleString("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const ESTADOS = { recibido: "Recibido", pago_confirmado: "Pago confirmado", preparando: "Preparando", despachado: "Despachado", entregado: "Entregado", cancelado: "Cancelado" };

  $("#filtro").innerHTML += Object.entries(ESTADOS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");

  // Ventana emergente nativa: el navegador mantiene el foco adentro, cierra con Escape y devuelve el foco al botón.
  function ventana(titulo, texto) {
    const d = $("#ventana-aviso");
    $("#va-titulo").textContent = titulo;
    $("#va-texto").textContent = texto;
    if (!d.open) d.showModal();
  }
  $("#va-cerrar").addEventListener("click", () => $("#ventana-aviso").close());
  $("#va-aceptar").addEventListener("click", () => $("#ventana-aviso").close());
  $("#ventana-aviso").addEventListener("click", (e) => { if (e.target.id === "ventana-aviso") e.target.close(); });

  function aviso(texto) {
    const m = $("#mensaje");
    m.textContent = texto;
    m.hidden = !texto;
  }

  async function resumen() {
    const r = await api("/admin/resumen");
    if (!r.ok) return;
    const c = r.datos.clientes;
    const porEstado = Object.entries(ESTADOS).map(([k, v]) => `<span>${v}: ${r.datos.pedidosPorEstado[k] || 0}</span>`).join("");
    $("#contadores").innerHTML = `${porEstado}<span>Clientes: ${c.total}</span><span>Aceptaron novedades: ${c.conConsentimiento}</span><span>Recibirían el mail semanal: ${c.destinatariosNovedades}</span>`;
  }

  // ---------- Analíticas ----------
  const numero = (n) => Number(n || 0).toLocaleString("es-AR");
  const diaCorto = (d) => { const [a, m, dd] = d.split("-"); return `${dd}/${m}`; };
  const hoyISO = () => new Date().toISOString().slice(0, 10);
  const restarDias = (d, n) => new Date(Date.parse(d + "T00:00:00Z") - n * 86400000).toISOString().slice(0, 10);

  const NOMBRE_RUTA = { "/": "Inicio", "/cuenta": "Mi cuenta", "/pago": "Vuelta de Mercado Pago", "/terminos": "Términos", "/privacidad": "Privacidad", "/arrepentimiento": "Arrepentimiento", "/verificar": "Verificar mail", "/restablecer": "Nueva contraseña", "/baja": "Baja de novedades", otra: "Otras" };
  const NOMBRE_PAGO = { transferencia: "Transferencia", mercadopago: "Mercado Pago" };

  function dato(titulo, valor, nota) {
    return `<div class="dato"><p class="dato__titulo">${esc(titulo)}</p><p class="dato__valor">${esc(valor)}</p>${nota ? `<p class="dato__nota">${esc(nota)}</p>` : ""}</div>`;
  }

  function tablita(titulo, columnas, filas, vacio) {
    if (!filas.length) return `<div class="bloque"><h3>${esc(titulo)}</h3><p>${esc(vacio)}</p></div>`;
    const encabezado = columnas.map((c) => `<th${c.num ? ' class="num"' : ""}>${esc(c.titulo)}</th>`).join("");
    const cuerpo = filas.map((f) => `<tr>${columnas.map((c) => `<td${c.num ? ' class="num"' : ""}>${esc(c.valor(f))}</td>`).join("")}</tr>`).join("");
    return `<div class="bloque"><h3>${esc(titulo)}</h3><div class="tabla-scroll"><table class="tabla"><thead><tr>${encabezado}</tr></thead><tbody>${cuerpo}</tbody></table></div></div>`;
  }

  // Gráfico de barras sencillo: una barra por día, alta en proporción al día más vendido.
  function barras(titulo, filas, clave, formato) {
    if (!filas.length) return `<div class="bloque"><h3>${esc(titulo)}</h3><p>Todavía no hay datos en este período.</p></div>`;
    const max = Math.max(...filas.map((f) => Number(f[clave]) || 0)) || 1;
    const cols = filas.map((f) => {
      const v = Number(f[clave]) || 0;
      return `<div class="columna" style="--f:${(v / max).toFixed(3)}" title="${esc(diaCorto(f.dia))}: ${esc(formato(v))}">
        <span class="columna__valor">${esc(formato(v))}</span><span class="columna__dia">${esc(diaCorto(f.dia))}</span></div>`;
    }).join("");
    return `<div class="bloque"><h3>${esc(titulo)}</h3><div class="grafico">${cols}</div></div>`;
  }

  function pintarAnaliticas(d) {
    const v = d.ventas;
    const vis = d.visitas;
    const c = d.clientes;
    const conversion = vis.conversion === null ? "—" : vis.conversion + "%";

    const tarjetas = [
      dato("Facturado", pesos(v.facturado), `${numero(v.pedidos)} pedido${v.pedidos === 1 ? "" : "s"}`),
      dato("Ticket promedio", pesos(v.ticket), "por pedido"),
      dato("Visitas", numero(vis.visitas), `${numero(vis.paginas)} páginas abiertas`),
      dato("Conversión", conversion, "visitas que compraron"),
      dato("Clientes nuevos", numero(c.nuevos), `${numero(c.total)} en total`),
      dato("Cancelados", numero(v.cancelados), v.cancelados ? pesos(v.facturadoCancelado) + " sin cobrar" : "ninguno"),
    ].join("");

    const detalleVenta = [
      dato("Productos", pesos(v.productos), "sin contar el envío"),
      dato("Envíos cobrados", pesos(v.envios), ""),
      dato("Descuentos por transferencia", pesos(v.descuentos), "lo que resignaste"),
      dato("Clientes que repiten", numero(c.repiten), "compraron más de una vez"),
      dato("Aceptaron novedades", numero(c.conConsentimiento), `${numero(c.destinatariosNovedades)} recibirían el mail`),
      dato("Entraron con Google", numero(c.conGoogle), `${numero(c.verificados)} con el mail confirmado`),
    ].join("");

    const productos = tablita("Qué se vende", [
      { titulo: "Producto", valor: (f) => f.nombre },
      { titulo: "Tipo", valor: (f) => (f.tipo === "pack" ? "Pack" : "A elección") },
      { titulo: "Vendidos", num: true, valor: (f) => numero(f.cantidad) },
      { titulo: "Stickers", num: true, valor: (f) => numero(f.stickers) },
      { titulo: "Pedidos", num: true, valor: (f) => numero(f.pedidos) },
      { titulo: "Facturado", num: true, valor: (f) => pesos(f.facturado) },
    ], d.productos, "Todavía no se vendió nada en este período.");

    const mayores = tablita("Las ventas más grandes", [
      { titulo: "Pedido", valor: (f) => f.numero },
      { titulo: "Fecha", valor: (f) => fecha(f.fecha) },
      { titulo: "Cliente", valor: (f) => f.nombre },
      { titulo: "Pago", valor: (f) => NOMBRE_PAGO[f.pago] || f.pago },
      { titulo: "Estado", valor: (f) => ESTADOS[f.estado] || f.estado },
      { titulo: "Total", num: true, valor: (f) => pesos(f.total) },
    ], d.mayoresVentas, "Todavía no hay ventas en este período.");

    const medios = tablita("Cómo pagan", [
      { titulo: "Medio", valor: (f) => NOMBRE_PAGO[f.medio] || f.medio },
      { titulo: "Pedidos", num: true, valor: (f) => numero(f.pedidos) },
      { titulo: "Total", num: true, valor: (f) => pesos(f.total) },
    ], d.porMedioDePago, "Sin datos todavía.");

    const entregas = tablita("Cómo lo reciben", [
      { titulo: "Entrega", valor: (f) => (f.entrega === "envio" ? "Envío a domicilio" : "Retiro en " + f.entrega) },
      { titulo: "Pedidos", num: true, valor: (f) => numero(f.pedidos) },
      { titulo: "Total", num: true, valor: (f) => pesos(f.total) },
    ], d.porEntrega, "Sin datos todavía.");

    const provincias = tablita("A qué provincias se envía", [
      { titulo: "Provincia", valor: (f) => f.provincia },
      { titulo: "Pedidos", num: true, valor: (f) => numero(f.pedidos) },
      { titulo: "Total", num: true, valor: (f) => pesos(f.total) },
    ], d.porProvincia, "Todavía no hubo envíos a domicilio.");

    const rutas = tablita("Qué páginas miran", [
      { titulo: "Página", valor: (f) => NOMBRE_RUTA[f.ruta] || f.ruta },
      { titulo: "Visitas", num: true, valor: (f) => numero(f.visitas) },
      { titulo: "Aperturas", num: true, valor: (f) => numero(f.paginas) },
    ], vis.porRuta, "Todavía no se registraron visitas.");

    const estados = Object.entries(d.estados)
      .map(([k, n]) => `<span>${esc(n)}: ${numero(d.porEstado[k] || 0)}</span>`).join("");

    $("#analiticas-cuerpo").innerHTML = `
      <div class="datos">${tarjetas}</div>
      ${barras("Facturado por día", d.ventasPorDia, "total", (n) => pesos(n))}
      ${barras("Visitas por día", vis.porDia, "visitas", (n) => numero(n))}
      <div class="datos">${detalleVenta}</div>
      <p class="contadores contadores--chico">${estados}</p>
      ${productos}
      ${mayores}
      <div class="bloques-dos">${medios}${entregas}</div>
      <div class="bloques-dos">${provincias}${rutas}</div>
      <p class="dato__nota">Período: ${esc(diaCorto(d.periodo.desde))} al ${esc(diaCorto(d.periodo.hasta))} (${d.periodo.dias} día${d.periodo.dias === 1 ? "" : "s"}). Las visitas se cuentan sin guardar ningún dato de quien entra: una por pestaña nueva.</p>`;
  }

  async function cargarAnaliticas() {
    const desde = $("#a-desde").value;
    const hasta = $("#a-hasta").value;
    const r = await api(`/admin/analiticas?desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}`);
    if (!r.ok) { $("#analiticas-cuerpo").innerHTML = `<p class="error">${esc(r.datos.mensaje || "No pude cargar las analíticas.")}</p>`; return; }
    pintarAnaliticas(r.datos);
  }

  function elegirPeriodo(dias) {
    const hasta = hoyISO();
    $("#a-hasta").value = hasta;
    $("#a-desde").value = dias === "todo" ? "2020-01-01" : restarDias(hasta, Number(dias));
    cargarAnaliticas();
  }

  $("#periodo").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-dias]");
    if (!b) return;
    $("#periodo").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    elegirPeriodo(b.dataset.dias);
  });
  $("#a-desde").addEventListener("change", () => { $("#periodo").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", "false")); cargarAnaliticas(); });
  $("#a-hasta").addEventListener("change", () => { $("#periodo").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", "false")); cargarAnaliticas(); });

  const PROBLEMAS = {
    pago_en_pedido_cancelado: "Mercado Pago cobró un pedido que estaba CANCELADO. Hay que devolver la plata (o reactivar el pedido si el cliente lo quiere).",
    pago_duplicado: "Se cobró dos veces este pedido. Hay que devolver uno desde Mercado Pago.",
    importe_distinto: "Hay un pago aprobado que no coincide con el total (importe o moneda). El pedido NO se confirmó solo.",
    pago_devuelto: "El pago de este pedido figura como devuelto en Mercado Pago.",
    contracargo: "El pago de este pedido tiene un CONTRACARGO. No despaches si todavía no salió.",
  };

  // ---------- Facturación ----------
  let facturacionActiva = false;
  const ESTADO_COMP = { emitida: "Emitida", pendiente: "Pendiente (ARCA no respondió)", error: "Rechazada por ARCA" };
  const fechaAfip = (s) => (s && s.length === 8 ? `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}` : "");
  const ESTADOS_PAGO_OK = ["pago_confirmado", "preparando", "despachado", "entregado"];

  // Lo que se ve de la facturación dentro de cada pedido, con los botones que correspondan.
  function bloqueFactura(p) {
    const f = p.facturacion && p.facturacion.factura, n = p.facturacion && p.facturacion.nota;
    const partes = [];
    if (f && f.estado === "emitida") partes.push(`<p><strong>Factura C ${esc(f.numero)}</strong>${f.origen === "manual" ? " (la pediste vos)" : ""} <button class="boton boton--claro" type="button" data-pdf="factura">Ver PDF</button></p>`);
    else if (f && f.estado === "pendiente") partes.push("<p>Factura pendiente: ARCA no respondió. Se reintenta sola.</p>");
    else if (f && f.estado === "error") partes.push(`<p class="error">ARCA no aceptó la factura: ${esc(f.error)}</p>`);
    if (n && n.estado === "emitida") partes.push(`<p><strong>Nota de crédito C ${esc(n.numero)}</strong> (anula la factura) <button class="boton boton--claro" type="button" data-pdf="nota">Ver PDF</button></p>`);
    else if (n && n.estado === "pendiente") partes.push("<p>Nota de crédito pendiente: ARCA no respondió. Se reintenta sola.</p>");
    else if (n && n.estado === "error") partes.push(`<p class="error">ARCA no aceptó la nota de crédito: ${esc(n.error)}</p>`);
    if (facturacionActiva) {
      const puede = p.pago === "mercadopago" ? ESTADOS_PAGO_OK.includes(p.estado) : p.estado !== "cancelado";
      if ((!f || f.estado === "error") && puede) {
        partes.push(`<button class="boton boton--primario" type="button" data-facturar>${f ? "Reintentar facturar" : "Facturar"}</button>${p.pago === "transferencia" && !f ? "<small> Facturá cuando verifiques que el dinero ingresó.</small>" : ""}`);
      }
      if (f && f.estado === "emitida" && (!n || n.estado === "error")) partes.push('<button class="boton boton--claro" type="button" data-nota>Anular con nota de crédito</button>');
    }
    return partes.length ? `<div class="problema-pago" role="group" aria-label="Facturación">${partes.join("")}</div>` : "";
  }

  async function bajarPdf(pedidoId, tipo) {
    const res = await fetch(`/api/admin/pedidos/${pedidoId}/comprobante${tipo === "nota" ? "?tipo=nota" : ""}`);
    if (!res.ok) { aviso("No pude abrir ese comprobante."); return; }
    const nombre = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || "comprobante.pdf";
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function cargarFacturas() {
    const r = await api("/admin/facturas");
    const cont = $("#facturas-cuerpo");
    if (!r.ok) { cont.innerHTML = `<p class="error">${esc(r.datos.mensaje || "No pude cargar las facturas.")}</p>`; return; }
    const d = r.datos;
    facturacionActiva = d.activa;
    const nota = !d.activa ? '<p class="error">La facturación está apagada: no se emite nada.</p>' : (d.ambiente === "prueba" ? '<p class="error">Ambiente de PRUEBAS de ARCA: estas facturas no tienen validez fiscal.</p>' : "");
    const filas = d.facturas.map((f) => `<tr data-pedido="${esc(f.pedidoId)}">
      <td>${esc(fechaAfip(f.fecha))}</td><td>${f.numero ? esc(f.numero) : "—"}</td><td>${esc(f.pedido)}</td><td>${esc(f.cliente)}</td>
      <td>${esc(NOMBRE_PAGO[f.pago] || f.pago)}${f.origen === "manual" ? " · manual" : ""}</td><td class="num">${pesos(f.total)}</td>
      <td>${esc(ESTADO_COMP[f.estado] || f.estado)}${f.estado === "error" ? "<br><small>" + esc(f.error) + "</small>" : ""}${f.estado === "emitida" && !f.mailEnviado ? "<br><small>mail sin enviar</small>" : ""}</td>
      <td>${f.nota ? esc(f.nota.numero ? `NC ${f.nota.numero}` : ESTADO_COMP[f.nota.estado]) : "—"}</td>
      <td>${f.estado === "emitida" ? '<button class="boton boton--claro" type="button" data-pdf="factura">Factura</button>' : ""}${f.nota && f.nota.estado === "emitida" ? ' <button class="boton boton--claro" type="button" data-pdf="nota">Nota</button>' : ""}</td></tr>`).join("");
    cont.innerHTML = `${nota}<div class="datos">
      ${dato("Facturado este mes", pesos(d.facturadoMes), "descontando notas de crédito")}
      ${dato("Últimos 12 meses", pesos(d.facturado12Meses), "para vigilar el tope de tu categoría de monotributo")}</div>
      ${d.facturas.length ? `<div class="tabla-scroll"><table class="tabla"><thead><tr><th>Fecha</th><th>Factura</th><th>Pedido</th><th>Cliente</th><th>Pago</th><th class="num">Total</th><th>Estado</th><th>Nota de crédito</th><th>PDF</th></tr></thead><tbody>${filas}</tbody></table></div>` : "<p>Todavía no se emitió ninguna factura.</p>"}`;
  }

  $("#facturas-cuerpo").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pdf]");
    if (b) bajarPdf(b.closest("[data-pedido]").dataset.pedido, b.dataset.pdf);
  });

  function tarjeta(p) {
    const items = p.items.map((i) => {
      // Pedidos anteriores a los códigos: el código sale del identificador del diseño (ds-0001 -> DS-0001).
      const codigo = i.codigo || (i.tipo === "suelto" && i.id ? String(i.id).toUpperCase() : "");
      return `<li>${i.cantidad} × ${esc(i.nombre)}${codigo ? ` <strong>${esc(codigo)}</strong>` : ""}${i.tipo === "pack" ? " (prearmado)" : ""}${i.disenos ? `<details><summary>Qué diseños lleva</summary><small>${i.disenos.map(esc).join(", ")}</small></details>` : ""}</li>`;
    }).join("");
    const entrega = p.entrega === "envio" ? `Envío a ${esc([p.calle, p.localidad].filter(Boolean).join(", "))}, CP ${esc(p.cp)}, ${esc(p.provincia)}` : `Punto de entrega en ${esc(p.entrega)}`;
    const envio = p.entrega !== "envio" ? "sin cargo" : p.envio === 0 ? "gratis" : pesos(p.envio) + (p.envioFuente === "correo" ? " (Correo Argentino)" : p.envioFuente === "zona" ? " (tarifa por zona)" : p.envioFuente === "correo_prueba" ? " (tarifa de PRUEBA del Correo: confirmar)" : " (estimado, confirmar)");
    const opciones = Object.entries(ESTADOS).map(([k, v]) => `<option value="${k}"${k === p.estado ? " selected" : ""}>${v}</option>`).join("");
    return `<article class="tarjeta-p fila-admin" data-id="${esc(p.id)}">
      <div>
        <div class="pedido__cabeza"><strong>${esc(p.numero)}</strong><span class="estado estado--${esc(p.estado)}">${esc(p.estadoTexto)}</span></div>
        <p>${esc(fecha(p.creado))} · ${esc(p.nombre)}<br>${p.clienteMail ? esc(p.clienteMail) + (p.clienteMailVerificado ? "" : " (mail sin confirmar)") : "cuenta eliminada"}</p>
        <ul>${items}</ul>
        <p>${entrega}. Envío ${envio}.</p>
        ${p.notas ? `<p>Aclaración: ${esc(p.notas)}</p>` : ""}
        <p><strong>Total: ${pesos(p.total)}</strong>${p.pago === "mercadopago" ? " · Mercado Pago" : " · Transferencia"}</p>
        ${bloqueFactura(p)}
        ${p.problemaPago ? `<div class="problema-pago" role="group" aria-label="Cobro a revisar"><p><strong>Cobro a revisar:</strong> ${esc(PROBLEMAS[p.problemaPago] || p.problemaPago)}</p><button class="boton boton--claro" type="button" data-resolver>Ya lo revisé</button></div>` : ""}
      </div>
      <form data-form novalidate>
        <label>Estado <select name="estado">${opciones}</select></label>
        <label>Número de seguimiento <input type="text" name="seguimiento" maxlength="40" value="${esc(p.seguimiento)}" autocomplete="off"></label>
        <p class="error" data-error role="alert" hidden></p>
        <button class="boton boton--primario" type="submit">Guardar y avisar al cliente</button>
      </form>
    </article>`;
  }

  async function cargar() {
    const r = await api(`/admin/pedidos?estado=${encodeURIComponent($("#filtro").value)}`);
    const cont = $("#pedidos");
    if (!r.ok) { cont.innerHTML = `<p class="error">${esc(r.datos.mensaje || "No pude cargar los pedidos.")}</p>`; return; }
    facturacionActiva = r.datos.facturacionActiva === true;
    cont.innerHTML = r.datos.pedidos.length ? r.datos.pedidos.map(tarjeta).join("") : "<p>No hay pedidos en este estado.</p>";
  }

  $("#filtro").addEventListener("change", cargar);

  // Revisa en Mercado Pago los pedidos que siguen esperando el pago, aunque el aviso nunca haya llegado.
  $("#conciliar").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    // El resultado sale en una ventana emergente (y queda también escrito junto al botón): el aviso general
    // está arriba del panel y quedaba fuera de la vista.
    const estado = $("#conciliar-estado");
    const decir = (t, emergente = false) => { estado.textContent = t; estado.hidden = !t; if (emergente) ventana("Revisión de pagos", t); };
    const textoOriginal = b.textContent;
    b.disabled = true;
    b.textContent = "Revisando…";
    decir("Revisando los pagos en Mercado Pago…");
    const r = await api("/admin/conciliar", { method: "POST", cuerpo: {} });
    b.disabled = false;
    b.textContent = textoOriginal;
    if (!r.ok) { decir(r.datos.mensaje || "No pude revisar los pagos. Probá de nuevo en unos minutos.", true); return; }
    const d = r.datos;
    decir(`Revisé ${d.revisados} pedido${d.revisados === 1 ? "" : "s"}: ${d.confirmados} pago${d.confirmados === 1 ? "" : "s"} confirmado${d.confirmados === 1 ? "" : "s"}, ${d.problemas} a revisar${d.errores ? `, ${d.errores} con error de conexión (probá de nuevo)` : ""}.`, true);
    resumen();
    cargar();
  });

  // ---------- Mail semanal de novedades ----------
  const DIAS = ["domingos", "lunes", "martes", "miércoles", "jueves", "viernes", "sábados"];
  const ESTADO_ENVIO = { enviando: "enviando", terminado: "terminado", sin_novedades: "no salió: no hubo diseños nuevos" };
  async function cargarNovedades() {
    const r = await api("/admin/novedades");
    if (!r.ok) { $("#nov-estado").textContent = r.datos.mensaje || "No pude cargar el estado del mail."; return; }
    const d = r.datos;
    const hora = (d.horaUtc - 3 + 24) % 24; // Argentina, UTC-3
    $("#nov-estado").textContent = (d.activo
      ? `Activo: sale los ${DIAS[d.dia]} desde las ${hora} h, hasta ${d.topeDiario} mails por día.`
      : "Apagado: no se manda nada hasta activarlo (NOVEDADES_ACTIVO = 1).")
      + ` Suscriptores: ${d.suscriptores}. Diseños nuevos esperando el próximo mail: ${d.disenosPendientes}.`;
    $("#nov-envios").innerHTML = d.envios.length
      ? `<table class="tabla"><thead><tr><th>Semana</th><th>Estado</th><th>Enviados</th></tr></thead><tbody>${d.envios.map((x) =>
        `<tr><td>${esc(x.semana)}</td><td>${esc(ESTADO_ENVIO[x.estado] || x.estado)}</td><td>${x.enviados} de ${x.total}</td></tr>`).join("")}</tbody></table>`
      : "<p>Todavía no salió ningún mail de novedades.</p>";
  }

  $("#nov-prueba").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    const r = await api("/admin/novedades/prueba", { method: "POST", cuerpo: {} });
    b.disabled = false;
    ventana("Mail de novedades", r.ok
      ? `Te mandé una prueba a ${r.datos.para} con ${r.datos.disenos} diseño${r.datos.disenos === 1 ? "" : "s"}. Revisá también la carpeta de spam o promociones.`
      : (r.datos.mensaje || "No pude mandar la prueba."));
  });

  // Facturar, anular y ver comprobantes desde cada pedido.
  $("#pedidos").addEventListener("click", async (e) => {
    const tarjetaPedido = e.target.closest("[data-id]");
    const accion = e.target.closest("[data-facturar], [data-nota], [data-pdf]");
    if (!accion || !tarjetaPedido) return;
    const id = tarjetaPedido.dataset.id, numero = tarjetaPedido.querySelector(".pedido__cabeza strong")?.textContent || "";
    if (accion.hasAttribute("data-pdf")) { bajarPdf(id, accion.dataset.pdf); return; }
    const total = (tarjetaPedido.textContent.match(/Total: (\$[\d.]+)/) || [])[1] || "";
    let cuerpo = {};
    if (accion.hasAttribute("data-facturar")) {
      if (!window.confirm(`Vas a emitir la factura oficial del pedido ${numero}${total ? " por " + total : ""} a nombre de Consumidor Final, y se la mando al cliente por mail.\n\n¿Ya verificaste que el pago ingresó?`)) return;
    } else {
      const motivo = window.prompt(`Vas a emitir una NOTA DE CRÉDITO por el total del pedido ${numero}${total ? " (" + total + ")" : ""}. Anula la factura y no se puede deshacer.\n\nOJO: esto NO devuelve la plata. El reembolso lo hacés vos aparte, en Mercado Pago o por transferencia.\n\nEscribí el motivo (opcional) y aceptá:`, "Devolución");
      if (motivo === null) return;
      cuerpo = { motivo };
    }
    accion.disabled = true;
    const r = await api(`/admin/pedidos/${id}/${accion.hasAttribute("data-facturar") ? "facturar" : "nota-credito"}`, { method: "POST", cuerpo });
    ventana(accion.hasAttribute("data-facturar") ? "Facturación" : "Nota de crédito", r.datos.mensaje || "No pude completar la operación.");
    cargar(); cargarFacturas();
  });

  $("#pedidos").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-resolver]");
    if (!b) return;
    const id = b.closest("[data-id]").dataset.id;
    b.disabled = true;
    const r = await api(`/admin/pedidos/${id}`, { method: "PATCH", cuerpo: { resolverProblemaPago: true } });
    if (r.ok) { aviso(`Cobro de ${r.datos.pedido.numero} marcado como revisado.`); cargar(); } else { b.disabled = false; aviso(r.datos.mensaje || "No pude guardar."); }
  });

  $("#pedidos").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const id = form.closest("[data-id]").dataset.id;
    const err = form.querySelector("[data-error]");
    err.hidden = true;
    const boton = form.querySelector("button");
    boton.disabled = true;
    const r = await api(`/admin/pedidos/${id}`, { method: "PATCH", cuerpo: { estado: form.estado.value, seguimiento: form.seguimiento.value } });
    boton.disabled = false;
    if (r.ok) { aviso(`Pedido ${r.datos.pedido.numero} actualizado.`); resumen(); cargar(); } else { err.textContent = r.datos.mensaje || "No pude guardar."; err.hidden = false; }
  });

  async function mostrar(u) {
    $("#sin-sesion").hidden = Boolean(u);
    $("#sin-permiso").hidden = !u || u.admin;
    $("#panel").hidden = !(u && u.admin);
    if (u && u.admin) { resumen(); cargarFacturas().then(cargar); elegirPeriodo(29); cargarNovedades(); }
  }

  $("#abrir-ingreso").addEventListener("click", async () => { const u = await window.Cuenta.abrirIngreso("Ingresá con la cuenta del dueño."); if (u) mostrar(u); });
  window.Cuenta.cargar().then((u) => {
    mostrar(u);
    if (!u) window.Cuenta.abrirIngreso("Ingresá con la cuenta del dueño.").then((x) => { if (x) mostrar(x); });
  });
})();
