// Avisos al celular (Web Push) sobre el estado del pedido. Expone window.DonPush.
// Necesita window.Cuenta (sesión y configuración) y el service worker (sw.js), que es quien muestra el aviso.
(function () {
  "use strict";

  const deBase64Url = (t) => {
    const b64 = t.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };
  const clave = () => (window.Cuenta && window.Cuenta.config.pushClave) || "";
  const esIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const instalada = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const hayApi = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  async function suscripcion() {
    if (!hayApi()) return null;
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      return reg ? await reg.pushManager.getSubscription() : null;
    } catch (e) { return null; }
  }

  // Qué se puede hacer en este dispositivo ahora:
  //  "apagado"       el servidor no tiene los avisos encendidos
  //  "instalar"      iPhone/iPad con la app sin instalar (Apple solo permite avisos a las apps instaladas)
  //  "sin-soporte"   el navegador no admite avisos
  //  "bloqueado"     la persona los bloqueó en el navegador
  //  "activo"        ya están activados en este dispositivo
  //  "disponible"    se pueden activar
  async function estado() {
    if (!clave()) return "apagado";
    if (!hayApi()) return esIOS() && !instalada() ? "instalar" : "sin-soporte";
    if (Notification.permission === "denied") return "bloqueado";
    if (Notification.permission === "granted" && (await suscripcion())) return "activo";
    return "disponible";
  }

  async function activar() {
    if (!clave() || !hayApi()) return { ok: false, mensaje: "Este dispositivo no admite los avisos." };
    const permiso = await Notification.requestPermission();
    if (permiso !== "granted") return { ok: false, mensaje: "No diste el permiso, así que no te voy a escribir." };
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: deBase64Url(clave()) });
      const r = await window.Cuenta.api("/push/suscribir", { method: "POST", cuerpo: sub.toJSON() });
      if (!r.ok) { await sub.unsubscribe().catch(() => {}); return { ok: false, mensaje: r.datos.mensaje || "No pude activar los avisos." }; }
      return { ok: true };
    } catch (e) {
      return { ok: false, mensaje: "No pude activar los avisos en este dispositivo." };
    }
  }

  async function desactivar() {
    const sub = await suscripcion();
    if (sub) {
      await window.Cuenta.api("/push/baja", { method: "POST", cuerpo: { endpoint: sub.endpoint } });
      await sub.unsubscribe().catch(() => {});
    }
    return { ok: true };
  }

  // Si el dispositivo ya está suscripto, se avisa de nuevo al servidor (por si cambió de cuenta o la fila se perdió).
  async function sincronizar() {
    const sub = await suscripcion();
    if (sub && Notification.permission === "granted" && window.Cuenta.usuario) {
      window.Cuenta.api("/push/suscribir", { method: "POST", cuerpo: sub.toJSON() });
    }
  }

  async function probar() {
    const r = await window.Cuenta.api("/push/prueba", { method: "POST", cuerpo: {} });
    if (!r.ok) return { ok: false, mensaje: r.datos.mensaje || "No pude mandar la prueba." };
    return r.datos.enviados > 0 ? { ok: true } : { ok: false, mensaje: "No pude entregarla. Probá desactivar y volver a activar los avisos." };
  }

  window.DonPush = { estado, activar, desactivar, sincronizar, probar };
})();
