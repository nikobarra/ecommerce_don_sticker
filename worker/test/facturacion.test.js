// Pruebas de la facturación electrónica (ARCA), con respuestas SIMULADAS: no usan certificados reales ni emiten nada.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crearEntorno, mailsEnviados } from "./helpers.js";
import { emitirFactura, reintentarFacturas, pdfDeFactura } from "../src/facturacion.js";
import { urlQr, lineasFactura, generarFacturaPdf } from "../src/factura-pdf.js";
import { firmarCms } from "../src/arca.js";

const CERT = readFileSync(new URL("./fixtures/arca-prueba.crt", import.meta.url), "utf8");
const KEY = readFileSync(new URL("./fixtures/arca-prueba.key", import.meta.url), "utf8");
const SITIO = "https://donsticker.test";

const entornoFactura = (extra = {}) => crearEntorno({
  FACTURACION_ACTIVA: "1", ARCA_AMBIENTE: "prueba", ARCA_CUIT: "20274973022", ARCA_PTO_VTA: "11", ARCA_CERT: CERT, ARCA_KEY: KEY, ...extra,
});

function pedidoPagado(env, { id = "ped-1", numero = "DS-AAA111", total = 11340, estado = "pago_confirmado", medio = "mercadopago", items, subtotal, envio = 0 } = {}) {
  const t = new Date().toISOString();
  env.DB.db.prepare("INSERT OR IGNORE INTO users (id, email, name, unsubscribe_token, created_at) VALUES ('u1', 'cliente@ejemplo.com', 'Cliente', 'tok-baja', ?)").run(t);
  const lista = items || [{ id: "pack-10-01", nombre: "Pack 1 de 10", tipo: "pack", cantidad: 1, precio: total - envio }];
  env.DB.db.prepare("INSERT INTO orders (id, number, user_id, status, items_json, subtotal, shipping, total, delivery, customer_name, payment_method, discount, created_at, updated_at) VALUES (?, ?, 'u1', ?, ?, ?, ?, ?, 'Balcarce', 'Cliente Prueba', ?, 0, ?, ?)")
    .run(id, numero, estado, JSON.stringify(lista), subtotal ?? total - envio, envio, total, medio, t, t);
  return id;
}

// Simula a ARCA. `modo` permite hacer fallar cada paso.
function simularArca({ ultimo = 41, cae = "74123456789012", rechazo = null, wsfeCaido = false, existente = null, perderRespuesta = false } = {}) {
  const llamadas = { login: 0, ultimo: 0, solicitar: 0, consultar: 0, cuerpos: [] };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url), cuerpo = String(opts.body || "");
    if (u.includes("LoginCms")) {
      llamadas.login++;
      const ta = `<loginTicketResponse><header><expirationTime>${new Date(Date.now() + 11 * 3600000).toISOString()}</expirationTime></header><credentials><token>TOKEN-X</token><sign>FIRMA-X</sign></credentials></loginTicketResponse>`;
      return new Response(`<soapenv:Envelope><soapenv:Body><loginCmsResponse><loginCmsReturn>${ta.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</loginCmsReturn></loginCmsResponse></soapenv:Body></soapenv:Envelope>`);
    }
    if (u.includes("wsfev1")) {
      if (wsfeCaido) return new Response("caído", { status: 503 });
      if (cuerpo.includes("<FECompUltimoAutorizado")) { llamadas.ultimo++; return new Response(`<Envelope><Body><FECompUltimoAutorizadoResponse><FECompUltimoAutorizadoResult><PtoVta>11</PtoVta><CbteTipo>11</CbteTipo><CbteNro>${typeof ultimo === "object" ? (ultimo[/<CbteTipo>(\d+)</.exec(cuerpo)[1]] ?? 0) : ultimo}</CbteNro></FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse></Body></Envelope>`); }
      if (cuerpo.includes("<FECompConsultar")) {
        llamadas.consultar++;
        const r = existente ? `<ResultGet><CodAutorizacion>${existente.cae}</CodAutorizacion><FchVto>20261203</FchVto><ImpTotal>${existente.total}</ImpTotal><CbteFch>20261123</CbteFch></ResultGet>` : `<Errors><Err><Code>602</Code><Msg>no existe</Msg></Err></Errors>`;
        return new Response(`<Envelope><Body><FECompConsultarResponse><FECompConsultarResult>${r}</FECompConsultarResult></FECompConsultarResponse></Body></Envelope>`);
      }
      if (cuerpo.includes("<FECAESolicitar")) {
        llamadas.solicitar++; llamadas.cuerpos.push(cuerpo);
        if (perderRespuesta) throw new Error("se cortó la conexión");
        if (rechazo) return new Response(`<Envelope><Body><FECAESolicitarResponse><FECAESolicitarResult><FeDetResp><FECAEDetResponse><Resultado>R</Resultado><Observaciones><Obs><Code>${rechazo.code}</Code><Msg>${rechazo.msg}</Msg></Obs></Observaciones></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse></Body></Envelope>`);
        return new Response(`<Envelope><Body><FECAESolicitarResponse><FECAESolicitarResult><FeDetResp><FECAEDetResponse><Resultado>A</Resultado><CAE>${cae}</CAE><CAEFchVto>20261203</CAEFchVto></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse></Body></Envelope>`);
      }
    }
    throw new Error(`llamada inesperada: ${u}`);
  };
  return llamadas;
}

