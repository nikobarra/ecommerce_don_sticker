// Mejoras de experiencia que van en TODAS las páginas: botón de modo claro/oscuro, app instalable y modo sin conexión.
(function () {
  "use strict";
  const CLAVE = "donsticker-tema";
  const raiz = document.documentElement;
  const oscuroDelSistema = window.matchMedia("(prefers-color-scheme: dark)");
  const leer = () => { try { return localStorage.getItem(CLAVE); } catch (e) { return null; } };
  const escribir = (v) => { try { localStorage.setItem(CLAVE, v); } catch (e) { /* sin almacenamiento */ } };
  const esOscuro = () => (raiz.getAttribute("data-tema") || (oscuroDelSistema.matches ? "oscuro" : "claro")) === "oscuro";

  // ---------- Modo claro / oscuro ----------
  const boton = document.createElement("button");
  boton.type = "button";
  boton.className = "boton-tema";
  function pintarBoton() {
    const oscuro = esOscuro();
    boton.setAttribute("aria-pressed", String(oscuro));
    boton.setAttribute("aria-label", oscuro ? "Modo oscuro: activado. Cambiar a modo claro" : "Modo oscuro: desactivado. Activarlo");
    boton.title = oscuro ? "Pasar a modo claro" : "Pasar a modo oscuro";
    boton.innerHTML = oscuro
      ? '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/></g></svg>'
      : '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M20.5 14.2A8.6 8.6 0 0 1 9.8 3.5a8.6 8.6 0 1 0 10.7 10.7z" fill="currentColor"/></svg>';
  }
  boton.addEventListener("click", () => {
    const nuevo = esOscuro() ? "claro" : "oscuro";
    raiz.setAttribute("data-tema", nuevo);
    escribir(nuevo);
    pintarBoton();
    const t = document.querySelector('meta[name="theme-color"]');
    if (t) t.setAttribute("content", nuevo === "oscuro" ? "#160000" : "#FD0000");
  });
  oscuroDelSistema.addEventListener("change", pintarBoton);
  pintarBoton();
  const fila = document.querySelector(".barra__fila");
  if (fila) {
    const carrito = fila.querySelector(".boton--carrito");
    fila.insertBefore(boton, carrito || null);
  } else {
    boton.classList.add("boton-tema--flotante");
    document.body.appendChild(boton);
  }

  // ---------- App instalable ----------
  // El navegador avisa cuándo se puede instalar; entonces aparece «Instalar la app» donde haya un #instalar.
  let invitacion = null;
  const btnInstalar = document.getElementById("instalar");
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    invitacion = e;
    if (btnInstalar) btnInstalar.hidden = false;
  });
  if (btnInstalar) {
    btnInstalar.addEventListener("click", async () => {
      if (!invitacion) return;
      invitacion.prompt();
      try { await invitacion.userChoice; } catch (e) { /* cerrado sin elegir */ }
      invitacion = null;
      btnInstalar.hidden = true;
    });
  }
  window.addEventListener("appinstalled", () => { if (btnInstalar) btnInstalar.hidden = true; });

  // ---------- Avisos breves (toast) ----------
  // window.Aviso.mostrar(texto, { clave, accion: { texto, fn | href }, ms, lector }).
  // Viven en la capa superior del navegador (popover), así se ven también encima de las ventanas abiertas.
  // «clave» hace que un aviso nuevo reemplace al anterior del mismo tipo; nunca hay más de dos a la vez.
  // lector:false = el aviso es solo visual (la acción ya se anuncia a los lectores de pantalla por otro lado).
  const pila = document.createElement("div");
  pila.className = "avisos";
  pila.setAttribute("popover", "manual");
  const conPopover = typeof pila.showPopover === "function";
  document.body.appendChild(pila);
  if (!conPopover) { pila.style.display = "flex"; pila.style.zIndex = "300"; } // navegador viejo: queda arriba de la página, sin la capa superior
  const sinMov = window.matchMedia("(prefers-reduced-motion: reduce)");
  function quitar(el) {
    if (!el.isConnected) return;
    clearTimeout(el._t);
    const fin = () => { el.remove(); if (conPopover && !pila.children.length && pila.matches(":popover-open")) pila.hidePopover(); };
    if (sinMov.matches) return fin();
    el.classList.add("aviso-toast--sale");
    el.addEventListener("animationend", fin, { once: true });
    setTimeout(fin, 400);
  }
  function mostrar(texto, op) {
    op = op || {};
    if (op.clave) pila.querySelectorAll(`[data-clave="${op.clave}"]`).forEach((x) => x.remove());
    while (pila.children.length >= 2) pila.firstElementChild.remove();
    const el = document.createElement("div");
    el.className = "aviso-toast";
    if (op.clave) el.dataset.clave = op.clave;
    const p = document.createElement("p");
    p.textContent = texto;
    el.appendChild(p);
    if (op.lector === false) el.setAttribute("aria-hidden", "true");
    else el.setAttribute("role", "status");
    if (op.accion) {
      const b = document.createElement(op.accion.href ? "a" : "button");
      b.className = "aviso-toast__accion";
      b.textContent = op.accion.texto;
      if (op.accion.href) b.href = op.accion.href; else b.type = "button";
      if (op.lector === false) b.tabIndex = -1;
      b.addEventListener("click", () => { quitar(el); if (op.accion.fn) op.accion.fn(); });
      el.appendChild(b);
    }
    const cerrar = document.createElement("button");
    cerrar.type = "button";
    cerrar.className = "aviso-toast__cerrar";
    cerrar.setAttribute("aria-label", "Cerrar aviso");
    cerrar.textContent = "×";
    if (op.lector === false) cerrar.tabIndex = -1;
    cerrar.addEventListener("click", () => quitar(el));
    el.appendChild(cerrar);
    pila.appendChild(el);
    if (conPopover && !pila.matches(":popover-open")) pila.showPopover();
    const dura = op.ms || (op.accion ? 6000 : 4000);
    const programar = () => { clearTimeout(el._t); el._t = setTimeout(() => quitar(el), dura); };
    el.addEventListener("pointerenter", () => clearTimeout(el._t));
    el.addEventListener("pointerleave", programar);
    el.addEventListener("focusin", () => clearTimeout(el._t));
    el.addEventListener("focusout", programar);
    programar();
  }
  window.Aviso = { mostrar };

  // Conexión: se avisa al perderla y al recuperarla (solo si antes se avisó la pérdida).
  let sinRed = false;
  window.addEventListener("offline", () => {
    sinRed = true;
    mostrar("Sin conexión. Podés seguir mirando lo que ya cargó.", { clave: "red", ms: 5000 });
  });
  window.addEventListener("online", () => {
    if (!sinRed) return;
    sinRed = false;
    mostrar("Volvió la conexión.", { clave: "red", ms: 3000 });
  });

  // ---------- Modo sin conexión ----------
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => { /* sin SW todo sigue andando */ }); });
  }
})();
