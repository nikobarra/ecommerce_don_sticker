// Páginas que se abren desde un enlace de mail: restablecer contraseña y confirmar mail.
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const { api } = window.Cuenta;
  const token = new URLSearchParams(location.search).get("token") || "";
  // Se saca el token de la barra de direcciones para que no quede en el historial ni se comparta sin querer.
  if (token) history.replaceState(null, "", location.pathname);

  const accion = document.body.dataset.accion;

  if (accion === "verificar") {
    const estado = $("#estado-verificacion");
    (async () => {
      if (!token) { estado.textContent = "El enlace no es válido. Pedí uno nuevo desde tu cuenta."; return; }
      const r = await api("/auth/verificar", { method: "POST", cuerpo: { token } });
      estado.textContent = r.ok ? r.datos.mensaje : r.datos.mensaje || "No pude confirmar tu mail.";
      $("#ingresar").hidden = false;
    })();
  }

  if (accion === "restablecer") {
    if (!token) {
      $("#formulario").hidden = true;
      const l = $("#listo");
      l.textContent = "El enlace no es válido. Pedí uno nuevo desde «Olvidé mi contraseña».";
      l.hidden = false;
    }
    $("#form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#error");
      err.hidden = true;
      const r = await api("/auth/restablecer", { method: "POST", cuerpo: { token, password: $("#nueva").value } });
      if (r.ok) {
        $("#formulario").hidden = true;
        $("#listo").textContent = r.datos.mensaje;
        $("#listo").hidden = false;
        $("#ingresar").hidden = false;
      } else {
        err.textContent = r.datos.mensaje || "No pude guardar la contraseña.";
        err.hidden = false;
      }
    });
  }
})();
