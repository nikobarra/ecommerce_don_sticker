// Formulario «Sugerí un diseño». Solo lo puede enviar quien tiene cuenta, el mail confirmado y las novedades activadas.
// La sugerencia no se guarda en la web: el servidor la manda por mail al dueño (POST /api/sugerencias).
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const caja = $("#sug-caja");
  if (!caja) return;

  const estado = $("#sug-estado");
  const requisitos = $("#sug-requisitos");
  const acciones = $("#sug-acciones");
  const form = $("#sug-form");
  const ok = $("#sug-ok");
  const err = $("#sug-error");

  function boton(texto, alClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "boton boton--primario";
    b.textContent = texto;
    b.addEventListener("click", alClick);
    return b;
  }

  function pintar() {
    const u = window.Cuenta && window.Cuenta.usuario;
    acciones.textContent = "";
    form.hidden = true;
    requisitos.hidden = false;

    if (!u) {
      estado.textContent = "Para sugerir un diseño, primero pasá por la puerta: creá tu cuenta o ingresá.";
      acciones.append(boton("Crear cuenta o ingresar", () => window.Cuenta.abrirIngreso("Ingresá o creá tu cuenta para sugerir un diseño.", "registro")));
      return;
    }
    if (!u.mailVerificado) {
      estado.textContent = "Falta confirmar tu mail. Tocá el enlace que te mandamos y volvé acá.";
      return;
    }
    if (!u.novedades) {
      estado.textContent = "Una cosa más: las sugerencias son para quienes reciben las novedades de la casa.";
      const label = document.createElement("label");
      label.className = "consentimiento";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.id = "sug-consentimiento";
      const texto = document.createElement("span");
      texto.textContent = (window.Cuenta.config && window.Cuenta.config.textoConsentimiento) || "Quiero enterarme antes que nadie de los diseños nuevos, recibir cupones de descuento y entrar a las promociones exclusivas de la familia. Un mail por semana, como máximo, y me doy de baja cuando quiera.";
      label.append(check, texto);
      const aviso = document.createElement("p");
      aviso.className = "error";
      aviso.setAttribute("role", "alert");
      aviso.hidden = true;
      const activar = boton("Activar novedades", async () => {
        aviso.hidden = true;
        if (!check.checked) { aviso.textContent = "Marcá la casilla para activar las novedades."; aviso.hidden = false; return; }
        activar.disabled = true;
        const r = await window.Cuenta.api("/cuenta", { method: "PATCH", cuerpo: { novedades: true } });
        if (r.ok) { await window.Cuenta.cargar(); return; }
        activar.disabled = false;
        aviso.textContent = (r.datos && r.datos.mensaje) || "No pude activar las novedades. Probá de nuevo.";
        aviso.hidden = false;
      });
      acciones.append(label, aviso, activar);
      return;
    }
    estado.textContent = "Contame qué diseño te gustaría ver.";
    requisitos.hidden = true;
    form.hidden = false;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    ok.hidden = true;
    const idea = $("#sug-idea").value.trim();
    if (idea.length < 10) { err.textContent = "Contanos un poco más: escribí al menos 10 letras sobre el diseño que imaginás."; err.hidden = false; return; }
    const enviar = $("#sug-enviar");
    enviar.disabled = true;
    const r = await window.Cuenta.api("/sugerencias", { method: "POST", cuerpo: { idea, referencia: $("#sug-ref").value.trim() } });
    enviar.disabled = false;
    if (r.ok) {
      $("#sug-idea").value = "";
      $("#sug-ref").value = "";
      ok.textContent = "Me llegó tu sugerencia. Gracias… la voy a mirar con atención.";
      ok.hidden = false;
      return;
    }
    if (r.status === 401 || (r.datos && (r.datos.error === "sin_novedades" || r.datos.error === "mail_sin_verificar"))) { await window.Cuenta.cargar(); return; }
    err.textContent = (r.datos && r.datos.mensaje) || "No pude enviar tu sugerencia. Probá de nuevo.";
    err.hidden = false;
  });

  // Hasta que la cuenta se carga (primer aviso de Cuenta.alCambiar) queda el «Un momento…» del HTML.
  document.addEventListener("DOMContentLoaded", () => { if (window.Cuenta) window.Cuenta.alCambiar(pintar); });
})();
