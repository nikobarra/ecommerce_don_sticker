// PDF de la Factura C, escrito a mano (sin librerías): una página A4 con los datos que exige ARCA y el código QR.
// Usa las tipografías estándar de PDF (Helvetica), que no hace falta incluir en el archivo.

import qrcode from "./vendor/qrcode-generator.mjs";
import { LOGO } from "./logo-factura.js";

const ANCHO = 595.28, ALTO = 841.89;

// Anchos de Helvetica y Helvetica-Bold (milésimas de em) para los caracteres 32 a 126, para poder alinear a la derecha y centrar.
const W = {
  n: [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584],
  b: [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584],
};
const sinTilde = (c) => c.normalize("NFD").replace(/[̀-ͯ]/g, "");
function ancho(texto, tam, negrita) {
  const t = negrita ? W.b : W.n;
  let suma = 0;
  for (const ch of String(texto)) {
    const c = sinTilde(ch).charCodeAt(0);
    suma += c >= 32 && c <= 126 ? t[c - 32] : 556;
  }
  return (suma * tam) / 1000;
}

// WinAnsi coincide con Latin-1 para este uso; lo que no entra (por ejemplo guiones largos) se reemplaza.
const reemplazos = { "–": "-", "—": "-", "“": '"', "”": '"', "‘": "'", "’": "'", "…": "...", "€": "EUR" };
const latin1 = (s) => String(s).replace(/[–—“”‘’…€]/g, (c) => reemplazos[c]).replace(/[^\x00-\xff]/g, "?");
const escapar = (s) => latin1(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const n2 = (n) => (Math.round(n * 100) / 100).toString();

class Pagina {
  constructor() { this.ops = []; }
  // y se mide desde ARRIBA de la hoja, como se piensa un diseño.
  texto(x, y, s, { tam = 9, negrita = false, alinear = "izq", maximo } = {}) {
    let t = String(s);
    if (maximo) { while (t.length > 1 && ancho(t, tam, negrita) > maximo) t = t.slice(0, -1); if (t !== String(s)) t = t.replace(/.$/, "…"); }
    const w = ancho(t, tam, negrita);
    const px = alinear === "der" ? x - w : alinear === "centro" ? x - w / 2 : x;
    this.ops.push(`BT /${negrita ? "F2" : "F1"} ${tam} Tf ${n2(px)} ${n2(ALTO - y)} Td (${escapar(t)}) Tj ET`);
  }
  linea(x1, y1, x2, y2, grosor = 0.8) { this.ops.push(`${grosor} w ${n2(x1)} ${n2(ALTO - y1)} m ${n2(x2)} ${n2(ALTO - y2)} l S`); }
  caja(x, y, w, h, { relleno, grosor = 0.8 } = {}) {
    this.ops.push(`${grosor} w ${n2(x)} ${n2(ALTO - y - h)} ${n2(w)} ${n2(h)} re ${relleno ? `q ${relleno} rg f Q ` : ""}S`);
  }
  // Dibuja el logo (imagen 1 del documento) con la esquina superior izquierda en (x, y).
  logo(x, y, w) { const h = (w * LOGO.alto) / LOGO.ancho; this.ops.push(`q ${n2(w)} 0 0 ${n2(h)} ${n2(x)} ${n2(ALTO - y - h)} cm /Im1 Do Q`); }
  negro(x, y, w, h) { this.ops.push(`${n2(x)} ${n2(ALTO - y - h)} ${n2(w)} ${n2(h)} re f`); }
}

// Los datos del logo ya vienen comprimidos (zlib) y en Base64: atob los devuelve como texto de bytes (0-255).
const rgbBin = atob(LOGO.rgb), alfaBin = atob(LOGO.alfa);

function armarPdf(contenido) {
  const objetos = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ANCHO} ${ALTO}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> /XObject << /Im1 7 0 R >> >> /Contents 6 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Length ${contenido.length} >>\nstream\n${contenido}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width ${LOGO.ancho} /Height ${LOGO.alto} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask 8 0 R /Length ${rgbBin.length} >>\nstream\n${rgbBin}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width ${LOGO.ancho} /Height ${LOGO.alto} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${alfaBin.length} >>\nstream\n${alfaBin}\nendstream`,
  ];
  let salida = "%PDF-1.4\n";
  const posiciones = [];
  objetos.forEach((o, i) => { posiciones.push(salida.length); salida += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = salida.length;
  salida += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n${posiciones.map((p) => String(p).padStart(10, "0") + " 00000 n \n").join("")}`;
  salida += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(salida.length);
  for (let i = 0; i < salida.length; i++) bytes[i] = salida.charCodeAt(i) & 255;
  return bytes;
}