const factura = (env, id = "ped-1") => env.DB.db.prepare("SELECT * FROM invoices WHERE order_id = ?").get(id);

test("sin FACTURACION_ACTIVA no se factura nada", async () => {
  const env = entornoFactura({ FACTURACION_ACTIVA: "0" });
  pedidoPagado(env);
  const arca = simularArca();
  assert.equal(await emitirFactura(env, null, SITIO, "ped-1"), "inactiva");
  assert.equal(arca.login, 0);
  assert.equal(factura(env), undefined);
});

test("emite la Factura C: número siguiente, CAE guardado y mail con el PDF adjunto", async () => {
  const env = entornoFactura();
  pedidoPagado(env);
  const arca = simularArca({ ultimo: 41 });
  assert.equal(await emitirFactura(env, null, SITIO, "ped-1"), "emitida");
  const f = factura(env);
  assert.equal(f.status, "emitida"); assert.equal(f.cbte_nro, 42); assert.equal(f.cae, "74123456789012"); assert.equal(f.pto_vta, 11); assert.equal(f.cbte_tipo, 11);
  assert.ok(f.mail_enviado_en);
  const c = arca.cuerpos[0];
  assert.match(c, /<CbteTipo>11<\/CbteTipo>/); assert.match(c, /<CbteDesde>42<\/CbteDesde>/); assert.match(c, /<ImpTotal>11340.00<\/ImpTotal>/);
  assert.match(c, /<ImpIVA>0.00<\/ImpIVA>/); assert.match(c, /<DocTipo>99<\/DocTipo>/); assert.match(c, /<CondicionIVAReceptorId>5<\/CondicionIVAReceptorId>/);
  const mails = mailsEnviados(env);
  assert.equal(mails.length, 1); assert.equal(mails[0].to_addr, "cliente@ejemplo.com"); assert.match(mails[0].body, /Factura-C-00011-00000042\.pdf/);
});

