// Sugerencias de diseños. NO se guardan en ninguna base: la sugerencia se manda por mail al dueño
// (el primer mail de ADMIN_EMAILS) y listo. Si el mail no sale, se avisa y se le pide a la persona que
// pruebe de nuevo, porque no queda copia en ningún lado.
//
// Para enviar hay que tener cuenta, el mail verificado y las novedades activadas (lo decidió el dueño).

import { json, error, leerJson, limpiarTexto, limitar } from "./util.js";
import { usuarioActual } from "./auth.js";
import { enviarMail, mailSugerencia } from "./mail.js";

const MIN_IDEA = 10;
const MAX_IDEA = 600;
const MAX_REFERENCIA = 200;
const MAX_POR_DIA = 3;

export async function crearSugerencia(request, env) {
  const u = await usuarioActual(env, request);
  if (!u) return error("sin_sesion", "Ingresá o creá tu cuenta para sugerir un diseño.", 401);
  if (!u.email_verified) return error("mail_sin_verificar", "Confirmá tu mail desde el enlace que te mandamos y volvé a probar.", 403);
  if (!u.marketing_consent) return error("sin_novedades", "Para sugerir un diseño tenés que estar suscripto a las novedades. Activalas y volvé a probar.", 403);

  const lectura = await leerJson(request, 4000);
  if (!lectura.ok) return lectura.respuesta;
  const idea = limpiarTexto(lectura.datos.idea, MAX_IDEA);
  const referencia = limpiarTexto(lectura.datos.referencia, MAX_REFERENCIA);
  if (idea.length < MIN_IDEA) return error("idea_corta", `Contanos un poco más: escribí al menos ${MIN_IDEA} letras sobre el diseño que imaginás.`);

  const dueno = String(env.ADMIN_EMAILS || "").split(",")[0].trim();
  if (!dueno) return error("sin_destino", "Ahora no podemos recibir sugerencias. Probá más tarde.", 503);

  if (!(await limitar(env, `sugerencia:${u.id}`, MAX_POR_DIA, 24 * 3600))) {
    return error("demasiadas_sugerencias", "Ya nos mandaste varias sugerencias hoy. Gracias; seguí mañana.", 429);
  }

  try {
    await enviarMail(env, { to: dueno, replyTo: u.email, ...mailSugerencia({ nombre: u.name, mail: u.email, idea, referencia }) });
  } catch (e) {
    console.error("Sugerencia no enviada:", e.message); // sin el texto ni el mail de la persona
    return error("no_enviada", "No pudimos enviar tu sugerencia ahora. Probá de nuevo en un rato.", 502);
  }
  return json({ ok: true }, 201);
}
