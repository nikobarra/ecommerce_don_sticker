// Las tarjetas y los bloques aparecen a medida que se baja la página.
// Si el navegador no soporta IntersectionObserver o se pide menos movimiento,
// no se toca nada y todo queda visible desde el principio.
(function () {
  if (!("IntersectionObserver" in window)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const SELECTORES = ".tarjeta, .escalon, .franja__fila p, #dudas details, .revender > div, .revender > img";

  const mirador = new IntersectionObserver(function (entradas) {
    entradas.forEach(function (e) {
      if (!e.isIntersecting) return;
      mostrar(e.target);
    });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });

  function mostrar(el) {
    el.classList.add("aparece--visible");
    mirador.unobserve(el);
  }

  // El retraso escalonado hace que los hermanos entren uno atrás del otro.
  // Las tarjetas y los escalones entran de costado, alternando izquierda y derecha.
  function preparar(el, i) {
    if (el.classList.contains("aparece")) return;
    el.classList.add("aparece");
    if (el.matches(".tarjeta, .escalon")) {
      el.classList.add(i % 2 ? "aparece--der" : "aparece--izq");
    }
    el.style.transitionDelay = Math.min(i, 7) * 60 + "ms";
    mirador.observe(el);
  }

  function revisar(raiz) {
    const grupos = new Map();
    (raiz || document).querySelectorAll(SELECTORES).forEach(function (el) {
      const padre = el.parentElement;
      const n = grupos.get(padre) || 0;
      grupos.set(padre, n + 1);
      preparar(el, n);
    });
  }

  revisar();

  // Quien navega con el teclado puede llegar a un botón antes de que su tarjeta haya aparecido: al recibir
  // el foco, la tarjeta se muestra de inmediato y sin demora. Nunca queda algo enfocable e invisible.
  document.addEventListener("focusin", function (e) {
    const tarjeta = e.target.closest && e.target.closest(".aparece:not(.aparece--visible)");
    if (!tarjeta) return;
    tarjeta.style.transitionDelay = "0ms";
    mostrar(tarjeta);
  });

  // Las tarjetas se arman con JavaScript y se vuelven a armar al filtrar.
  if (window.MutationObserver) {
    const observador = new MutationObserver(function (cambios) {
      cambios.forEach(function (c) {
        if (c.addedNodes.length) revisar(c.target);
      });
    });
    ["#grilla", "#grilla-packs", "#escalones"].forEach(function (sel) {
      const caja = document.querySelector(sel);
      if (caja) observador.observe(caja, { childList: true });
    });
  }
})();