test("es idempotente: una segunda vez no vuelve a emitir ni a mandar el mail", async () => {
  const env = entornoFactura();
  pedidoPagado(env);
  const arca = simularArca();
  await emitirFactura(env, null, SITIO, "ped-1");
  assert.equal(await emitirFactura(env, null, SITIO, "ped-1"), "ya_emitida");
  assert.equal(arca.solicitar, 1);
  assert.equal(mailsEnviados(env).length, 1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM invoices").get().n, 1);
});

test("no factura pagos por transferencia ni pedidos sin pagar o cancelados", async () => {
  const env = entornoFactura();
  simularArca();
  pedidoPagado(env, { id: "a", numero: "DS-A", medio: "transferencia" });
  pedidoPagado(env, { id: "b", numero: "DS-B", estado: "recibido" });
  pedidoPagado(env, { id: "c", numero: "DS-C", estado: "cancelado" });
  for (const id of ["a", "b", "c"]) assert.equal(await emitirFactura(env, null, SITIO, id), "no_facturable");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM invoices").get().n, 0);
});

test("si ARCA está caída la factura queda pendiente y se completa sola después", async () => {
  const env = entornoFactura();
  pedidoPagado(env);
  simularArca({ wsfeCaido: true });
  assert.equal(await emitirFactura(env, null, SITIO, "ped-1"), "reintentar");
  assert.equal(factura(env).status, "pendiente");
  assert.match(factura(env).ultimo_error, /ARCA/);
  assert.equal(mailsEnviados(env).length, 0);
  simularArca({ ultimo: 7 });
  assert.equal(await reintentarFacturas(env, null, SITIO), 1);
  const f = factura(env);
  assert.equal(f.status, "emitida"); assert.equal(f.cbte_nro, 8);
  assert.equal(mailsEnviados(env).length, 1);
});

test("por un monto que obliga a identificar al cliente no emite: avisa al dueño y no llama a ARCA", async () => {
  const env = entornoFactura();
  pedidoPagado(env, { total: 10000000 });
  const arca = simularArca();
  assert.equal(await emitirFactura(env, null, SITIO, "ped-1"), "requiere_identificacion");
  assert.equal(arca.solicitar, 0); assert.equal(arca.login, 0);
  assert.equal(factura(env).status, "error");
  const mails = mailsEnviados(env);
  assert.equal(mails.length, 1); assert.equal(mails[0].to_addr, "dueno@ejemplo.com"); assert.match(mails[0].body, /identificar al cliente/);
  const justo = entornoFactura();
  pedidoPagado(justo, { total: 9999999 });
  const arca2 = simularArca();
  assert.equal(await emitirFactura(justo, null, SITIO, "ped-1"), "emitida");
  assert.equal(arca2.solicitar, 1);
});

test("si ARCA la rechaza queda en error, avisa al dueño y no se reintenta", async () => {
  const env = entornoFactura();
  pedidoPagado(env);
  simularArca({ rechazo: { code: 10015, msg: "Debe identificar al receptor" } });
  assert.equal(await emitirFactura(env, null, SITIO, "ped-1"), "error");
  const f = factura(env);
  assert.equal(f.status, "error"); assert.match(f.ultimo_error, /10015/);
  const mails = mailsEnviados(env);
  assert.equal(mails.length, 1); assert.equal(mails[0].to_addr, "dueno@ejemplo.com"); assert.match(mails[0].subject, /Factura sin emitir/);
  assert.equal(await emitirFactura(env, null, SITIO, "ped-1"), "error_previo");
  assert.equal(await reintentarFacturas(env, null, SITIO), 0);
});

test("si se corta la conexión después de pedir el CAE, al reintentar adopta la factura que ARCA ya autorizó", async () => {
  const env = entornoFactura();
  pedidoPagado(env);
  simularArca({ ultimo: 41, perderRespuesta: true });
  assert.equal(await emitirFactura(env, null, SITIO, "ped-1"), "reintentar");
  assert.equal(factura(env).cbte_nro, 42);                       // el número quedó anotado antes de pedir el CAE
  const arca = simularArca({ existente: { cae: "74999999999999", total: 11340 } });
  await reintentarFacturas(env, null, SITIO);
  const f = factura(env);
  assert.equal(f.status, "emitida"); assert.equal(f.cae, "74999999999999"); assert.equal(f.cbte_nro, 42);
  assert.equal(arca.solicitar, 0, "no debe pedir otra factura");
});

test("un solo proceso a la vez: si otro está emitiendo, este no hace nada", async () => {
  const env = entornoFactura();
  pedidoPagado(env);
  const arca = simularArca();
  const t = new Date().toISOString();
  env.DB.db.prepare("INSERT INTO invoices (order_id, status, ambiente, pto_vta, cbte_tipo, total, bloqueo_hasta, created_at, updated_at) VALUES ('ped-1', 'pendiente', 'prueba', 11, 11, 11340, ?, ?, ?)").run(new Date(Date.now() + 60000).toISOString(), t, t);
  assert.equal(await emitirFactura(env, null, SITIO, "ped-1"), "ocupada");
  assert.equal(arca.solicitar, 0);
});

test("reutiliza el acceso de ARCA mientras sigue vigente (ARCA no entrega otro hasta que vence)", async () => {
  const env = entornoFactura();
  pedidoPagado(env, { id: "a", numero: "DS-A" }); pedidoPagado(env, { id: "b", numero: "DS-B" });
  const arca = simularArca();
  await emitirFactura(env, null, SITIO, "a"); await emitirFactura(env, null, SITIO, "b");
  assert.equal(arca.login, 1);
});

test("el aviso del número ocupado (10016) vuelve a pedir con el número siguiente", async () => {
  const env = entornoFactura();
  pedidoPagado(env);
  let n = 0;
  const base = simularArca({ ultimo: 41 });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(opts.body || "").includes("<FECAESolicitar") && n++ === 0)
      return new Response(`<Envelope><Body><FECAESolicitarResponse><FECAESolicitarResult><Errors><Err><Code>10016</Code><Msg>El numero no es el siguiente</Msg></Err></Errors><FeDetResp><FECAEDetResponse><Resultado>R</Resultado></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse></Body></Envelope>`);
    return original(url, opts);
  };
  assert.equal(await emitirFactura(env, null, SITIO, "ped-1"), "emitida");
  assert.equal(base.ultimo, 2);
});

