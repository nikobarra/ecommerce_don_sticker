// Cliente de ARCA (ex AFIP) para facturar: login (WSAA) y facturación electrónica (WSFE, Factura C).
// Sin librerías: el login se firma con las funciones de cifrado que ya trae Cloudflare (WebCrypto) y el mensaje se
// arma a mano, porque ARCA pide un paquete firmado (CMS/PKCS#7). Pensado para un monotributista (Factura C).
//
// Secretos (no se escriben en el código): ARCA_CERT (certificado .crt) y ARCA_KEY (clave privada .key), en formato PEM.
// Variables: ARCA_AMBIENTE ("prueba" o "produccion"), ARCA_CUIT, ARCA_PTO_VTA.

import { fetchExterno, ahora } from "./util.js";

const PLAZO_ARCA_MS = 25000;
const URLS = {
  prueba: { wsaa: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms", wsfe: "https://wswhomo.afip.gov.ar/wsfev1/service.asmx" },
  produccion: { wsaa: "https://wsaa.afip.gov.ar/ws/services/LoginCms", wsfe: "https://servicios1.afip.gov.ar/wsfev1/service.asmx" },
};
const NS_WSFE = "http://ar.gov.afip.dif.FEV1/";

export const ambienteDe = (env) => (env.ARCA_AMBIENTE === "produccion" ? "produccion" : "prueba");
export const facturacionActiva = (env) => env.FACTURACION_ACTIVA === "1" && !!env.ARCA_CERT && !!env.ARCA_KEY && !!env.ARCA_CUIT && !!env.ARCA_PTO_VTA;

// ---------- DER / CMS (lo mínimo para firmar el pedido de login) ----------

const enc = new TextEncoder();
const unir = (...partes) => {
  const total = partes.reduce((n, p) => n + p.length, 0);
  const salida = new Uint8Array(total);
  let i = 0;
  for (const p of partes) { salida.set(p, i); i += p.length; }
  return salida;
};
const largo = (n) => {
  if (n < 128) return Uint8Array.of(n);
  const b = [];
  for (let x = n; x > 0; x >>= 8) b.unshift(x & 255);
  return Uint8Array.of(0x80 | b.length, ...b);
};
const tlv = (tag, ...contenido) => { const c = unir(...contenido); return unir(Uint8Array.of(tag), largo(c.length), c); };
const SEQ = (...c) => tlv(0x30, ...c);
const SET = (...c) => tlv(0x31, ...c);
const OID = (...bytes) => tlv(0x06, Uint8Array.of(...bytes));
const NULO = Uint8Array.of(0x05, 0x00);
const ENTERO = (n) => tlv(0x02, Uint8Array.of(n));
const OCTETOS = (b) => tlv(0x04, b);

const OID_DATA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01];
const OID_SIGNED_DATA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];
const OID_SHA256 = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
const OID_RSA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_ATTR = (n) => [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, n]; // 3 contentType, 4 messageDigest, 5 signingTime

// Lee un elemento DER en la posición `i`: devuelve dónde empieza el contenido y dónde termina.
function leer(b, i) {
  let p = i + 1;
  let n = b[p++];
  if (n & 0x80) { const k = n & 0x7f; n = 0; for (let j = 0; j < k; j++) n = n * 256 + b[p++]; }
  return { tag: b[i], inicio: i, cuerpo: p, fin: p + n };
}

const base64ABytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesABase64 = (b) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const pemADer = (pem) => base64ABytes(String(pem).replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));

// Del certificado se toman tal cual el emisor y el número de serie: así los identifica ARCA.
function datosDelCertificado(der) {
  const cert = leer(der, 0);
  const tbs = leer(der, cert.cuerpo);
  let i = tbs.cuerpo;
  let e = leer(der, i);
  if (e.tag === 0xa0) { i = e.fin; e = leer(der, i); }           // versión (opcional)
  const serie = der.subarray(e.inicio, e.fin); i = e.fin;
  e = leer(der, i); i = e.fin;                                   // algoritmo de firma
  e = leer(der, i);
  const emisor = der.subarray(e.inicio, e.fin);
  return { emisor, serie };
}

// openssl genera la clave como PKCS#8; si viniera en el formato viejo (PKCS#1) se la envuelve.
function claveParaImportar(pem) {
  const der = pemADer(pem);
  if (/RSA PRIVATE KEY/.test(String(pem))) return SEQ(ENTERO(0), SEQ(OID(...OID_RSA), NULO), OCTETOS(der));
  return der;
}

const comparar = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };

export async function firmarCms(contenido, certPem, keyPem) {
  const certDer = pemADer(certPem);
  const { emisor, serie } = datosDelCertificado(certDer);
  const clave = await crypto.subtle.importKey("pkcs8", claveParaImportar(keyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const datos = enc.encode(contenido);
  const resumen = new Uint8Array(await crypto.subtle.digest("SHA-256", datos));
  const f = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const utc = `${String(f.getUTCFullYear()).slice(2)}${p2(f.getUTCMonth() + 1)}${p2(f.getUTCDate())}${p2(f.getUTCHours())}${p2(f.getUTCMinutes())}${p2(f.getUTCSeconds())}Z`;
  const atributos = [
    SEQ(OID(...OID_ATTR(3)), SET(OID(...OID_DATA))),
    SEQ(OID(...OID_ATTR(5)), SET(tlv(0x17, enc.encode(utc)))),
    SEQ(OID(...OID_ATTR(4)), SET(OCTETOS(resumen))),
  ].sort(comparar);                                              // en DER, un SET se ordena por su contenido
  const conjunto = SET(...atributos);
  const firma = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", clave, conjunto));  // se firma el conjunto con tag de SET
  const atributosFirmados = tlv(0xa0, ...atributos);             // y se lo escribe con tag [0]
  const algoritmoSha = SEQ(OID(...OID_SHA256), NULO);
  const firmante = SEQ(ENTERO(1), SEQ(emisor, serie), algoritmoSha, atributosFirmados, SEQ(OID(...OID_RSA), NULO), OCTETOS(firma));
  const signedData = SEQ(ENTERO(1), SET(algoritmoSha), SEQ(OID(...OID_DATA), tlv(0xa0, OCTETOS(datos))), tlv(0xa0, certDer), SET(firmante));
  return SEQ(OID(...OID_SIGNED_DATA), tlv(0xa0, signedData));
}

// ---------- Utilidades de XML (el servidor no tiene DOMParser) ----------

const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xmlDes = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const etiqueta = (xml, nombre) => { const m = new RegExp(`<(?:\\w+:)?${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${nombre}>`).exec(xml); return m ? m[1] : null; };
const todas = (xml, nombre) => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${nombre}>`, "g"))].map((m) => m[1]);

// ---------- Login (WSAA) ----------

const ISO_AR = (d) => {
  const a = new Date(d.getTime() - 3 * 3600 * 1000);                // hora de Argentina (UTC-3)
  return a.toISOString().replace(/\.\d+Z$/, "-03:00");
};

async function pedirTicket(env, servicio) {
  const amb = ambienteDe(env);
  const ahoraMs = Date.now();
  const tra = `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>${Math.floor(ahoraMs / 1000)}</uniqueId><generationTime>${ISO_AR(new Date(ahoraMs - 10 * 60000))}</generationTime><expirationTime>${ISO_AR(new Date(ahoraMs + 10 * 60000))}</expirationTime></header><service>${servicio}</service></loginTicketRequest>`;
  const cms = bytesABase64(await firmarCms(tra, env.ARCA_CERT, env.ARCA_KEY));
  const sobre = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov"><soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`;
  const r = await fetchExterno(env, URLS[amb].wsaa, { method: "POST", headers: { "Content-Type": "text/xml;charset=UTF-8", SOAPAction: '""' }, body: sobre }, PLAZO_ARCA_MS);
  const texto = await r.text();
  const falla = etiqueta(texto, "faultstring");
  if (falla) throw Object.assign(new Error(`ARCA (login): ${xmlDes(falla).slice(0, 200)}`), { transitorio: r.status >= 500 && !/no autorizado|no posee|inv[aá]lid/i.test(falla) });
  const ta = xmlDes(etiqueta(texto, "loginCmsReturn") || "");
  const token = etiqueta(ta, "token"), sign = etiqueta(ta, "sign"), vence = etiqueta(ta, "expirationTime");
  if (!token || !sign || !vence) throw new Error("ARCA (login): respuesta sin ticket");
  return { token, sign, vence: new Date(vence).toISOString() };
}

export async function ticket(env, servicio = "wsfe") {
  const amb = ambienteDe(env);
  const guardado = await env.DB.prepare("SELECT token, sign, vence FROM arca_tickets WHERE servicio = ? AND ambiente = ?").bind(servicio, amb).first();
  if (guardado && Date.parse(guardado.vence) - Date.now() > 10 * 60000) return guardado;   // se renueva 10 minutos antes de que venza
  const nuevo = await pedirTicket(env, servicio);
  await env.DB.prepare("INSERT INTO arca_tickets (servicio, ambiente, token, sign, vence) VALUES (?, ?, ?, ?, ?) ON CONFLICT(servicio, ambiente) DO UPDATE SET token = excluded.token, sign = excluded.sign, vence = excluded.vence")
    .bind(servicio, amb, nuevo.token, nuevo.sign, nuevo.vence).run();
  return nuevo;
}

// ---------- Facturación electrónica (WSFE) ----------

async function llamarWsfe(env, operacion, cuerpo) {
  const sobre = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${operacion} xmlns="${NS_WSFE}">${cuerpo}</${operacion}></soap:Body></soap:Envelope>`;
  const r = await fetchExterno(env, URLS[ambienteDe(env)].wsfe, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${NS_WSFE}${operacion}"` }, body: sobre }, PLAZO_ARCA_MS);
  const texto = await r.text();
  if (!r.ok && !etiqueta(texto, `${operacion}Result`)) throw Object.assign(new Error(`ARCA (${operacion}): HTTP ${r.status}`), { transitorio: r.status >= 500 || r.status === 429 });
  return texto;
}

