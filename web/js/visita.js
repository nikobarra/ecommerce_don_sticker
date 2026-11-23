// Avisa que se abrió una página, para el contador de visitas del panel.
// No manda nada de quien visita: solo la ruta y si es la primera página de la sesión.
// La marca de "sesión" vive en sessionStorage, que se borra al cerrar la pestaña:
// no es un identificador ni persiste, así que no hace falta consentimiento.
(function () {
  try {
    const MARCA = "donsticker-visita";
    let nueva = false;
    try {
      nueva = !sessionStorage.getItem(MARCA);
      if (nueva) sessionStorage.setItem(MARCA, "1");
    } catch (e) {
      nueva = true; // sin almacenamiento, cada página cuenta como visita nueva
    }

    const cuerpo = JSON.stringify({ ruta: location.pathname, nueva });
    // sendBeacon no demora la carga de la página ni se corta al navegar.
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/visita", new Blob([cuerpo], { type: "application/json" }));
    } else {
      fetch("/api/visita", { method: "POST", headers: { "Content-Type": "application/json" }, body: cuerpo, keepalive: true }).catch(() => {});
    }
  } catch (e) { /* si falla el conteo, la página sigue andando igual */ }
})();
