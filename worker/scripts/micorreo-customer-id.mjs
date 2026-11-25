// Averigua el customerId que MiCorreo (Correo Argentino) le asignó a la cuenta, para cargarlo como secreto MICORREO_CUSTOMER_ID.
// Se corre en TU computadora: las credenciales las lee de variables de entorno de esa sesión y no se guardan en ningún lado.
//
//   $env:MICORREO_USER = "usuario de la API"        $env:MICORREO_PASSWORD = "contraseña de la API"
//   $env:MICORREO_EMAIL = "mail de tu cuenta MiCorreo"   $env:MICORREO_CUENTA_PASSWORD = "contraseña de tu cuenta MiCorreo"
//   node scripts/micorreo-customer-id.mjs            (agregar «prueba» para usar el ambiente de pruebas)
//
// Flujo oficial: POST /token (Basic con el usuario y la contraseña de la API) -> POST /users/validate (con el mail y la
// contraseña de la cuenta MiCorreo) -> devuelve customerId. Solo imprime el customerId; nunca las credenciales.

const prueba = process.argv.includes("prueba");
const BASE = prueba ? "https://apitest.correoargentino.com.ar/micorreo/v1" : "https://api.correoargentino.com.ar/micorreo/v1";
const { MICORREO_USER: usuario, MICORREO_PASSWORD: clave, MICORREO_EMAIL: mail, MICORREO_CUENTA_PASSWORD: claveCuenta } = process.env;
if (!usuario || !clave || !mail || !claveCuenta) {
  console.error("Faltan variables: MICORREO_USER, MICORREO_PASSWORD, MICORREO_EMAIL y MICORREO_CUENTA_PASSWORD.");
  process.exit(1);
}

// La API del Correo corta conexiones y responde 5xx de vez en cuando: cada llamada se reintenta hasta 6 veces.
async function pedir(url, opciones) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, opciones);
      if (r.status < 500 && r.status !== 429) return r;
      if (i >= 6) return r;
      console.error(`  (el Correo respondió ${r.status}, reintento ${i}/5…)`);
    } catch (e) {
      if (i >= 6) throw new Error(`No pude conectarme al Correo tras 6 intentos (${e.cause?.code || e.message}). Probá de nuevo en unos minutos.`);
      console.error(`  (conexión cortada, reintento ${i}/5…)`);
    }
    await new Promise((ok) => setTimeout(ok, 1500 * i));
  }
}

const t = await pedir(`${BASE}/token`, { method: "POST", headers: { Authorization: "Basic " + Buffer.from(`${usuario}:${clave}`).toString("base64") } });
if (!t.ok) { console.error(`No pude obtener el token (${t.status}). Revisá usuario y contraseña de la API.`); process.exit(1); }
const { token } = await t.json();

const v = await pedir(`${BASE}/users/validate`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ email: mail, password: claveCuenta }),
});
const cuerpo = await v.json().catch(() => ({}));
if (!v.ok) { console.error(`El Correo no validó la cuenta (${v.status}): ${cuerpo.message || "sin detalle"}`); process.exit(1); }
console.log(`customerId = ${cuerpo.customerId}`);

// Prueba de cotización con ese customerId y con sus variantes (con y sin ceros a la izquierda), para ver cuál acepta el Correo.
const id = String(cuerpo.customerId);
const variantes = [...new Set([id, id.replace(/^0+/, ""), process.env.MICORREO_CUSTOMER_ID].filter(Boolean))];
for (const customerId of variantes) {
  const r = await pedir(`${BASE}/rates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ customerId, postalCodeOrigin: "7620", postalCodeDestination: "1425", deliveredType: "D", dimensions: { weight: 60, height: 3, width: 18, length: 25 } }),
  });
  const t = await r.text();
  console.log(`cotización con customerId "${customerId}": ${r.status} ${t.replace(/\s+/g, " ").slice(0, 220)}`);
}