const auth = (env, t) => `<Auth><Token>${t.token}</Token><Sign>${t.sign}</Sign><Cuit>${xmlEsc(env.ARCA_CUIT)}</Cuit></Auth>`;
const erroresDe = (xml) => todas(etiqueta(xml, "Errors") || "", "Err").map((e) => `${etiqueta(e, "Code")}: ${xmlDes(etiqueta(e, "Msg") || "")}`);
const importe = (n) => Number(n).toFixed(2);

export async function ultimoAutorizado(env, ptoVta, tipo) {
  const t = await ticket(env);
  const xml = await llamarWsfe(env, "FECompUltimoAutorizado", `${auth(env, t)}<PtoVta>${ptoVta}</PtoVta><CbteTipo>${tipo}</CbteTipo>`);
  const errores = erroresDe(xml);
  if (errores.length) throw new Error(`ARCA: ${errores.join(" | ").slice(0, 300)}`);
  return Number(etiqueta(xml, "CbteNro"));
}

// Consulta si un número ya fue autorizado. Sirve cuando una emisión se cortó y no sabemos si ARCA llegó a aceptarla.
export async function consultarComprobante(env, ptoVta, tipo, nro) {
  const t = await ticket(env);
  const xml = await llamarWsfe(env, "FECompConsultar", `${auth(env, t)}<FeCompConsReq><CbteTipo>${tipo}</CbteTipo><CbteNro>${nro}</CbteNro><PtoVta>${ptoVta}</PtoVta></FeCompConsReq>`);
  const resultado = etiqueta(xml, "ResultGet");
  if (!resultado) return null;                                    // ARCA responde con el error 602: no existe
  return { cae: etiqueta(resultado, "CodAutorizacion"), vto: etiqueta(resultado, "FchVto"), total: Number(etiqueta(resultado, "ImpTotal")), fecha: etiqueta(resultado, "CbteFch") };
}

// Pide el CAE de una Factura C (11) o de una Nota de Crédito C (13, con `asoc` = la factura que anula) a consumidor final. Devuelve {cae, vto} o lanza un error:
//   - error.transitorio = true  -> reintentar más tarde (ARCA caída, corte de red, número ocupado)
//   - sin transitorio           -> ARCA la rechazó (observaciones/errores en el mensaje): revisar a mano
export async function solicitarCae(env, { ptoVta, tipo = 11, nro, fecha, total, asoc = null }) {
  const t = await ticket(env);
  const detalle = `<FECAEDetRequest><Concepto>1</Concepto><DocTipo>99</DocTipo><DocNro>0</DocNro><CbteDesde>${nro}</CbteDesde><CbteHasta>${nro}</CbteHasta><CbteFch>${fecha}</CbteFch><ImpTotal>${importe(total)}</ImpTotal><ImpTotConc>0.00</ImpTotConc><ImpNeto>${importe(total)}</ImpNeto><ImpOpEx>0.00</ImpOpEx><ImpTrib>0.00</ImpTrib><ImpIVA>0.00</ImpIVA><MonId>PES</MonId><MonCotiz>1</MonCotiz><CondicionIVAReceptorId>5</CondicionIVAReceptorId>${asoc ? `<CbtesAsoc><CbteAsoc><Tipo>${asoc.tipo}</Tipo><PtoVta>${asoc.ptoVta}</PtoVta><Nro>${asoc.nro}</Nro><Cuit>${xmlEsc(env.ARCA_CUIT)}</Cuit></CbteAsoc></CbtesAsoc>` : ""}</FECAEDetRequest>`;
  const xml = await llamarWsfe(env, "FECAESolicitar", `${auth(env, t)}<FeCAEReq><FeCabReq><CantReg>1</CantReg><PtoVta>${ptoVta}</PtoVta><CbteTipo>${tipo}</CbteTipo></FeCabReq><FeDetReq>${detalle}</FeDetReq></FeCAEReq>`);
  const resultado = etiqueta(xml, "Resultado");
  const det = etiqueta(xml, "FECAEDetResponse") || "";
  if (resultado === "A") {
    const cae = etiqueta(det, "CAE"), vto = etiqueta(det, "CAEFchVto");
    if (!cae || !vto) throw new Error("ARCA aprobó pero no devolvió CAE");
    return { cae, vto };
  }
  const obs = todas(etiqueta(det, "Observaciones") || "", "Obs").map((o) => `${etiqueta(o, "Code")}: ${xmlDes(etiqueta(o, "Msg") || "")}`);
  const mensaje = [...erroresDe(xml), ...obs].join(" | ") || "ARCA no devolvió el motivo";
  // 10016: el número no es el siguiente al último autorizado (otra emisión se adelantó): se reintenta con el número nuevo.
  const ocupado = /10016/.test(mensaje);
  throw Object.assign(new Error(`ARCA rechazó la factura: ${mensaje.slice(0, 400)}`), { transitorio: ocupado, numeroOcupado: ocupado });
}

export const _prueba = { leer, datosDelCertificado, pemADer, etiqueta, xmlEsc };
export { ahora };
