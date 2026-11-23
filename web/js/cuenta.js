// Cuenta del cliente: ventana de ingreso y registro, "Continuar con Google" y estado de la sesión.
// Lo usan todas las páginas. Expone window.Cuenta.
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const estado = { usuario: null, config: { googleClientId: "", mercadoPago: false, analitica: { ga4: "", ads: "", etiquetaCompra: "" }, textoConsentimiento: "", versionConsentimiento: "" }, cargado: false };
  const oyentes = [];

  async function api(ruta, { method = "GET", cuerpo } = {}) {
    try {
      const res = await fetch("/api" + ruta, {
        method,
        headers: cuerpo !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
      });
      const datos = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, datos };
    } catch (e) {
      return { ok: false, status: 0, datos: { mensaje: "No pude conectarme. Revisá tu conexión y probá de nuevo." } };
    }
  }

  function cambiar(usuario) {
    estado.usuario = usuario;
    pintarNav();
    oyentes.forEach((f) => f(usuario));
  }

  async function cargar() {
    const [cfg, yo] = await Promise.all([api("/config"), api("/auth/yo")]);
    if (cfg.ok) estado.config = { ...estado.config, ...cfg.datos };
    estado.cargado = true;
    cambiar(yo.ok ? yo.datos.usuario : null);
    document.dispatchEvent(new CustomEvent("cuenta:config", { detail: estado.config }));
    return estado.usuario;
  }

  // ---------- Botón de la barra ----------
  function pintarNav() {
    const nav = $("#nav-cuenta");
    if (!nav) return;
    const u = estado.usuario;
    nav.classList.toggle("barra__cuenta--sesion", Boolean(u));
    if (nav.parentElement) nav.parentElement.classList.toggle("barra__fila--sesion", Boolean(u));
    // El administrador ve además un acceso directo al panel de pedidos.
    nav.innerHTML = u
      ? `${u.admin ? '<a class="boton boton--cuenta" href="/admin.html">Panel</a>' : ""}<a class="boton boton--cuenta" href="/cuenta">Mi cuenta</a><button class="boton boton--cuenta boton--salir" type="button" id="btn-salir">Salir</button>`
      : `<button class="boton boton--cuenta" type="button" id="btn-ingresar">Ingresar</button>`;
    const b = $("#btn-ingresar");
    if (b) b.addEventListener("click", () => abrirIngreso());
    const s = $("#btn-salir");
    if (s) s.addEventListener("click", salir);
  }

  // Cierra la sesión desde el menú. En las páginas que son solo para quien tiene cuenta, vuelve a la portada.
  async function salir() {
    const boton = $("#btn-salir");
    if (boton) boton.disabled = true;
    await cerrarSesion();
    if (/^\/(cuenta|admin)(\.html)?$/.test(location.pathname)) location.href = "/";
  }

  // ---------- Ventana de ingreso ----------
  // Es un <dialog> nativo: el navegador mantiene el foco adentro, deja el resto de la página inerte, cierra
  // con Escape y devuelve el foco a quien la abrió. Si se abre sobre el carrito (otro <dialog>), se apila.
  let modal = null;
  let resolver = null;
  let resultado = null;

  const VISTAS = { ingreso: "Ingresá a tu cuenta", registro: "Creá tu cuenta", olvide: "Recuperá tu cuenta" };

  function construir() {
    if (modal) return;
    modal = document.createElement("dialog");
    modal.className = "modal";
    modal.id = "modal-cuenta";
    modal.setAttribute("aria-labelledby", "mc-titulo");
    modal.innerHTML = `
      <div class="modal__cabeza">
        <h2 id="mc-titulo">Tu cuenta</h2>
        <button class="cerrar" type="button" id="mc-cerrar" aria-label="Cerrar">×</button>
      </div>
      <div class="modal__cuerpo">
        <p class="aviso" id="mc-aviso" hidden></p>
        <div class="pestanas" role="tablist" id="mc-pestanas" aria-label="Cómo querés entrar">
          <button type="button" role="tab" id="mc-tab-ingreso" data-vista="ingreso" aria-selected="true" aria-controls="mc-panel-ingreso" tabindex="0">Ingresar</button>
          <button type="button" role="tab" id="mc-tab-registro" data-vista="registro" aria-selected="false" aria-controls="mc-panel-registro" tabindex="-1">Crear cuenta</button>
        </div>

        <section role="tabpanel" id="mc-panel-ingreso" aria-labelledby="mc-tab-ingreso" data-vista-panel="ingreso">
          <div class="google" data-google></div>
          <p class="o" data-google-sep>o con tu mail</p>
          <form id="mc-form-ingreso" novalidate>
            <label>Mail <input type="email" name="email" autocomplete="email" required aria-required="true"></label>
            <label>Contraseña <input type="password" name="password" autocomplete="current-password" required aria-required="true"></label>
            <p class="error" id="mc-error-ingreso" data-error role="alert" hidden></p>
            <button class="boton boton--primario boton--ancho" type="submit">Ingresar</button>
            <button class="enlace" type="button" data-ir="olvide">Olvidé mi contraseña</button>
          </form>
        </section>

        <section role="tabpanel" id="mc-panel-registro" aria-labelledby="mc-tab-registro" data-vista-panel="registro" hidden>
          <form id="mc-form-registro" novalidate>
            <label>Tu nombre <input type="text" name="nombre" autocomplete="name" required aria-required="true" maxlength="80"></label>
            <label>Mail <input type="email" name="email" autocomplete="email" required aria-required="true"></label>
            <label>Contraseña <input type="password" name="password" autocomplete="new-password" required aria-required="true" minlength="10" aria-describedby="mc-ayuda-pass"></label>
            <p class="ayuda" id="mc-ayuda-pass">Mínimo 10 caracteres.</p>
            <label class="consentimiento">
              <input type="checkbox" name="novedades" id="mc-novedades">
              <span data-texto-consentimiento></span>
            </label>
            <p class="ayuda">Al crear tu cuenta aceptás los <a href="/terminos" target="_blank" rel="noopener">términos<span class="oculto"> (se abre en otra pestaña)</span></a> y la <a href="/privacidad" target="_blank" rel="noopener">política de privacidad<span class="oculto"> (se abre en otra pestaña)</span></a>.</p>
            <p class="error" id="mc-error-registro" data-error role="alert" hidden></p>
            <button class="boton boton--primario boton--ancho" type="submit">Crear mi cuenta</button>
          </form>
          <p class="o" data-google-sep>o con Google (usa la casilla de novedades de arriba)</p>
          <div class="google" data-google></div>
        </section>

        <section id="mc-panel-olvide" aria-labelledby="mc-titulo" data-vista-panel="olvide" hidden>
          <form id="mc-form-olvide" novalidate>
            <p>Escribí tu mail y te mandamos un enlace para elegir una contraseña nueva.</p>
            <label>Mail <input type="email" name="email" autocomplete="email" required aria-required="true"></label>
            <p class="error" id="mc-error-olvide" data-error role="alert" hidden></p>
            <p class="exito" data-exito role="status" hidden></p>
            <button class="boton boton--primario boton--ancho" type="submit">Mandarme el enlace</button>
            <button class="enlace" type="button" data-ir="ingreso">Volver a ingresar</button>
          </form>
        </section>
      </div>`;
    document.body.append(modal);

    $("#mc-cerrar").addEventListener("click", () => cerrarModal(null));
    // Un clic en el fondo oscuro (que el navegador dirige al propio <dialog>) lo cierra.
    modal.addEventListener("click", (e) => { if (e.target === modal) cerrarModal(null); });
    modal.addEventListener("close", alCerrar);
    modal.querySelectorAll("[data-ir]").forEach((b) => b.addEventListener("click", () => mostrarVista(b.dataset.ir, { enfocar: true })));
    $("#mc-pestanas").addEventListener("click", (e) => { const t = e.target.closest("[data-vista]"); if (t) mostrarVista(t.dataset.vista); });
    $("#mc-pestanas").addEventListener("keydown", teclasDePestanas);
    $("#mc-form-ingreso").addEventListener("submit", enviarIngreso);
    $("#mc-form-registro").addEventListener("submit", enviarRegistro);
    $("#mc-form-olvide").addEventListener("submit", enviarOlvide);
    // Al corregir un campo marcado con error, la marca desaparece.
    modal.addEventListener("input", (e) => limpiarMarca(e.target));
  }

  // Patrón de pestañas: flechas, Inicio y Fin mueven el foco y activan; solo la pestaña activa entra con Tab.
  function teclasDePestanas(e) {
    const tabs = [...modal.querySelectorAll("#mc-pestanas [role=tab]")];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let destino = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") destino = tabs[(i + 1) % tabs.length];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") destino = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === "Home") destino = tabs[0];
    else if (e.key === "End") destino = tabs[tabs.length - 1];
    if (!destino) return;
    e.preventDefault();
    mostrarVista(destino.dataset.vista);
    destino.focus();
  }

  // enfocar: mover el foco al primer campo de la vista. No se hace al activar una pestaña con las flechas,
  // porque el foco tiene que quedarse en la pestaña.
  function mostrarVista(vista, { enfocar = false } = {}) {
    $("#mc-titulo").textContent = VISTAS[vista];
    modal.querySelectorAll("[data-vista-panel]").forEach((s) => (s.hidden = s.dataset.vistaPanel !== vista));
    $("#mc-pestanas").hidden = vista === "olvide";
    modal.querySelectorAll("#mc-pestanas [role=tab]").forEach((b) => {
      const activa = b.dataset.vista === vista;
      b.setAttribute("aria-selected", String(activa));
      b.tabIndex = activa ? 0 : -1;
    });
    modal.querySelectorAll("[data-error]").forEach((p) => { p.hidden = true; p.textContent = ""; });
    modal.querySelectorAll("[aria-invalid]").forEach(limpiarMarca);
    dibujarGoogle();
    if (enfocar) {
      const primero = modal.querySelector(`[data-vista-panel="${vista}"] input`);
      if (primero) primero.focus();
    }
  }

  // ---------- Errores asociados al campo ----------
  function limpiarMarca(campo) {
    if (!campo || !campo.hasAttribute || !campo.hasAttribute("aria-invalid")) return;
    campo.removeAttribute("aria-invalid");
    if (campo.dataset.descripcionAnterior !== undefined) {
      if (campo.dataset.descripcionAnterior) campo.setAttribute("aria-describedby", campo.dataset.descripcionAnterior);
      else campo.removeAttribute("aria-describedby");
      delete campo.dataset.descripcionAnterior;
    }
    const form = campo.closest("form");
    const p = form && $("[data-error]", form);
    if (p && !form.querySelector("[aria-invalid]")) { p.hidden = true; p.textContent = ""; }
  }

  function mostrarError(form, texto, campo) {
    const p = $("[data-error]", form);
    form.querySelectorAll("[aria-invalid]").forEach(limpiarMarca);
    p.textContent = texto;
    p.hidden = !texto;
    if (!texto) return;
    const objetivo = campo || form.querySelector("input");
    if (objetivo) {
      objetivo.dataset.descripcionAnterior = objetivo.getAttribute("aria-describedby") || "";
      objetivo.setAttribute("aria-invalid", "true");
      objetivo.setAttribute("aria-describedby", [objetivo.dataset.descripcionAnterior, p.id].filter(Boolean).join(" "));
      objetivo.focus();
    }
  }

  async function enviarFormulario(form, ruta, cuerpo) {
    const boton = $("button[type=submit]", form);
    const textoOriginal = boton.textContent;
    boton.disabled = true;
    boton.textContent = "Un momento…";
    form.setAttribute("aria-busy", "true");
    mostrarError(form, "");
    const r = await api(ruta, { method: "POST", cuerpo });
    boton.disabled = false;
    boton.textContent = textoOriginal;
    form.removeAttribute("aria-busy");
    return r;
  }

  // Cierra por código y resuelve la promesa ahí mismo (no depende de que llegue el evento "close", que queda
  // para el cierre con Escape). alCerrar es idempotente.
  function cerrarModal(valor) {
    resultado = valor;
    if (modal.open) modal.close();
    alCerrar();
  }

  function exito(usuario) {
    cambiar(usuario);
    cerrarModal(usuario);
  }

  async function enviarIngreso(e) {
    e.preventDefault();
    const f = e.target;
    if (!f.email.value.trim()) return mostrarError(f, "Escribí tu mail.", f.email);
    if (!f.password.value) return mostrarError(f, "Escribí tu contraseña.", f.password);
    const r = await enviarFormulario(f, "/auth/ingreso", { email: f.email.value, password: f.password.value });
    if (r.ok) { f.password.value = ""; exito(r.datos.usuario); } else mostrarError(f, r.datos.mensaje || "No pude ingresar. Probá de nuevo.", r.status === 401 ? f.password : f.email);
  }

  async function enviarRegistro(e) {
    e.preventDefault();
    const f = e.target;
    if (f.nombre.value.trim().length < 2) return mostrarError(f, "Escribí tu nombre.", f.nombre);
    if (!f.email.value.trim()) return mostrarError(f, "Escribí tu mail.", f.email);
    if (f.password.value.length < 10) return mostrarError(f, "La contraseña tiene que tener al menos 10 caracteres.", f.password);
    const r = await enviarFormulario(f, "/auth/registro", { nombre: f.nombre.value, email: f.email.value, password: f.password.value, novedades: f.novedades.checked });
    const campo = r.datos && r.datos.error === "password_invalida" ? f.password : r.datos && /mail/.test(r.datos.error || "") ? f.email : f.nombre;
    if (r.ok) { f.password.value = ""; exito(r.datos.usuario); } else mostrarError(f, r.datos.mensaje || "No pude crear la cuenta. Probá de nuevo.", campo);
  }

  async function enviarOlvide(e) {
    e.preventDefault();
    const f = e.target;
    if (!f.email.value.trim()) return mostrarError(f, "Escribí tu mail.", f.email);
    const r = await enviarFormulario(f, "/auth/olvide", { email: f.email.value });
    const ok = $("[data-exito]", f);
    if (r.ok) { ok.textContent = r.datos.mensaje; ok.hidden = false; } else mostrarError(f, r.datos.mensaje || "No pude enviar el enlace. Probá de nuevo.", f.email);
  }

  // ---------- Google ----------
  let googleListo = false;

  function cargarScriptGoogle() {
    return new Promise((resolver, rechazar) => {
      if (window.google?.accounts?.id) return resolver();
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = resolver;
      s.onerror = rechazar;
      document.head.appendChild(s);
    });
  }

  // El botón de Google se dibuja SOLO en la pestaña visible (si estuviera en las dos, sus elementos internos repetirían
  // los mismos id) y al ancho disponible (Google admite de 200 a 400 px): a 320 px de pantalla no entra uno de 300.
  function dibujarGoogle() {
    if (!googleListo || !window.google) return;
    modal.querySelectorAll("[data-google]").forEach((el) => { el.textContent = ""; });
    const activo = modal.querySelector("[data-vista-panel]:not([hidden]) [data-google]");
    if (!activo || activo.hidden) return;
    const ancho = Math.max(200, Math.min(300, modal.querySelector(".modal__cuerpo").clientWidth - 40));
    window.google.accounts.id.renderButton(activo, { theme: "outline", size: "large", text: "continue_with", locale: "es", width: ancho });
  }

  async function prepararGoogle() {
    const hayGoogle = Boolean(estado.config.googleClientId);
    modal.querySelectorAll("[data-google], [data-google-sep]").forEach((el) => (el.hidden = !hayGoogle));
    if (!hayGoogle) return;
    try {
      if (!googleListo) {
        await cargarScriptGoogle();
        window.google.accounts.id.initialize({
          client_id: estado.config.googleClientId,
          callback: alRecibirGoogle,
          ux_mode: "popup",
          auto_select: false,
        });
      }
      googleListo = true;
      dibujarGoogle();
    } catch (e) {
      modal.querySelectorAll("[data-google], [data-google-sep]").forEach((el) => (el.hidden = true)); // si Google no carga, queda el mail
    }
  }

  async function alRecibirGoogle(respuesta) {
    const registro = !$("[data-vista-panel=registro]", modal).hidden;
    const r = await api("/auth/google", { method: "POST", cuerpo: { credencial: respuesta.credential, novedades: registro && $("#mc-novedades").checked } });
    const form = registro ? $("#mc-form-registro") : $("#mc-form-ingreso");
    if (r.ok) exito(r.datos.usuario);
    else mostrarError(form, r.datos.mensaje || "No pude entrar con Google. Probá de nuevo.");
  }

  // ---------- Abrir y cerrar ----------
  // Devuelve una promesa: el usuario si ingresó, o null si cerró la ventana (con la X, Escape o el fondo).
  function abrirIngreso(aviso, vista = "ingreso") {
    construir();
    if (modal.open) return new Promise((res) => { const previo = resolver; resolver = (v) => { if (previo) previo(v); res(v); }; });
    resultado = null;
    $("[data-texto-consentimiento]", modal).textContent = estado.config.textoConsentimiento || "Quiero enterarme antes que nadie de los diseños nuevos, recibir cupones de descuento y entrar a las promociones exclusivas de la familia. Un mail por semana, como máximo, y me doy de baja cuando quiera.";
    const a = $("#mc-aviso");
    a.textContent = aviso || "";
    a.hidden = !aviso;
    modal.showModal();
    document.body.classList.add("sin-scroll");
    mostrarVista(vista, { enfocar: true });
    prepararGoogle();
    return new Promise((res) => { resolver = res; });
  }

  // 'close' se dispara siempre: por la X, por Escape, por el fondo o por un ingreso exitoso. El foco vuelve solo
  // al elemento que tenía antes de abrirse; si había otro <dialog> debajo (el carrito), sigue abierto.
  function alCerrar() {
    if (!document.querySelector("dialog[open]")) document.body.classList.remove("sin-scroll");
    if (resolver) { const r = resolver; resolver = null; r(resultado); }
  }

  async function cerrarSesion() {
    await api("/auth/salida", { method: "POST", cuerpo: {} });
    cambiar(null);
  }

  window.Cuenta = {
    api, esc, cargar, abrirIngreso, cerrarSesion,
    get usuario() { return estado.usuario; },
    get config() { return estado.config; },
    alCambiar: (f) => oyentes.push(f),
  };

  document.addEventListener("DOMContentLoaded", () => { pintarNav(); cargar(); });
})();
