// Pruebas del envío por Resend, con respuestas simuladas (no se manda ningún mail real).
import { test } from "node:test";
import assert from "node:assert/strict";
import { enviarMail } from "../src/mail.js";

const ENV = {
  MAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_clave_de_prueba",
  MAIL_FROM: "Don Sticker <pedidos@mail.donsticker.com.ar>",
  MAIL_FROM_NEWS: "Don Sticker <novedades@news.donsticker.com.ar>",
  MAIL_REPLY_TO: "donsticker.ar@gmail.com",
};

function simular(respuestas) {
  const llamadas = [];
  globalThis.fetch = async (url, opts) => {
    llamadas.push({ url, cabeceras: opts.headers, cuerpo: JSON.parse(opts.body) });
    const r = respuestas[Math.min(llamadas.length - 1, respuestas.length - 1)];
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.cuerpo ?? { id: "mail-1" }), { status: r.status ?? 200, headers: r.cabeceras ?? {} });
  };
  return llamadas;
}

test("un aviso sale del remitente de avisos, con respuesta a tu Gmail y clave de idempotencia", async () => {
  const llamadas = simular([{ status: 200, cuerpo: { id: "abc" } }]);
  const id = await enviarMail(ENV, { to: "cliente@ejemplo.com", subject: "Hola", text: "texto", html: "<p>html</p>" });
  assert.equal(id, "abc");
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].url, "https://api.resend.com/emails");
  assert.equal(llamadas[0].cuerpo.from, ENV.MAIL_FROM);
  assert.deepEqual(llamadas[0].cuerpo.to, ["cliente@ejemplo.com"]);
  assert.equal(llamadas[0].cuerpo.reply_to, "donsticker.ar@gmail.com");
  assert.equal(llamadas[0].cabeceras.Authorization, "Bearer re_clave_de_prueba");
  assert.ok(llamadas[0].cabeceras["Idempotency-Key"]);
});

test("las novedades salen del otro subdominio y llevan el enlace de baja en los encabezados", async () => {
  const llamadas = simular([{ status: 200 }]);
  await enviarMail(ENV, { to: "a@b.com", subject: "Novedades", text: "t", html: "h", tipo: "novedades", bajaUrl: "https://donsticker.com.ar/baja?t=abc" });
  assert.equal(llamadas[0].cuerpo.from, ENV.MAIL_FROM_NEWS);
  assert.equal(llamadas[0].cuerpo.headers["List-Unsubscribe"], "<https://donsticker.com.ar/baja?t=abc>");
  assert.equal(llamadas[0].cuerpo.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

test("ante un error 500 reintenta con la misma clave de idempotencia y termina enviando", async () => {
  const llamadas = simular([{ status: 500 }, { status: 429, cabeceras: { "retry-after": "0" } }, { status: 200, cuerpo: { id: "ok" } }]);
  const id = await enviarMail(ENV, { to: "a@b.com", subject: "x", text: "t", html: "h" });
  assert.equal(id, "ok");
  assert.equal(llamadas.length, 3);
  assert.equal(new Set(llamadas.map((l) => l.cabeceras["Idempotency-Key"])).size, 1);
});

test("ante un error del cliente (por ejemplo 422) no reintenta", async () => {
  const llamadas = simular([{ status: 422 }]);
  await assert.rejects(() => enviarMail(ENV, { to: "a@b.com", subject: "x", text: "t", html: "h" }), /mail 422/);
  assert.equal(llamadas.length, 1);
});

test("si falla siempre, termina con error tras 3 intentos y sin filtrar la clave", async () => {
  const llamadas = simular([new Error("red caída")]);
  await assert.rejects(() => enviarMail(ENV, { to: "a@b.com", subject: "x", text: "t", html: "h" }), (e) => {
    assert.ok(!String(e.message).includes("re_clave_de_prueba"));
    return /red caída/.test(e.message);
  });
  assert.equal(llamadas.length, 3);
});
