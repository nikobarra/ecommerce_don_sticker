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

const t = await fetch(`${BASE}/token`, { method: "POST", headers: { Authorization: "Basic " + Buffer.from(`${usuario}:${clave}`).toString("base64") } });
if (!t.ok) { console.error(`No pude obtener el token (${t.status}). Revisá usuario y contraseña de la API.`); process.exit(1); }
const { token } = await t.json();

const v = await fetch(`${BASE}/users/validate`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ email: mail, password: claveCuenta }),
});
const cuerpo = await v.json().catch(() => ({}));
if (!v.ok) { console.error(`El Correo no validó la cuenta (${v.status}): ${cuerpo.message || "sin detalle"}`); process.exit(1); }
console.log(`customerId = ${cuerpo.customerId}`);
