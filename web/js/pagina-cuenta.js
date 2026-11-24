// Página «Mi cuenta»: pedidos con su estado, datos, novedades, contraseña y baja.
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const { api, esc } = window.Cuenta;
  const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");
  const fecha = (iso) => new Date(iso).toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric" });
  const fechaHora = (iso) => new Date(iso).toLocaleString("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  function aviso(texto) {
    const m = $("#mensaje");
    m.textContent = texto;
    m.hidden = !texto;
    if (texto) m.scrollIntoView({ block: "nearest" });
  }
  function error(id, texto) {
    const p = $(id);
    p.textContent = texto || "";
    p.hidden = !texto;
  }

  // ---------- Pedidos ----------
  // Barra de progreso del pedido: en qué paso está y qué falta. Un pedido cancelado no muestra pasos.
  const PASOS = [
    ["recibido", "Recibido"],
    ["pago_confirmado", "Pago confirmado"],
    ["preparando", "Preparando"],
    ["despachado", "Despachado"],
    ["entregado", "Entregado"],
  ];
  function progreso(estado, entrega) {
    if (estado === "cancelado") return "";
    const actual = PASOS.findIndex(([k]) => k === estado);
    if (actual < 0) return "";
    const pasos = PASOS.map(([k, texto], i) => {
      const etiqueta = k === "despachado" && entrega !== "envio" ? "Listo para entregar" : texto;
      const clase = i < actual ? "paso paso--hecho" : i === actual ? "paso paso--actual" : "paso";
      return `<li class="${clase}"${i === actual ? ' aria-current="step"' : ""}>${esc(etiqueta)}</li>`;
    }).join("");
    const nota = actual <= 1 ? '<p class="progreso__nota">Despachamos desde 48 horas después de aprobado el pago.</p>' : "";
    return `<ol class="progreso" aria-label="Estado del pedido">${pasos}</ol>${nota}`;
  }

  function tarjetaPedido(p) {
    const items = p.items.map((i) => {
      const codigo = i.codigo || (i.tipo === "suelto" && i.id ? String(i.id).toUpperCase() : "");
      return `<li>${i.cantidad} × ${esc(i.nombre)}${codigo ? ` <strong class="codigo">${esc(codigo)}</strong>` : ""}${i.tipo === "pack" ? " (prearmado)" : ""}</li>`;
    }).join("");
    const entrega = p.entrega === "envio" ? `Envío a ${esc([p.calle, p.localidad].filter(Boolean).join(", "))}, CP ${esc(p.cp)}, ${esc(p.provincia)}` : `Punto de entrega en ${esc(p.entrega)}`;
    const envio = p.entrega !== "envio" ? "Sin cargo" : p.envio === 0 ? "Gratis" : pesos(p.envio) + (p.envioFuente === "correo" || p.envioFuente === "zona" ? "" : " (estimado)");
    const seguimiento = p.seguimiento ? `<p>Número de seguimiento: <strong>${esc(p.seguimiento)}</strong></p>` : "";
    return `<article class="tarjeta-p" data-id="${esc(p.id)}">
      <div class="pedido__cabeza">
        <strong>${esc(p.numero)}</strong>
        <span class="estado estado--${esc(p.estado)}">${esc(p.estadoTexto)}</span>
      </div>
      <p>${esc(fecha(p.creado))}</p>
      ${progreso(p.estado, p.entrega)}
      <ul>${items}</ul>
      <p>${entrega}. Envío: ${envio}.</p>
      <p><strong>Total: ${pesos(p.total)}</strong></p>
      ${seguimiento}
      <div>
        ${p.pago === "mercadopago" && p.estado === "recibido" ? '<button class="boton boton--primario" type="button" data-pagar>Pagar con Mercado Pago</button>' : ""}
        ${p.factura ? `<button class="boton boton--primario" type="button" data-factura>Descargar factura <small>${esc(p.factura)}</small></button>` : ""}
        <button class="boton boton--claro" type="button" data-historial>Ver el recorrido</button>
        ${["recibido", "pago_confirmado", "preparando"].includes(p.estado) ? '<button class="boton boton--claro" type="button" data-cancelar>Arrepentirme y cancelar</button>' : ""}
      </div>
      <div data-recorrido hidden></div>
    </article>`;
  }

  async function cargarPedidos() {
    const r = await api("/pedidos");
    const cont = $("#pedidos");
    if (!r.ok) { cont.innerHTML = `<p class="error">${esc(r.datos.mensaje || "No pude cargar tus pedidos.")}</p>`; return; }
    cont.innerHTML = r.datos.pedidos.length
      ? r.datos.pedidos.map(tarjetaPedido).join("")
      : '<p>Todavía no hiciste ningún pedido. <a href="/#packs">Elegí tus stickers</a>.</p>';
    // Un pedido cobrado se mide como compra una sola vez (si la medición está habilitada y aceptada).
    if (window.Analitica) r.datos.pedidos.forEach((p) => window.Analitica.compra(p));
  }

  $("#pedidos").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const tarjeta = b.closest("[data-id]");
    const id = tarjeta.dataset.id;
    if (b.hasAttribute("data-historial")) {
      const zona = tarjeta.querySelector("[data-recorrido]");
      if (!zona.hidden) { zona.hidden = true; return; }
      const r = await api(`/pedidos/${id}`);
      if (!r.ok) { aviso(r.datos.mensaje || "No pude cargar el recorrido."); return; }
      zona.innerHTML = `<ol class="linea-tiempo">${r.datos.pedido.historial.map((h) => `<li><strong>${esc(h.estadoTexto)}</strong><small>${esc(fechaHora(h.fecha))}${h.nota ? " · " + esc(h.nota) : ""}</small></li>`).join("")}</ol>`;
      zona.hidden = false;
    } else if (b.hasAttribute("data-factura")) {
      // El PDF no es JSON: se pide directo y se ofrece como archivo para guardar.
      b.disabled = true;
      try {
        const res = await fetch(`/api/pedidos/${id}/factura`);
        if (!res.ok) throw new Error("falla");
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement("a");
        a.href = url; a.download = `Factura-C-${tarjeta.querySelector("[data-factura] small")?.textContent || "Don-Sticker"}.pdf`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      } catch (err) {
        aviso("No pude descargar la factura. Probá de nuevo en un rato.");
      }
      b.disabled = false;
    } else if (b.hasAttribute("data-pagar")) {
      b.disabled = true;
      const r = await api(`/pedidos/${id}/pago`, { method: "POST", cuerpo: {} });
      if (r.ok && r.datos.url) { window.location.href = r.datos.url; return; }
      b.disabled = false;
      aviso(r.datos?.mensaje || "No pude abrir Mercado Pago. Probá de nuevo en un rato.");
    } else if (b.hasAttribute("data-cancelar")) {
      if (!b.dataset.seguro) { b.dataset.seguro = "1"; b.textContent = "¿Seguro? Tocá de nuevo para cancelar"; return; }
      b.disabled = true;
      const r = await api(`/pedidos/${id}/cancelar`, { method: "POST", cuerpo: {} });
      aviso(r.ok ? (r.datos.devolucion ? "Pedido cancelado. Como ya habías pagado, te escribimos para devolverte el importe." : "Pedido cancelado.") : r.datos.mensaje || "No pude cancelar el pedido.");
      cargarPedidos();
    }
  });

  // ---------- Datos, novedades, contraseña, baja ----------
  function pintarUsuario(u) {
    $("#d-mail").textContent = u.email;
    $("#d-nombre").value = u.nombre;
    $("#c-texto").textContent = window.Cuenta.config.textoConsentimiento || "Quiero enterarme antes que nadie de los diseños nuevos, recibir cupones de descuento y entrar a las promociones exclusivas de la familia. Un mail por semana, como máximo, y me doy de baja cuando quiera.";
    $("#c-novedades").checked = u.novedades;
    $("#aviso-mail").hidden = u.mailVerificado;
    $("#seccion-password").hidden = !u.tienePassword;
    $("#sin-password").hidden = u.tienePassword;
  }

  $("#form-datos").addEventListener("submit", async (e) => {
    e.preventDefault();
    error("#d-error", "");
    const r = await api("/cuenta", { method: "PATCH", cuerpo: { nombre: $("#d-nombre").value } });
    if (r.ok) { pintarUsuario(r.datos.usuario); aviso("Datos guardados."); } else error("#d-error", r.datos.mensaje || "No pude guardar los datos.");
  });

  $("#c-novedades").addEventListener("change", async (e) => {
    const r = await api("/cuenta", { method: "PATCH", cuerpo: { novedades: e.target.checked } });
    if (r.ok) aviso(r.datos.usuario.novedades ? "Listo, vas a recibir las novedades." : "Listo, no vas a recibir más novedades.");
    else { e.target.checked = !e.target.checked; aviso(r.datos.mensaje || "No pude guardar el cambio."); }
  });

  $("#form-password").addEventListener("submit", async (e) => {
    e.preventDefault();
    error("#p-error", "");
    const r = await api("/auth/password", { method: "POST", cuerpo: { actual: $("#p-actual").value, nueva: $("#p-nueva").value } });
    if (r.ok) { $("#p-actual").value = ""; $("#p-nueva").value = ""; aviso(r.datos.mensaje); } else error("#p-error", r.datos.mensaje || "No pude cambiar la contraseña.");
  });

  $("#form-eliminar").addEventListener("submit", async (e) => {
    e.preventDefault();
    error("#e-error", "");
    const r = await api("/cuenta", { method: "DELETE", cuerpo: { confirmacion: $("#e-confirmacion").value.trim() } });
    if (r.ok) { location.href = "/"; } else error("#e-error", r.datos.mensaje || "No pude eliminar la cuenta.");
  });

  $("#reenviar").addEventListener("click", async () => {
    const r = await api("/auth/reenviar", { method: "POST", cuerpo: {} });
    aviso(r.ok ? r.datos.mensaje : r.datos.mensaje || "No pude mandar el enlace.");
  });

  $("#salir").addEventListener("click", async () => { await window.Cuenta.cerrarSesion(); location.href = "/"; });

  // ---------- Avisos al celular ----------
  const TEXTOS_PUSH = {
    disponible: "",
    activo: "Activados en este dispositivo.",
    bloqueado: "Bloqueaste las notificaciones de Don Sticker en este navegador. Para activarlas, habilitalas en los ajustes del sitio y volvé acá.",
    instalar: "En iPhone, primero instalá la app: tocá «Compartir» y después «Agregar a pantalla de inicio». Abrila desde ahí y activá los avisos.",
    "sin-soporte": "Este navegador no admite avisos al celular.",
  };
  async function pintarPush() {
    const caja = $("#avisos-celular");
    if (!caja || !window.DonPush) return;
    const e = await window.DonPush.estado();
    caja.hidden = e === "apagado";
    if (e === "apagado") return;
    $("#push-ayuda").textContent = TEXTOS_PUSH[e] || "";
    $("#push-activar").hidden = e !== "disponible";
    $("#push-probar").hidden = e !== "activo";
    $("#push-desactivar").hidden = e !== "activo";
  }
  function mensajePush(texto) {
    const m = $("#push-mensaje");
    if (!m) return;
    m.textContent = texto || "";
    m.hidden = !texto;
  }
  if ($("#push-activar")) {
    $("#push-activar").addEventListener("click", async (ev) => {
      ev.currentTarget.disabled = true;
      const r = await window.DonPush.activar();
      ev.currentTarget.disabled = false;
      mensajePush(r.ok ? "Listo, te voy a avisar cuando cambie el estado de tu pedido." : r.mensaje);
      pintarPush();
    });
    $("#push-desactivar").addEventListener("click", async () => {
      await window.DonPush.desactivar();
      mensajePush("Listo, no te voy a escribir más al celular.");
      pintarPush();
    });
    $("#push-probar").addEventListener("click", async (ev) => {
      ev.currentTarget.disabled = true;
      const r = await window.DonPush.probar();
      ev.currentTarget.disabled = false;
      mensajePush(r.ok ? "Te mandé una prueba. Debería llegar en unos segundos." : r.mensaje);
    });
  }

  // ---------- Arranque ----------
  async function mostrar(u) {
    $("#sin-sesion").hidden = Boolean(u);
    $("#con-sesion").hidden = !u;
    if (u) { pintarUsuario(u); cargarPedidos(); pintarPush(); if (window.DonPush) window.DonPush.sincronizar(); }
  }

  $("#abrir-ingreso").addEventListener("click", async () => {
    const u = await window.Cuenta.abrirIngreso("Ingresá para ver tus pedidos.");
    if (u) mostrar(u);
  });

  window.Cuenta.cargar().then((u) => {
    mostrar(u);
    if (!u) window.Cuenta.abrirIngreso("Ingresá para ver tus pedidos.").then((x) => { if (x) mostrar(x); });
  });
})();