export const fechaLarga = (aaaammdd) => `${aaaammdd.slice(6, 8)}/${aaaammdd.slice(4, 6)}/${aaaammdd.slice(0, 4)}`;
const pesos = (n) => "$ " + Number(n).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ceros = (n, largo) => String(n).padStart(largo, "0");

// Texto del código QR que ARCA exige en cada comprobante (RG 4892): enlace con los datos en JSON y Base64.
export function urlQr({ fecha, cuit, ptoVta, tipo, nro, total, cae }) {
  const datos = { ver: 1, fecha: `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`, cuit: Number(cuit), ptoVta: Number(ptoVta), tipoCmp: Number(tipo), nroCmp: Number(nro), importe: Number(total), moneda: "PES", ctz: 1, tipoDocRec: 99, nroDocRec: 0, tipoCodAut: "E", codAut: Number(cae) };
  return `https://www.afip.gob.ar/fe/qr/?p=${btoa(JSON.stringify(datos))}`;
}

// Líneas del comprobante. Si por algo no cierran con el total cobrado, se factura una sola línea por el total: lo que
// manda es el importe autorizado por ARCA.
export function lineasFactura(pedido) {
  const items = pedido.items || [];
  const packs = items.filter((i) => i.tipo === "pack");
  const sueltos = items.filter((i) => i.tipo !== "pack");
  const lineas = packs.map((i) => ({ desc: i.nombre, cant: i.cantidad, unit: i.precio, sub: i.precio * i.cantidad }));
  const totalPacks = lineas.reduce((n, l) => n + l.sub, 0);
  const cantSueltos = sueltos.reduce((n, i) => n + i.cantidad, 0);
  const totalSueltos = pedido.subtotal - totalPacks;
  if (cantSueltos > 0) {
    const unit = totalSueltos / cantSueltos;
    if (Number.isInteger(unit) && sueltos.length <= 14) for (const i of sueltos) lineas.push({ desc: i.nombre, cant: i.cantidad, unit, sub: unit * i.cantidad });
    else lineas.push({ desc: `Stickers a elección (${sueltos.length} diseños)`, cant: cantSueltos, unit: Number.isInteger(unit) ? unit : null, sub: totalSueltos });
  }
  if (pedido.shipping > 0) lineas.push({ desc: "Gastos de envío", cant: 1, unit: pedido.shipping, sub: pedido.shipping });
  if (pedido.discount > 0) lineas.push({ desc: "Descuento", cant: 1, unit: -pedido.discount, sub: -pedido.discount });
  if (lineas.reduce((n, l) => n + l.sub, 0) !== pedido.total || lineas.length > 22) return [{ desc: `Pedido ${pedido.number}`, cant: 1, unit: pedido.total, sub: pedido.total }];
  return lineas;
}

