// Prueba de punta a punta de la facturación contra el ambiente REAL de ARCA, usando el mismo código del servidor.
// No toca la base de verdad: usa una base en memoria. Guarda el acceso (ticket) de ARCA en un archivo temporal para
// no pedir uno nuevo cada vez (ARCA no entrega otro mientras el anterior sigue vigente).
//
// Uso (desde worker/):  node scripts/prueba-arca.mjs [prueba|produccion] [punto_de_venta] [solo-consulta]
//   - prueba: emite una factura de PRUEBA (sin validez fiscal).
//   - produccion con «solo-consulta»: solo verifica el acceso y consulta puntos de venta; NO emite nada.
//   - cuarto argumento «transferencia»: emite la factura como la pide el botón «Facturar» (pago por transferencia).
//   - cuarto argumento «nota»: emite una factura y después su nota de crédito que la anula.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crearEntorno } from "../test/helpers.js";
import { emitirFactura, emitirNotaCredito, pdfDeFactura, pdfDeNota } from "../src/facturacion.js";
import { ticket, ultimoAutorizado } from "../src/arca.js";

const ambiente = process.argv[2] || "prueba";
const pto = process.argv[3] || "11";
const modo = process.argv[4] || "mercadopago";
const soloConsulta = modo === "solo-consulta";
if (ambiente === "produccion" && !soloConsulta) { console.error("Por seguridad, este script en producción solo hace «solo-consulta»."); process.exit(1); }
const dir = path.join(os.homedir(), ".donsticker", "arca");
const leer = (n) => fs.readFileSync(path.join(dir, n), "utf8");
const certArchivo = ambiente === "produccion" ? fs.readdirSync(dir).find((n) => /^donsticker-prod.*\.crt$/.test(n)) : "pruebas.crt";
const claveArchivo = ambiente === "produccion" ? "produccion.key" : "pruebas.key";
const cache = path.join(os.tmpdir(), `arca-ticket-${ambiente}.json`);

const env = crearEntorno({ FACTURACION_ACTIVA: "1", ARCA_AMBIENTE: ambiente, ARCA_CUIT: "20274973022", ARCA_PTO_VTA: pto, ARCA_CERT: leer(certArchivo), ARCA_KEY: leer(claveArchivo), TIMEOUT_EXTERNO_MS: "30000" });
if (fs.existsSync(cache)) for (const t of JSON.parse(fs.readFileSync(cache, "utf8")))
  env.DB.db.prepare("INSERT OR REPLACE INTO arca_tickets (servicio, ambiente, token, sign, vence) VALUES (?, ?, ?, ?, ?)").run(t.servicio, t.ambiente, t.token, t.sign, t.vence);
const guardarTickets = () => fs.writeFileSync(cache, JSON.stringify(env.DB.db.prepare("SELECT * FROM arca_tickets").all()));

try {
  const t = await ticket(env);
  guardarTickets();
  console.log(`Acceso a ARCA (${ambiente}): OK, vence ${t.vence}`);
  if (soloConsulta) {
    console.log(`Último Factura C autorizado en el punto de venta ${pto}:`, await ultimoAutorizado(env, Number(pto), 11));
    process.exit(0);
  }
  const ahora = new Date().toISOString();
  env.DB.db.prepare("INSERT INTO users (id, email, name, unsubscribe_token, created_at) VALUES ('u1', 'prueba@ejemplo.com', 'Prueba', 'tok', ?)").run(ahora);
  const items = [{ id: "pack-10-01", nombre: "Pack 1 de 10", tipo: "pack", cantidad: 1, precio: 5670 }];
  env.DB.db.prepare("INSERT INTO orders (id, number, user_id, status, items_json, subtotal, shipping, total, delivery, customer_name, payment_method, discount, created_at, updated_at) VALUES ('p1', 'DS-PRUEBA1', 'u1', ?, ?, 5670, 0, 5670, 'Balcarce', 'Cliente de Prueba', ?, 0, ?, ?)").run(modo === 'transferencia' ? 'recibido' : 'pago_confirmado', JSON.stringify(items), modo === 'transferencia' ? 'transferencia' : 'mercadopago', ahora, ahora);
  const resultado = await emitirFactura(env, null, "https://donsticker.com.ar", "p1", { manual: modo === "transferencia" });
  guardarTickets();
  const inv = env.DB.db.prepare("SELECT status, pto_vta, cbte_tipo, cbte_nro, cbte_fecha, cae, cae_vto, ultimo_error, mail_enviado_en FROM invoices WHERE order_id = 'p1'").get();
  console.log("Resultado:", resultado, JSON.stringify(inv));
  const mail = env.DB.db.prepare("SELECT to_addr, subject, body FROM mail_log").all();
  console.log("Mails simulados:", mail.map((m) => `${m.to_addr} | ${m.subject}`));
  const hecho = await pdfDeFactura(env, "p1");
  if (modo === "nota") {
    const rn = await emitirNotaCredito(env, null, "https://donsticker.com.ar", "p1", "Prueba de nota de crédito");
    guardarTickets();
    console.log("Nota de crédito:", rn, JSON.stringify(env.DB.db.prepare("SELECT status, cbte_tipo, cbte_nro, cae, ultimo_error FROM credit_notes").get()));
    const hn = await pdfDeNota(env, "p1");
    if (hn) { const sn = path.join(os.tmpdir(), "nota-credito-homologacion.pdf"); fs.writeFileSync(sn, hn.pdf); console.log("PDF de la nota:", sn); }
  }
  if (hecho) { const salida = path.join(os.tmpdir(), "factura-homologacion.pdf"); fs.writeFileSync(salida, hecho.pdf); console.log("PDF:", salida); }
} catch (e) {
  guardarTickets();
  console.error("FALLÓ:", e.message);
  process.exit(1);
}
