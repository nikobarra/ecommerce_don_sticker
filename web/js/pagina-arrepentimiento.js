// Botón de arrepentimiento: el cliente cancela su compra mientras el pedido no se haya despachado.
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const { api, esc } = window.Cuenta;
  const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");
  const fecha = (iso) => new Date(iso).toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric" });
  const CANCELABLES = ["recibido", "pago_confirmado", "preparando"];

  function aviso(texto) {
    const m = $("#mensaje");
    m.textContent = texto;
    m.hidden = !texto;
    if (texto) m.scrollIntoView({ block: "nearest" });
  }

  function tarjeta(p) {
    const items = p.items.map((i) => `<li>${i.cantidad} × ${esc(i.nombre)}${i.tipo === "pack" ? " (prearmado)" : ""}</li>`).join("");
    let accion;
    if (CANCELABLES.includes(p.estado)) {
      accion = `<button class="boton boton--peligro" type="button" data-arrepentirme>Arrepentirme de esta compra</button>
        <p class="ayuda">${p.estado === "recibido" ? "Todavía no se confirmó el pago." : "Ya se confirmó tu pago: te devolvemos el importe."}</p>`;
    } else if (p.estado === "cancelado") {
      accion = "<p><strong>Este pedido ya está cancelado.</strong></p>";
    } else {
      accion = "<p>Este pedido ya fue despachado, así que no se puede cancelar desde acá. Escribinos a donsticker.ar@gmail.com con el número de pedido y lo resolvemos.</p>";
    }
    return `<article class="tarjeta-p" data-id="${esc(p.id)}">
      <div class="pedido__cabeza"><strong>${esc(p.numero)}</strong><span class="estado estado--${esc(p.estado)}">${esc(p.estadoTexto)}</span></div>
      <p>${esc(fecha(p.creado))} · <strong>${pesos(p.total)}</strong></p>
      <ul>${items}</ul>
      ${accion}
    </article>`;
  }

  async function cargar() {
    const r = await api("/pedidos");
    const cont = $("#pedidos");
    if (!r.ok) { cont.innerHTML = `<p class="error">${esc(r.datos.mensaje || "No pude cargar tus pedidos.")}</p>`; return; }
    cont.innerHTML = r.datos.pedidos.length ? r.datos.pedidos.map(tarjeta).join("") : '<p>Todavía no hiciste ningún pedido con esta cuenta.</p>';
  }

  $("#pedidos").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-arrepentirme]");
    if (!b) return;
    // Pide una segunda confirmación para evitar cancelaciones por un toque sin querer.
    if (!b.dataset.seguro) {
      b.dataset.seguro = "1";
      b.textContent = "¿Seguro? Tocá de nuevo para confirmar";
      setTimeout(() => { if (b.isConnected) { delete b.dataset.seguro; b.textContent = "Arrepentirme de esta compra"; } }, 6000);
      return;
    }
    b.disabled = true;
    const id = b.closest("[data-id]").dataset.id;
    const r = await api(`/pedidos/${id}/cancelar`, { method: "POST", cuerpo: {} });
    if (r.ok) {
      aviso(r.datos.devolucion
        ? `Cancelamos tu pedido ${r.datos.pedido.numero}. Como ya habías pagado, te escribimos para devolverte el importe.`
        : `Cancelamos tu pedido ${r.datos.pedido.numero}. No hay nada que devolver porque todavía no habías pagado.`);
    } else {
      aviso(r.datos.mensaje || "No pude cancelar el pedido. Probá de nuevo.");
    }
    cargar();
  });

  function mostrar(u) {
    $("#sin-sesion").hidden = Boolean(u);
    $("#con-sesion").hidden = !u;
    if (u) cargar();
  }

  $("#abrir-ingreso").addEventListener("click", async () => {
    const u = await window.Cuenta.abrirIngreso("Ingresá con la cuenta con la que hiciste el pedido.");
    if (u) mostrar(u);
  });

  window.Cuenta.cargar().then(mostrar);
})();
