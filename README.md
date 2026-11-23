# Don Sticker · la web

Tienda online de **stickers de vinilo** de Don Sticker (Balcarce, Buenos Aires): [donsticker.com.ar](https://donsticker.com.ar).
Se compran por unidad o en packs prearmados, se paga con transferencia o Mercado Pago, se envía por Correo Argentino
y cada pago de Mercado Pago genera automáticamente su **factura electrónica de ARCA** (ex AFIP).

Este repositorio contiene **solo la web**: el sitio (`web/`) y el servidor (`worker/`). El catálogo con los originales de
impresión, el material de redes, los documentos y las herramientas de diseño **no** están acá (ver [Qué no está en el repositorio](#qué-no-está-en-el-repositorio)).

---

## Índice

1. [Tecnología](#tecnología)
2. [Estructura del repositorio](#estructura-del-repositorio)
3. [Qué hace el sitio (para el cliente)](#qué-hace-el-sitio-para-el-cliente)
4. [Cuentas y seguridad de acceso](#cuentas-y-seguridad-de-acceso)
5. [Pedidos, precios y envíos](#pedidos-precios-y-envíos)
6. [Pagos con Mercado Pago](#pagos-con-mercado-pago)
7. [Facturación electrónica (ARCA)](#facturación-electrónica-arca)
8. [Panel del dueño](#panel-del-dueño)
9. [Mails](#mails)
10. [Analítica y privacidad](#analítica-y-privacidad)
11. [SEO, rendimiento y accesibilidad](#seo-rendimiento-y-accesibilidad)
12. [Seguridad](#seguridad)
13. [Base de datos](#base-de-datos)
14. [API](#api)
15. [Configuración y secretos](#configuración-y-secretos)
16. [Desarrollo, pruebas y despliegue](#desarrollo-pruebas-y-despliegue)
17. [Tareas programadas](#tareas-programadas)
18. [Qué no está en el repositorio](#qué-no-está-en-el-repositorio)

---

## Tecnología

| Capa | Qué se usa |
|---|---|
| Sitio | HTML, CSS y JavaScript **sin frameworks ni paso de compilación**. Archivos estáticos servidos por Cloudflare. |
| Servidor | **Cloudflare Worker** (JavaScript, módulos ES) que atiende `/api/*` y `/baja`. |
| Base de datos | **Cloudflare D1** (SQLite). Migraciones en `worker/migrations/`. |
| Pagos | **Mercado Pago** (Checkout Pro) con aviso (webhook) firmado y conciliación. |
| Envíos | API de **MiCorreo** (Correo Argentino) con tarifas por zona de respaldo. |
| Mails | **Resend**. |
| Ingreso con Google | **Google Identity Services**. |
| Facturación | **ARCA**: login (WSAA) y facturación electrónica (WSFE), cliente propio sin librerías. |
| Pruebas | `node:test` con una base SQLite en memoria que imita a D1. **273 pruebas.** |

No hay dependencias de ejecución: el servidor usa solo las funciones que trae Cloudflare (WebCrypto, `fetch`, D1). Lo único de
terceros incluido en el código es un generador de códigos QR (`worker/src/vendor/`, licencia MIT).

## Estructura del repositorio

```
web/                      El sitio (se publica tal cual)
  index.html              Portada y tienda
  packs.html              Packs prearmados
  cuenta.html             Mi cuenta
  admin.html              Panel del dueño
  pago.html               Vuelta desde Mercado Pago
  arrepentimiento.html    Botón de arrepentimiento
  privacidad.html · terminos.html · restablecer.html · verificar.html
  css/styles.css          Todos los estilos
  js/                     Un archivo por pantalla o función (app, cuenta, packs, panel, analítica…)
  assets/                 Imágenes del catálogo (con marca de agua), packs, logos, escena animada
  _headers                Cabeceras de seguridad y caché
  robots.txt · sitemap.xml · novedades.json

worker/                   El servidor
  src/                    Código del Worker (un módulo por tema)
  migrations/             Esquema de la base, en orden (0001 a 0010)
  scripts/                Prerender del HTML, pruebas contra ARCA, utilidades
  test/                   Pruebas automáticas
  cloudflare.config.ts    Configuración de despliegue REAL (cf deploy)
```

---

## Qué hace el sitio (para el cliente)

### Portada
- **Portada** con el eslogan, los botones «Ver los packs» y «Elegir uno por uno», y un aviso destacado de **3 cuotas sin interés** con Mercado Pago.
- **Banda en movimiento** con los stickers más vendidos y los últimos que salieron (se arma desde la API).
- **Franja de beneficios**: cantidad de diseños, precio mínimo por unidad y envíos a todo el país.
- Escena animada del escritorio (video y fotos en versión escritorio y móvil).

### Packs prearmados
- Cuatro tamaños: **10, 25, 50 y 100 stickers**, con **10 packs distintos de cada tamaño** y sin diseños repetidos dentro de un mismo tamaño. Más **packs temáticos** (rock, Simpsons, fútbol, K-pop, fauna, Mafalda, etc.).
- Cada pack muestra una portada con sus diseños. Salen **10 % menos** que armar la misma cantidad a elección.
- Se elige el tamaño y después cuál pack; el pedido se guarda en el navegador hasta confirmarlo.

### Stickers a elección (catálogo)
- Catálogo de **más de 1.200 diseños** con imágenes con marca de agua.
- **Filtros por categoría** (rock, humor argentino, fútbol, series, Mafalda, K-pop…), **buscador** que ignora tildes y entiende alias, **orden** (más nuevos primero o por nombre) y **paginación**.
- Sección **Novedades** con los últimos 100 diseños.
- **Precio por cantidad** (se aplica a todo el pedido, no solo a los stickers de más): 1 a 9 → $700 c/u · desde 10 → $630 · desde 25 → $595 · desde 50 → $560 · desde 100 → $525. El carrito avisa «te faltan N para el próximo precio».
- Por **transferencia hay 10 % de descuento**, redondeado a los $10.

### Emprendé
Sección para quien quiere **revender**: tabla de costo por sticker según el pack y **metas realistas** (cuánto se gana vendiendo 50, 70 o los 100 a $1.000, $1.200 o $1.500), con las aclaraciones de envío y de que son cuentas de ejemplo.

### A medida
Stickers personalizados (mascotas y familia, estilos como caricatura o animado, logos de emprendimientos): se pide por WhatsApp. Aclara que las fotos se usan solo para el diseño y que no se publican sin autorización escrita.

### Sugerí un diseño
Formulario para sugerir diseños. Solo lo envía quien tiene cuenta, mail confirmado y novedades activadas. **No se guarda en la base**: llega por mail al dueño.

### Preguntas frecuentes
Acordeón con las dudas de siempre: material y resistencia, cómo se pide, cómo se paga, factura, envíos, cancelaciones, cuenta y datos.

### Pie de página
Botón de arrepentimiento, política de privacidad, términos y condiciones, enlace de **Defensa del Consumidor**, el sello de **Data Fiscal (ARCA)** con su QR y el crédito del desarrollo.

### Páginas privadas (no se indexan)
`/cuenta`, `/admin`, `/pago`, `/restablecer`, `/verificar`: llevan `noindex`.

---

## Cuentas y seguridad de acceso

- **Registro e ingreso** con mail y contraseña, o con **Google**. La contraseña no se guarda: solo un hash cifrado.
- **Confirmación de mail** por enlace de un solo uso (vence a las 24 h) y **recuperación de contraseña** (vence en 1 h).
- **Sesiones** con cookie `HttpOnly`; en la base solo se guarda el hash del identificador, nunca el valor de la cookie.
- **Límite de intentos** por cuenta y por huella anónima de IP (la IP no se guarda).
- Para hacer un pedido hace falta tener cuenta.

### Mi cuenta
- **Pedidos** con barra de progreso (Recibido → Pago confirmado → Preparando → Despachado → Entregado), detalle, envío, seguimiento y **recorrido** con fecha de cada cambio.
- **Pagar** con Mercado Pago un pedido que quedó pendiente.
- **Arrepentirse y cancelar** mientras el pedido no se despachó.
- **Descargar la factura** (PDF) de cada pedido ya facturado.
- Editar el nombre, cambiar la contraseña, activar o quitar las **novedades por mail** (consentimiento expreso, con fecha y medio de aceptación).
- **Descargar una copia de todos los datos** y **eliminar la cuenta** (los pedidos quedan sin datos personales).

---

## Pedidos, precios y envíos

- **El navegador nunca decide cuánto se cobra.** El servidor recalcula todo (`worker/src/precios.js`) con los mismos datos que muestra el sitio; una prueba automática exige que la web y el servidor coincidan al centavo.
- Se puede **retirar** en Balcarce o Mar del Plata (sin cargo) o recibir por **Correo Argentino**.
- **Costo de envío**: tarifa del Correo (MiCorreo) cuando está habilitada y, si no, **precio fijo por zona** según la provincia ($14.000 · $19.000 · $24.000). Siempre se cobra; se ve con el total antes de pagar.
- Cada pedido tiene un **número visible** (`DS-XXXXXX`), historial de estados y clave de **idempotencia** para que un doble clic no duplique el pedido.
- Los packs prearmados guardan **qué diseños llevan**, para que el dueño sepa qué preparar.
- Límite de pedidos por cuenta y por hora.

---

## Pagos con Mercado Pago

- **Checkout Pro**: el cliente paga en el sitio de Mercado Pago y vuelve. La web **nunca ve ni guarda datos de tarjetas**.
- **Aviso (webhook) firmado**: se valida la firma y después se le **pregunta a Mercado Pago** qué pasó de verdad. Un aviso falso no confirma nada.
- La página de vuelta (`/pago`) **no cree lo que viene en la dirección**: consulta el estado real del pedido.
- **Confirmación atómica** (una sola vez aunque el aviso llegue repetido) y detección de problemas de cobro: importe distinto, pago duplicado, pago en pedido cancelado, devolución, contracargo. El pedido **no se confirma** y el dueño ve el aviso en el panel.
- **Conciliación**: el dueño puede revisar a mano los pagos pendientes, y el servidor lo hace solo si el aviso nunca llegó.
- **Recordatorio único** por mail para un pedido de Mercado Pago que quedó sin pagar.
- Si el costo de envío es solo estimado, el cobro con Mercado Pago queda bloqueado hasta tener el valor exacto.
- Las **cuotas sin interés** dependen de la configuración de la cuenta de Mercado Pago del dueño.

---

## Facturación electrónica (ARCA)

Documentación detallada en `Docs/FACTURACION.md` (fuera de este repositorio). Resumen:

- Cada pago aprobado de Mercado Pago emite una **Factura C** a consumidor final, genera el **PDF** (con logo, CAE y **código QR** de ARCA) y lo envía por mail al cliente.
- Las **transferencias** las factura el dueño con un botón en el panel, después de verificar que el dinero ingresó.
- **Notas de Crédito C** desde el panel para anular una factura por el total.
- Cliente de ARCA **propio, sin librerías**: el login se firma (CMS/PKCS#7) con WebCrypto y el PDF se arma a mano.
- Garantías: **una factura por pedido** y una nota por factura (restricción en la base); un solo proceso a la vez; el número se anota **antes** de pedir el CAE y, si se corta la conexión, se consulta a ARCA antes de reintentar (no se duplica ni se saltea un número); si ARCA está caída se **reintenta sola**; si la rechaza, avisa al dueño. **El pedido y el cobro nunca se tocan.**
- Desde **$10.000.000** ARCA exige identificar al cliente: el sistema no emite y avisa.
- El acceso temporal a ARCA se guarda y reutiliza (ARCA no entrega otro mientras el anterior sigue vigente).
- Apagado de emergencia: `FACTURACION_ACTIVA = "0"` y publicar.

---

## Panel del dueño

Acceso solo con la cuenta del dueño (`ADMIN_EMAILS`).

- **Resumen** de pedidos por estado y de clientes (con consentimiento, destinatarios del mail semanal).
- **Pedidos**: lista con filtro por estado, cambio de estado con aviso al cliente, número de seguimiento, qué diseños lleva cada pack, avisos de cobro a revisar («Ya lo revisé»).
- **Revisar pagos de Mercado Pago** (conciliación manual).
- **Facturas**: lista de todo lo facturado, **facturado del mes y de los últimos 12 meses** (para vigilar el tope del monotributo), descarga de cada PDF; botones **Facturar** (transferencias y reintentos) y **Anular con nota de crédito**.
- **Analíticas** por período: ventas, ticket promedio, qué se vende, quién compra, descuentos, envíos, cancelados, visitas y conversión.
- **Mail de novedades**: estado, vista previa, envío de prueba, historial de envíos.
- **App local de pedidos e impresión** (taller): se vincula un equipo con un código y el servidor le entrega los pedidos para preparar la impresión.

---

## Mails

Enviados con Resend, con un solo estilo (colores y voz de la marca):

- Confirmación de mail y recuperación de contraseña.
- Pedido recibido, cambio de estado, pedido cancelado y recordatorio de pago.
- **Factura** y **nota de crédito** con el PDF adjunto.
- Avisos al dueño: pedido nuevo, cobro a revisar, factura que no se pudo emitir, sugerencia de diseño.
- **Novedades semanales** (los jueves a las 10 h de Argentina): solo si hay diseños nuevos y solo a quien aceptó recibirlas y confirmó su mail, en tandas para no pasar el límite de envío. Cada mail trae **baja con un solo clic** (`/baja`).
- Si falla un mail, **no se frena** la operación principal.

---

## Analítica y privacidad

- **Contador de visitas anónimo propio**: una visita por día y por página, sin IP, sin navegador y sin cookies.
- **Google Analytics 4 y Google Ads: apagados por defecto.** Se activan con variables y, aun así, solo corren con el **consentimiento** del visitante (aviso con opción de rechazar). Mide compras una sola vez por pedido.
- Atribución de campañas (UTM) guardada con cada pedido para saber de dónde llegó.
- **Política de privacidad** y **términos** completos, con responsable, datos que se guardan, finalidad, proveedores (Cloudflare, Google, Correo Argentino, Resend, Mercado Pago, ARCA), plazos y derechos (acceso, rectificación, supresión).
- Los registros de seguridad no guardan IP ni mail: solo una huella diaria que no permite reconocer a nadie.

---

## SEO, rendimiento y accesibilidad

- **HTML prerenderizado**: `worker/scripts/prerender.mjs` escribe en `index.html` las tarjetas de packs y las tablas de precios a partir de los datos, así los buscadores y quienes no ejecutan JavaScript ven el contenido real. Una prueba falla si el HTML y los datos se desincronizan (`npm run prerender`).
- Direcciones limpias (`/packs`, `/privacidad`…) con redirección desde las `.html`, `sitemap.xml`, `robots.txt`, metadatos Open Graph y Twitter, datos estructurados JSON-LD.
- Imágenes WebP, carga diferida, videos por tramos (`Range`) y caché larga solo para archivos con versión en el nombre.
- Accesibilidad: foco visible, etiquetas y roles, anuncios para lectores de pantalla, ventanas modales nativas, respeto de «reducir movimiento», diseño que se adapta a celular (probado desde 375 px).

---

## Seguridad

- **Cabeceras** en todas las respuestas: política de contenido (CSP) estricta, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`. La API responde con una CSP aún más cerrada.
- Verificación de **origen** y de **HTTPS** en las rutas dinámicas.
- **Precios y totales solo del lado del servidor**; los límites de cantidad y de texto se validan en el servidor.
- **Límites de uso** (intentos de ingreso, pedidos, conciliaciones, sugerencias) con huella de IP salada.
- Contraseñas con hash; sesiones y enlaces de un solo uso guardados como hash.
- Panel, facturas y descargas exigen sesión y, para el panel, cuenta de dueño con mail confirmado; un cliente **no puede ver los comprobantes de otro**.
- **Limpieza automática** de contadores, sesiones y enlaces vencidos. No toca pedidos, historial ni consentimientos.
- Los secretos (Mercado Pago, Resend, Correo, certificado de ARCA) **no están en el código**: se cargan como secretos de Cloudflare.

---

## Base de datos

D1 (SQLite). Migraciones en orden en `worker/migrations/`:

| Tabla | Qué guarda |
|---|---|
| `users`, `sessions`, `auth_tokens` | Cuentas, sesiones (solo hash) y enlaces de un solo uso. |
| `consent_events` | Historial de consentimientos de novedades (cuándo y cómo). |
| `orders`, `order_events` | Pedidos y su historial de estados. |
| `rate_limits` | Contadores de límite de uso. |
| `mail_log` | Mails simulados cuando el envío está en modo de prueba. |
| `page_views` | Contador de visitas anónimo. |
| `newsletters`, `newsletter_envios` | Mail semanal y su avance. |
| `taller_equipos` | Equipos vinculados a la app local de impresión. |
| `invoices`, `credit_notes` | Facturas y notas de crédito (una por pedido / por factura). |
| `arca_tickets` | Acceso temporal a ARCA, reutilizado mientras vive. |

---

## API

Todas bajo `/api/` (JSON). Las que modifican datos exigen origen válido.

| Grupo | Rutas |
|---|---|
| Público | `GET /config`, `GET /envio`, `GET /destacados`, `POST /visita`, `POST /sugerencias` |
| Cuenta | `POST /auth/registro · ingreso · salida · olvide · restablecer · verificar · reenviar · password · google`, `GET /auth/yo`, `GET /cuenta/datos`, `PATCH/DELETE /cuenta` |
| Pedidos | `GET/POST /pedidos`, `GET /pedidos/:id`, `POST /pedidos/:id/cancelar`, `POST /pedidos/:id/pago`, `GET /pedidos/:id/factura`, `GET /pedidos/numero/:numero` |
| Mercado Pago | `POST /pagos/mercadopago` (aviso firmado) |
| Panel | `GET /admin/pedidos · resumen · analiticas · novedades · facturas`, `PATCH /admin/pedidos/:id`, `POST /admin/conciliar`, `POST /admin/pedidos/:id/facturar · nota-credito`, `GET /admin/pedidos/:id/comprobante` |
| Taller | `GET /taller/pedidos` (equipo vinculado) |
| Fuera de `/api` | `GET/POST /baja` (baja de novedades) |

---

## Configuración y secretos

**Variables** (en `worker/cloudflare.config.ts`, no son secretas): `MICORREO_AMBIENTE`, `CP_ORIGEN`, `RECARGO_PORCENTAJE`, `MP_DIAGNOSTICO`, `ADMIN_EMAILS`, `GOOGLE_CLIENT_ID`, `MAIL_PROVIDER`, `MAIL_FROM`, `MAIL_FROM_NEWS`, `MAIL_REPLY_TO`, `NOVEDADES_ACTIVO`, `SITE_URL`, `FACTURACION_ACTIVA`, `ARCA_AMBIENTE`, `ARCA_CUIT`, `ARCA_PTO_VTA`. Opcionales: `GA4_ID`, `ADS_ID`, `ADS_ETIQUETA_COMPRA`, `FACTURA_TOPE_IDENTIFICAR`.

**Secretos** (se cargan con `cf workers secrets update NOMBRE --worker donsticker --text=...`, **nunca** en el repositorio): `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `RESEND_API_KEY`, `MICORREO_USER`, `MICORREO_PASSWORD`, `MICORREO_CUSTOMER_ID`, `ARCA_CERT`, `ARCA_KEY`, y opcionalmente `IP_SALT`.

Para trabajar en local, `worker/.dev.vars` (ignorado por git) con `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` y `ENTORNO`.

> `worker/wrangler.jsonc` y `worker/wrangler.config.ts` **están desactualizados a propósito** y solo sirven para comandos de lectura. Publicar con `wrangler deploy` dejaría el sitio **sin base de datos**.

---

## Desarrollo, pruebas y despliegue

```bash
cd worker
npm install
npm test                      # 273 pruebas, sin red ni credenciales reales
npm run prerender             # regenera el HTML de la portada desde web/js/data.js
npm run prerender:check       # falla si el HTML y los datos no coinciden
```

**Prueba contra ARCA** (ambiente de homologación, sin validez fiscal; necesita tu propio certificado de pruebas en `~/.donsticker/arca/`):

```bash
node scripts/prueba-arca.mjs prueba 11              # factura de prueba
node scripts/prueba-arca.mjs prueba 11 transferencia
node scripts/prueba-arca.mjs prueba 11 nota         # factura + nota de crédito
```

**Publicar** (siempre desde `worker/`, con la CLI de Cloudflare):

```bash
npm test && npm run prerender:check
npx cf d1 migrations list <id-de-la-base> --dir migrations     # ¿hay migraciones pendientes?
npx cf d1 migrations apply <id-de-la-base> --dir migrations    # aplicarlas ANTES de publicar
npx cf deploy                                                  # sube TODO lo de web/ y el Worker
```

`cf deploy` sube **toda** la carpeta `web/`, no solo lo último que se cambió. No usar `npm run deploy` ni `wrangler deploy`.

---

## Tareas programadas

El Worker tiene un manejador `scheduled` pensado para correr **cada 15 minutos** (Cron Trigger): limpia datos vencidos, concilia pagos pendientes, manda el mail de novedades por tandas, envía recordatorios de pago y **reintenta las facturas pendientes**. El cron se declara en la configuración de Cloudflare; hay que comprobar que siga activo después de cada `cf deploy`.

---

## Qué no está en el repositorio

Quedan afuera a propósito (ver `.gitignore`):

- **Catálogo** con los originales de impresión (sin marca de agua) y sus herramientas de importación.
- **Material de redes** (videos, láminas, calendario de contenido) y documentación interna.
- **Don Sticker Studio** y las apps locales de pedidos e impresión.
- **Certificados y claves** de ARCA, tokens y cualquier secreto.
- Dependencias (`node_modules/`) y estado local de Cloudflare (`.cloudflare/`, `.wrangler/`).

> `web/js/catalogo.js`, `worker/src/packs-contenido.js`, `worker/src/logo-factura.js` y la lista `PRODUCTOS` de `worker/src/precios.js` son archivos **generados** (desde el catálogo y desde el logo): no se editan a mano.

---

## Créditos y licencia

Don Sticker · Nicolas Barra, Balcarce, Buenos Aires. Web desarrollada con [duckia.com.ar](https://www.duckia.com.ar/).
Sin licencia de código abierto declarada: **todos los derechos reservados**. Los diseños, la marca y el personaje «Don Sticker» son de su titular.