export function generarFacturaPdf({ emisor, pedido, factura }) {
  const p = new Pagina();
  // Etiqueta en negrita seguida de su valor, sin que se pisen: el valor arranca donde termina la etiqueta.
  const campo = (x, y, etiqueta, valor, maximo) => { p.texto(x, y, etiqueta, { tam: 8, negrita: true }); p.texto(x + ancho(etiqueta, 8, true) + 3, y, valor, { tam: 8, maximo }); };
  const letra = factura.tipo === 11 || factura.tipo === 13 ? "C" : "?";
  const esNota = factura.tipo === 13;
  const nroFmt = `${ceros(factura.ptoVta, 5)}-${ceros(factura.nro, 8)}`;
  p.caja(30, 30, 535, 118);
  p.linea(297, 30, 297, 78); p.linea(297, 98, 297, 148);
  p.caja(277, 30, 40, 48, { relleno: "1 1 1" });
  p.texto(297, 64, letra, { tam: 32, negrita: true, alinear: "centro" });
  p.texto(297, 90, `COD. ${ceros(factura.tipo, 3)}`, { tam: 7, negrita: true, alinear: "centro" });
  // Emisor
  p.logo(42, 36, 122);
  campo(42, 92, "Razón social: ", emisor.razonSocial, 170);
  campo(42, 107, "Domicilio comercial: ", emisor.domicilio, 160);
  campo(42, 122, "Condición frente al IVA: ", emisor.condicionIva, 140);
  // Comprobante
  p.texto(335, 54, esNota ? "NOTA DE CRÉDITO" : "FACTURA", { tam: esNota ? 15 : 17, negrita: true });
  campo(335, 82, "Punto de venta:", ceros(factura.ptoVta, 5)); campo(430, 82, "Comp. Nro:", ceros(factura.nro, 8));
  campo(335, 96, "Fecha de emisión: ", fechaLarga(factura.fecha));
  campo(335, 110, "CUIT: ", String(emisor.cuit));
  campo(335, 124, "Ingresos Brutos: ", emisor.ingresosBrutos, 165);
  campo(335, 138, "Inicio de actividades: ", emisor.inicioActividades);
  // Receptor
  p.caja(30, 156, 535, 56);
  campo(42, 174, "Apellido y nombre / Razón social: ", pedido.customer_name || "Consumidor Final", 370);
  campo(42, 190, "Condición frente al IVA: ", "Consumidor Final");
  campo(310, 190, "Condición de venta: ", pedido.payment_method === "transferencia" ? "Transferencia bancaria" : "Mercado Pago");
  campo(42, 204, "Pedido: ", pedido.number);
  // Una nota de crédito dice qué factura anula (dato que ARCA también recibe) y, si se cargó, el motivo.
  if (esNota && factura.asociado) campo(150, 204, "Anula la Factura C Nº ", nroFmtDe(factura.asociado.ptoVta, factura.asociado.nro));
  if (esNota && factura.motivo) campo(330, 204, "Motivo: ", factura.motivo, 225);
  // Detalle
  p.caja(30, 222, 535, 20, { relleno: "0.86 0.86 0.86" });
  p.texto(42, 235, "Descripción", { tam: 8, negrita: true });
  p.texto(385, 235, "Cant.", { tam: 8, negrita: true, alinear: "der" });
  p.texto(470, 235, "Precio unit.", { tam: 8, negrita: true, alinear: "der" });
  p.texto(555, 235, "Subtotal", { tam: 8, negrita: true, alinear: "der" });
  let y = 258;
  for (const l of lineasFactura(pedido)) {
    p.texto(42, y, l.desc, { tam: 8.5, maximo: 290 });
    p.texto(385, y, String(l.cant), { tam: 8.5, alinear: "der" });
    if (l.unit != null) p.texto(470, y, pesos(l.unit), { tam: 8.5, alinear: "der" });
    p.texto(555, y, pesos(l.sub), { tam: 8.5, alinear: "der" });
    y += 15;
  }
  // Totales (Factura C: no se discrimina IVA)
  p.linea(30, 640, 565, 640);
  p.texto(470, 660, "Importe total:", { tam: 11, negrita: true, alinear: "der" });
  p.texto(555, 660, pesos(factura.total), { tam: 11, negrita: true, alinear: "der" });
  // QR + CAE
  const qr = qrcode(0, "M"); qr.addData(urlQr({ ...factura, cuit: emisor.cuit }), "Byte"); qr.make();
  const m = qr.getModuleCount(), celda = 100 / m, x0 = 36, y0 = 690;
  for (let f = 0; f < m; f++) for (let c = 0; c < m; c++) if (qr.isDark(f, c)) p.negro(x0 + c * celda, y0 + f * celda, celda + 0.05, celda + 0.05);
  p.texto(150, 712, "Comprobante autorizado", { tam: 9, negrita: true });
  p.texto(150, 726, "Escaneá el código para verificarlo en ARCA.", { tam: 8 });
  p.texto(555, 690, "CAE N°: ", { tam: 9, negrita: true, alinear: "der" });
  p.texto(555, 704, factura.cae, { tam: 9, alinear: "der" });
  p.texto(555, 722, "Fecha de vto. de CAE: ", { tam: 9, negrita: true, alinear: "der" });
  p.texto(555, 736, fechaLarga(factura.caeVto), { tam: 9, alinear: "der" });
  p.texto(297.5, 800, "Don Sticker · donsticker.com.ar", { tam: 8, alinear: "centro" });
  return armarPdf(p.ops.join("\n"));
}

export { nroFmtDe };
function nroFmtDe(ptoVta, nro) { return `${ceros(ptoVta, 5)}-${ceros(nro, 8)}`; }