// ---------- PDF y QR ----------

test("el QR lleva los datos que pide ARCA, en JSON y Base64", () => {
  const url = urlQr({ fecha: "20261123", cuit: "20274973022", ptoVta: 11, tipo: 11, nro: 42, total: 11340, cae: "74123456789012" });
  assert.ok(url.startsWith("https://www.afip.gob.ar/fe/qr/?p="));
  const d = JSON.parse(atob(url.split("?p=")[1]));
  assert.deepEqual(d, { ver: 1, fecha: "2026-11-23", cuit: 20274973022, ptoVta: 11, tipoCmp: 11, nroCmp: 42, importe: 11340, moneda: "PES", ctz: 1, tipoDocRec: 99, nroDocRec: 0, tipoCodAut: "E", codAut: 74123456789012 });
});

test("las líneas de la factura siempre suman el total cobrado", () => {
  const base = { number: "DS-X", discount: 0 };
  const a = lineasFactura({ ...base, items: [{ tipo: "pack", nombre: "Pack 1 de 25", cantidad: 1, precio: 14880 }, { tipo: "suelto", nombre: "Mafalda", cantidad: 3 }], subtotal: 14880 + 3 * 700, shipping: 14000, total: 14880 + 2100 + 14000 });
  assert.equal(a.reduce((n, l) => n + l.sub, 0), 14880 + 2100 + 14000);
  assert.ok(a.some((l) => l.desc === "Gastos de envío" && l.sub === 14000));
  const rara = lineasFactura({ ...base, items: [{ tipo: "suelto", nombre: "X", cantidad: 3 }], subtotal: 2000, shipping: 0, total: 9999 });   // no cierra: una sola línea por el total
  assert.equal(rara.length, 1); assert.equal(rara[0].sub, 9999);
});

test("el PDF es válido y trae el CAE, el número y los importes", () => {
  const env = entornoFactura();
  const pedido = { number: "DS-AAA111", customer_name: "Cliente Prueba", items: [{ tipo: "pack", nombre: "Pack 1 de 10", cantidad: 1, precio: 5670 }], subtotal: 5670, shipping: 0, discount: 0, total: 5670 };
  const pdf = generarFacturaPdf({ emisor: { nombreFantasia: "Don Sticker", razonSocial: "Nicolas Barra", domicilio: "Calle 21 N° 700, Balcarce", condicionIva: "Responsable Monotributo", ingresosBrutos: "Régimen Simplificado", inicioActividades: "01/12/2017", cuit: "20274973022" }, pedido, factura: { tipo: 11, ptoVta: 11, nro: 42, fecha: "20261123", total: 5670, cae: "74123456789012", caeVto: "20261203" } });
  const texto = new TextDecoder("latin1").decode(pdf);
  assert.ok(texto.startsWith("%PDF-1.4")); assert.ok(texto.trimEnd().endsWith("%%EOF"));
  assert.match(texto, /\/Subtype \/Image/); assert.match(texto, /\/Im1 Do/);   // el logo va incrustado, con su transparencia (SMask)
  assert.match(texto, /\/SMask 8 0 R/); assert.match(texto, /74123456789012/); assert.match(texto, /00000042/); assert.match(texto, /5\.670,00/);
  const xref = Number(/startxref\n(\d+)/.exec(texto)[1]);
  assert.equal(texto.slice(xref, xref + 4), "xref");                 // la tabla de posiciones apunta bien
  assert.ok(env);
});

test("pdfDeFactura devuelve null si el pedido no tiene factura emitida", async () => {
  const env = entornoFactura();
  pedidoPagado(env);
  assert.equal(await pdfDeFactura(env, "ped-1"), null);
});

// ---------- Firma del login ----------

