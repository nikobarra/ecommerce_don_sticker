import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
	worker: {
		name: "donsticker",
		compatibilityDate: "2026-11-13",
		entrypoint: "src/index.js",
		// Tarea periódica cada 15 min (scheduled en src/index.js): reintentos de facturas, conciliación de pagos,
		// recordatorios, limpieza y mail semanal. Verificada activa en producción el 23/11/2026.
		triggers: [triggers.scheduled({ schedule: "*/15 * * * *" })],
		observability: {
			enabled: true,
		},
		assets: {
			runWorkerFirst: [
				"/api/*",
				"/baja",
			],
		},
		env: {
			// --- Correo Argentino (cotización de envíos). Las claves son secretos: MICORREO_USER, MICORREO_PASSWORD, MICORREO_CUSTOMER_ID.
			// MICORREO_AMBIENTE: "prueba" o "produccion". Con "prueba" (o sin valor) las tarifas del Correo se
			// tratan como NO definitivas: se muestran como estimadas y bloquean el cobro con Mercado Pago.
			// Para vender de verdad: cargar las credenciales de producción como secretos y poner "produccion".
			// (La dirección de la API sale de este valor; ya no hay que tocar MICORREO_BASE.)
			MICORREO_AMBIENTE: bindings.text("prueba"),
			CP_ORIGEN: bindings.text("7620"),
			RECARGO_PORCENTAJE: bindings.text("0"),
			// --- Mercado Pago. Son SECRETOS: MP_ACCESS_TOKEN y MP_WEBHOOK_SECRET.
			// Mientras no estén cargados, la web solo ofrece transferencia.
			// MP_DIAGNOSTICO en "1" le muestra a quien hizo el pedido el motivo que devuelve Mercado Pago cuando
			// falla el cobro (nunca la clave). Es solo para configurar: en producción va en "0".
			MP_DIAGNOSTICO: bindings.text("0"),
			// --- Facturación electrónica ARCA (Factura C, monotributo). APAGADA por defecto.
			// Son SECRETOS: ARCA_CERT (certificado .crt) y ARCA_KEY (clave privada .key), en formato PEM.
			// FACTURACION_ACTIVA "1" la enciende (solo factura pagos de Mercado Pago). ARCA_AMBIENTE: "prueba" (sin validez fiscal)
			// o "produccion". ARCA_PTO_VTA: punto de venta de Web Services. Ver Docs/FACTURACION.md.
			FACTURACION_ACTIVA: bindings.text("1"),   // ENCENDIDA el 23/11/2026. Para apagarla: "0" y cf deploy.
			ARCA_AMBIENTE: bindings.text("produccion"),
			ARCA_CUIT: bindings.text("20274973022"),
			ARCA_PTO_VTA: bindings.text("11"),
			// --- Avisos al celular (Web Push, worker/src/push.js). Se encienden solo con las DOS claves: esta pública y el
			// SECRETO VAPID_PRIVATE_KEY (cf workers secrets update VAPID_PRIVATE_KEY --worker donsticker --type secret_text).
			// La privada está guardada fuera del proyecto, en ~/.donsticker/vapid-privada.txt. Si se cambia el par, los
			// dispositivos suscriptos dejan de recibir y hay que volver a activar los avisos.
			VAPID_PUBLIC_KEY: bindings.text("BJnh34meYieM7i8DsrlZZ8pOOXzYFgRMmhowSaPQaWdj0Q9iQbLSFnO4EDVa59ZXlR3_w6W1B70QiDly3g1vRn4"),
			VAPID_SUBJECT: bindings.text("mailto:donsticker.ar@gmail.com"),
			// --- Analítica (opcional; vacío = no se carga nada ni se muestra ningún aviso). Ver Docs/ANALITICA.md.
			// GA4_ID ("G-XXXXXXXXXX"), ADS_ID ("AW-XXXXXXXXX") y ADS_ETIQUETA_COMPRA se agregan acá cuando existan.
			// --- Cuentas y panel
			ADMIN_EMAILS: bindings.text("donsticker.ar@gmail.com"),
			GOOGLE_CLIENT_ID: bindings.text("1003202832939-pegs7o1ggonbou6kdh4lsq2hf825g8hp.apps.googleusercontent.com"),
			// --- Mails: "log" guarda los mails en la base sin enviarlos. Cambiar a "resend" cuando haya servicio de mail.
			MAIL_PROVIDER: bindings.text("resend"),
			MAIL_FROM: bindings.text("Don Sticker <pedidos@mail.donsticker.com.ar>"),
			MAIL_FROM_NEWS: bindings.text("Don Sticker <novedades@news.donsticker.com.ar>"),
			MAIL_REPLY_TO: bindings.text("donsticker.ar@gmail.com"),
			// --- Mail semanal de novedades (worker/src/novedades.js). "1" lo activa; con "0" no se arma ni se manda
			// nada, pero la vista previa y la prueba del panel funcionan. Sale los jueves desde las 13 UTC (10 h de
			// Argentina), hasta 80 mails por día en tandas de 15 (el resto del cupo de Resend queda para los avisos).
			// El dueño (ADMIN_EMAILS) recibe siempre una copia, aunque no esté suscripto. Activado el 17/11/2026.
			NOVEDADES_ACTIVO: bindings.text("1"),
			SITE_URL: bindings.text("https://donsticker.com.ar"),
			ASSETS: bindings.assets(),
			DB: bindings.d1({ name: "donsticker-db", id: "d5148541-dd8b-45c4-a188-73339e6e77dc" }),
		},
	},
});
