// Página de vuelta desde Mercado Pago. No le cree a lo que viene en la dirección:
// le pregunta al servidor cómo quedó el pedido, que es lo único que vale.
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const { api } = window.Cuenta;
  const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  const parametros = new URLSearchParams(location.search);
  const numero = (parametros.get("pedido") || "").toUpperCase();
  const falloEnMercadoPago = parametros.get("estado") === "error";

  function poner(titulo, mensaje) {
    $("#titulo").innerHTML = titulo;
    $("#mensaje").textContent = mensaje;
  }

  function mostrarPedido(p) {
    $("#d-numero").textContent = p.numero;
    $("#d-estado").textContent = p.estadoTexto;
    $("#d-total").textContent = `Total: ${pesos(p.total)}`;
    $("#detalle").hidden = false;
  }

  // El aviso de Mercado Pago puede tardar unos segundos: se consulta varias veces.
  async function esperarAcreditacion() {
    for (let intento = 0; intento < 6; intento++) {
      const r = await api(`/pedidos/numero/${encodeURIComponent(numero)}`);
      if (r.status === 401) return { sinSesion: true };
      if (!r.ok) return { error: r.datos?.mensaje || "No encontré ese pedido." };
      const p = r.datos.pedido;
      if (p.estado !== "recibido") return { pedido: p };
      if (intento < 5) await dormir(2000);
      else return { pedido: p, pendiente: true };
    }
    return {};
  }

  (async function () {
    await window.Cuenta.cargar();

    if (!numero) {
      poner('Volviste de <span class="prota">Mercado Pago</span>', "No sé de qué pedido se trata. Entrá a «Mis pedidos» y ahí lo ves.");
      return;
    }
    if (falloEnMercadoPago) {
      poner('El pago <span class="prota">no se completó</span>', "Mercado Pago no pudo cobrar. Tu pedido quedó guardado: podés volver a intentarlo desde «Mis pedidos», o escribirme y lo arreglamos por transferencia.");
      return;
    }

    const r = await esperarAcreditacion();
    if (r.sinSesion) {
      poner('Volviste de <span class="prota">Mercado Pago</span>', "Ingresá a tu cuenta para ver cómo quedó el pedido.");
      return;
    }
    if (r.error) { poner('Volviste de <span class="prota">Mercado Pago</span>', r.error); return; }
    if (!r.pedido) return;

    mostrarPedido(r.pedido);
    if (window.Analitica) window.Analitica.compra(r.pedido); // solo mide si el pago ya está confirmado
    if (r.pendiente) {
      poner('Tu pago está <span class="prota">en camino</span>', "Mercado Pago todavía no nos avisó que se acreditó. Puede tardar un rato, sobre todo si pagaste en efectivo. Apenas se acredite te mandamos un mail y lo vas a ver en «Mis pedidos».");
    } else if (r.pedido.estado === "cancelado") {
      poner('Este pedido está <span class="prota">cancelado</span>', "Si creés que hay un error, escribime y lo vemos.");
    } else {
      poner('Listo: <span class="prota">pago confirmado</span>', "Recibí tu pago. Ya me pongo con tu pedido y te aviso por mail en cada paso.");
    }
  })();
})();