test("el login se firma como CMS/PKCS#7 con el certificado y la clave", async () => {
  const cms = await firmarCms("<loginTicketRequest/>", CERT, KEY);
  assert.equal(cms[0], 0x30);                                         // SEQUENCE
  const hex = Buffer.from(cms).toString("hex");
  assert.ok(hex.includes("2a864886f70d010702"), "debe ser SignedData");
  assert.ok(Buffer.from(cms).includes(Buffer.from("<loginTicketRequest/>")), "lleva el contenido");
});

// ---------- Factura en «Mi cuenta» ----------

import { cliente, registrar } from "./helpers.js";

async function clienteConFactura(env) {
  const c = cliente(env);
  await registrar(c, "cliente@ejemplo.com");
  const u = env.DB.db.prepare("SELECT id FROM users WHERE email = 'cliente@ejemplo.com'").get();
  const t = new Date().toISOString();
  const id = "11111111-1111-4111-8111-111111111111";
  env.DB.db.prepare("INSERT INTO orders (id, number, user_id, status, items_json, subtotal, shipping, total, delivery, customer_name, payment_method, discount, created_at, updated_at) VALUES (?, 'DS-CUENTA1', ?, 'pago_confirmado', ?, 5670, 0, 5670, 'Balcarce', 'Cliente Prueba', 'mercadopago', 0, ?, ?)")
    .run(id, u.id, JSON.stringify([{ id: "pack-10-01", nombre: "Pack 1 de 10", tipo: "pack", cantidad: 1, precio: 5670 }]), t, t);
  return { c, id, u };
}

test("Mi cuenta: el pedido facturado trae su número de factura y el cliente descarga el PDF", async () => {
  const env = entornoFactura();
  const { c, id } = await clienteConFactura(env);
  simularArca({ ultimo: 6 });
  assert.equal(await emitirFactura(env, null, SITIO, id), "emitida");
  const lista = await c.get("/api/pedidos");
  assert.equal(lista.datos.pedidos[0].factura, "00011-00000007");
  const pdf = await c.get(`/api/pedidos/${id}/factura`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.res.headers.get("content-type"), "application/pdf");
  assert.match(pdf.res.headers.get("content-disposition"), /Factura-C-00011-00000007\.pdf/);
  assert.match(pdf.res.headers.get("cache-control"), /no-store/);
  assert.ok(pdf.texto.startsWith("%PDF-1.4"));
});

test("Mi cuenta: un pedido sin factura no ofrece descarga y la ruta responde 404", async () => {
  const env = entornoFactura();
  const { c, id } = await clienteConFactura(env);
  assert.equal((await c.get("/api/pedidos")).datos.pedidos[0].factura, null);
  const r = await c.get(`/api/pedidos/${id}/factura`);
  assert.equal(r.status, 404); assert.equal(r.datos.error, "sin_factura");
});

test("Mi cuenta: nadie descarga la factura de un pedido ajeno ni sin sesión", async () => {
  const env = entornoFactura();
  const { id } = await clienteConFactura(env);
  simularArca();
  await emitirFactura(env, null, SITIO, id);
  const otro = cliente(env); await registrar(otro, "otro@ejemplo.com");
  assert.equal((await otro.get(`/api/pedidos/${id}/factura`)).status, 404);
  assert.equal((await otro.get("/api/pedidos")).datos.pedidos.length, 0);
  assert.equal((await cliente(env).get(`/api/pedidos/${id}/factura`)).status, 401);
});

test("Mi cuenta: una factura pendiente o con error no se muestra ni se descarga", async () => {
  const env = entornoFactura();
  const { c, id } = await clienteConFactura(env);
  simularArca({ wsfeCaido: true });
  await emitirFactura(env, null, SITIO, id);                       // queda pendiente
  assert.equal((await c.get("/api/pedidos")).datos.pedidos[0].factura, null);
  assert.equal((await c.get(`/api/pedidos/${id}/factura`)).status, 404);
});

// ---------- Panel del dueño: facturar a mano, notas de crédito y lista ----------

import { entrarComoDueno } from "./helpers.js";
import { emitirNotaCredito } from "../src/facturacion.js";

const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", U2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const bytesDe = async (r) => new TextDecoder("latin1").decode(new Uint8Array(await r.res.arrayBuffer()));

