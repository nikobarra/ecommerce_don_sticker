// Se carga en el <head>, ANTES de pintar: aplica el modo elegido (claro u oscuro) para que no haya un destello de color.
// Sin elección guardada, manda el modo del dispositivo (prefers-color-scheme, en el CSS).
(function () {
  try {
    var t = localStorage.getItem("donsticker-tema");
    if (t === "oscuro" || t === "claro") document.documentElement.setAttribute("data-tema", t);
  } catch (e) { /* sin almacenamiento: se usa el modo del dispositivo */ }
})();