test("el dueño factura una transferencia a mano: sale la factura, el mail y queda marcada como manual", async () => {
  const env = entornoFactura();
  pedidoPagado(env, { id: U1, numero: "DS-TRANS1", medio: "transferencia", estado: "recibido", total: 5100 });
  const arca = simularArca({ ultimo: 9 });
  assert.equal(await emitirFactura(env, null, SITIO, U1), "no_facturable");   // sola, jamás
  const dueno = await entrarComoDueno(env);
  const r = await dueno.post(`/api/admin/pedidos/${U1}/facturar`, {});
  assert.equal(r.status, 200); assert.equal(r.datos.ok, true); assert.equal(r.datos.resultado, "emitida");
  const f = factura(env, U1);
  assert.equal(f.origen, "manual"); assert.equal(f.cbte_nro, 10); assert.equal(f.total, 5100);
  assert.match(arca.cuerpos[0], /<ImpTotal>5100.00<\/ImpTotal>/);
  const m = mailsEnviados(env).find((x) => x.to_addr === "cliente@ejemplo.com");
  assert.match(m.body, /Factura-C-00011-00000010\.pdf/);
  assert.match(await bytesDe(await dueno.get(`/api/admin/pedidos/${U1}/comprobante`)), /Transferencia bancaria/);
});

test("facturar a mano: no sirve para pedidos cancelados ni para pagos de Mercado Pago sin acreditar", async () => {
  const env = entornoFactura();
  simularArca();
  pedidoPagado(env, { id: U1, numero: "DS-A", medio: "transferencia", estado: "cancelado" });
  pedidoPagado(env, { id: U2, numero: "DS-B", medio: "mercadopago", estado: "recibido" });
  const dueno = await entrarComoDueno(env);
  for (const id of [U1, U2]) { const r = await dueno.post(`/api/admin/pedidos/${id}/facturar`, {}); assert.equal(r.datos.resultado, "no_facturable"); assert.equal(r.datos.ok, false); }
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM invoices").get().n, 0);
});

test("facturar y anular solo lo puede hacer el dueño", async () => {
  const env = entornoFactura();
  pedidoPagado(env, { id: U1, numero: "DS-A", medio: "transferencia", estado: "recibido" });
  simularArca();
  const cli = cliente(env); await registrar(cli, "otro@ejemplo.com");
  assert.equal((await cliente(env).post(`/api/admin/pedidos/${U1}/facturar`, {})).status, 401);
  assert.equal((await cli.post(`/api/admin/pedidos/${U1}/facturar`, {})).status, 403);
  assert.equal((await cli.post(`/api/admin/pedidos/${U1}/nota-credito`, {})).status, 403);
  assert.equal((await cli.get("/api/admin/facturas")).status, 403);
  assert.equal((await cli.get(`/api/admin/pedidos/${U1}/comprobante`)).status, 403);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM invoices").get().n, 0);
});

test("una factura manual rechazada por ARCA se puede reintentar con el mismo botón", async () => {
  const env = entornoFactura();
  pedidoPagado(env, { id: U1, numero: "DS-A", medio: "transferencia", estado: "recibido" });
  const dueno = await entrarComoDueno(env);
  simularArca({ rechazo: { code: 10015, msg: "Receptor no válido" } });
  const r1 = await dueno.post(`/api/admin/pedidos/${U1}/facturar`, {});
  assert.equal(r1.datos.resultado, "error"); assert.match(r1.datos.mensaje, /10015/);
  simularArca({ ultimo: 3 });
  const r2 = await dueno.post(`/api/admin/pedidos/${U1}/facturar`, {});
  assert.equal(r2.datos.resultado, "emitida"); assert.equal(factura(env, U1).cbte_nro, 4);
});

test("una transferencia facturada a mano que quedó pendiente la completa la tarea periódica", async () => {
  const env = entornoFactura();
  pedidoPagado(env, { id: U1, numero: "DS-A", medio: "transferencia", estado: "recibido" });
  const dueno = await entrarComoDueno(env);
  simularArca({ wsfeCaido: true });
  assert.equal((await dueno.post(`/api/admin/pedidos/${U1}/facturar`, {})).datos.resultado, "reintentar");
  simularArca({ ultimo: 20 });
  assert.equal(await reintentarFacturas(env, null, SITIO), 1);
  assert.equal(factura(env, U1).status, "emitida");
});

test("nota de crédito: anula la factura asociándola, avisa al cliente y no se puede repetir", async () => {
  const env = entornoFactura();
  pedidoPagado(env, { id: U1, numero: "DS-NC1", total: 5670 });
  const arca = simularArca({ ultimo: { 11: 41, 13: 0 } });
  await emitirFactura(env, null, SITIO, U1);
  const dueno = await entrarComoDueno(env);
  arca.cuerpos.length = 0;
  const r = await dueno.post(`/api/admin/pedidos/${U1}/nota-credito`, { motivo: "Devolución del cliente" });
  assert.equal(r.datos.resultado, "emitida");
  const c = arca.cuerpos[0];
  assert.match(c, /<CbteTipo>13<\/CbteTipo>/); assert.match(c, /<CbteDesde>1<\/CbteDesde>/); assert.match(c, /<ImpTotal>5670.00<\/ImpTotal>/);
  assert.match(c, /<CbtesAsoc><CbteAsoc><Tipo>11<\/Tipo><PtoVta>11<\/PtoVta><Nro>42<\/Nro><Cuit>20274973022<\/Cuit>/);
  const nota = env.DB.db.prepare("SELECT * FROM credit_notes").get();
  assert.equal(nota.status, "emitida"); assert.equal(nota.cbte_tipo, 13); assert.equal(nota.motivo, "Devolución del cliente");
  assert.ok(mailsEnviados(env).some((m) => m.subject.includes("Nota de crédito") && m.body.includes("Nota-de-credito-C-00011-00000001.pdf")));
  const texto = await bytesDe(await dueno.get(`/api/admin/pedidos/${U1}/comprobante?tipo=nota`));
  assert.match(texto, /NOTA DE CR\xc9DITO/); assert.match(texto, /00011-00000042/); assert.match(texto, /Devoluci\xf3n del cliente/);
  const otra = await dueno.post(`/api/admin/pedidos/${U1}/nota-credito`, {});
  assert.equal(otra.datos.resultado, "ya_emitida");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM credit_notes").get().n, 1);
  assert.equal(arca.solicitar, 2);                                   // la factura y la nota; nada más
});

test("nota de crédito: sin factura emitida no se puede anular nada", async () => {
  const env = entornoFactura();
  pedidoPagado(env, { id: U1, numero: "DS-NC2" });
  simularArca();
  assert.equal(await emitirNotaCredito(env, null, SITIO, U1, ""), "sin_factura");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM credit_notes").get().n, 0);
});

test("la lista del panel trae el estado de cada pedido y los totales facturados, descontando las notas de crédito", async () => {
  const env = entornoFactura();
  pedidoPagado(env, { id: U1, numero: "DS-L1", total: 5670 });
  pedidoPagado(env, { id: U2, numero: "DS-L2", total: 12000, medio: "transferencia", estado: "recibido" });
  simularArca({ ultimo: 0 });
  await emitirFactura(env, null, SITIO, U1);
  const dueno = await entrarComoDueno(env);
  await dueno.post(`/api/admin/pedidos/${U2}/facturar`, {});
  let l = (await dueno.get("/api/admin/facturas")).datos;
  assert.equal(l.facturas.length, 2); assert.equal(l.facturadoMes, 5670 + 12000); assert.equal(l.facturado12Meses, 5670 + 12000);
  assert.equal(l.facturas.find((f) => f.pedido === "DS-L2").origen, "manual");
  await dueno.post(`/api/admin/pedidos/${U1}/nota-credito`, {});
  l = (await dueno.get("/api/admin/facturas")).datos;
  assert.equal(l.facturadoMes, 12000);
  assert.equal(l.facturas.find((f) => f.pedido === "DS-L1").nota.estado, "emitida");
  const lista = (await dueno.get("/api/admin/pedidos")).datos;
  assert.equal(lista.facturacionActiva, true);
  assert.equal(lista.pedidos.find((p) => p.numero === "DS-L1").facturacion.nota.estado, "emitida");
  assert.equal(lista.pedidos.find((p) => p.numero === "DS-L2").facturacion.factura.origen, "manual");
});

test("con la facturación apagada los botones del panel responden que está apagada", async () => {
  const env = entornoFactura({ FACTURACION_ACTIVA: "0" });
  pedidoPagado(env, { id: U1, numero: "DS-A", medio: "transferencia", estado: "recibido" });
  const dueno = await entrarComoDueno(env);
  assert.equal((await dueno.post(`/api/admin/pedidos/${U1}/facturar`, {})).status, 409);
  assert.equal((await dueno.post(`/api/admin/pedidos/${U1}/nota-credito`, {})).status, 409);
});
