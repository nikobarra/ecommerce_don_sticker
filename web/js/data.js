// ============================================================
// DATOS DE LA TIENDA. Todo lo que cambia seguido está acá.
// ============================================================

const CONFIG = {
  // Número de WhatsApp con código de país, sin + ni espacios. Ej.: "5492235555555".
  // Si queda vacío, WhatsApp se abre para que el cliente elija el contacto.
  whatsapp: "5492266440616",
  // Mail que recibe los pedidos. Si queda vacío, se abre el mail sin destinatario.
  email: "donsticker.ar@gmail.com",
  // Tamaño que se informa en cada sticker (a confirmar).
  tamano: "5 a 6 cm",
  // Puntos de entrega en persona.
  puntosDeEntrega: ["Balcarce", "Mar del Plata"],
  // Stickers a elección: $700 c/u. Desde 10, 25, 50 y 100 stickers TODO el pedido pasa al precio por unidad del tramo.
  // Hay dos precios: el de LISTA (el que se publica y se cobra por Mercado Pago) y el de TRANSFERENCIA, 10% menos.
  // Los totales se redondean al $10 más cercano (misma fórmula que worker/src/precios.js).
  precioUnitario: 700,
  descuentoTransferencia: 0.1,
  tramos: [
    { desde: 10, precio: 630 },
    { desde: 25, precio: 595 },
    { desde: 50, precio: 560 },
    { desde: 100, precio: 525 },
  ],
};

// ---------- Costo de envío a cargo del comprador ----------
// Mientras no esté la cotización automática del Correo Argentino se usa un precio fijo por zona
// (referencia del dueño, 2026-11-20). Si el Correo cotiza en producción, esa cotización tiene prioridad.
const ENVIO = {
  gramosPorSticker: 2,
  gramosEmbalaje: 40,
  // Precio del envío por zona (valores de REFERENCIA del dueño mientras no haya cotización automática del Correo).
  // Es un precio fijo por zona: no depende del peso (los pedidos de stickers pesan poco).
  zonas: [
    { zona: 1, precio: 14000 },
    { zona: 2, precio: 19000 },
    { zona: 3, precio: 24000 },
  ],
  // Provincias y zona de cada una (1 = más cercana, 3 = más lejana).
  provincias: [
    { nombre: "Buenos Aires", zona: 1 },
    { nombre: "Ciudad Autónoma de Buenos Aires", zona: 1 },
    { nombre: "Córdoba", zona: 1 },
    { nombre: "Entre Ríos", zona: 1 },
    { nombre: "La Pampa", zona: 1 },
    { nombre: "Santa Fe", zona: 1 },
    { nombre: "Catamarca", zona: 2 },
    { nombre: "Chaco", zona: 2 },
    { nombre: "Corrientes", zona: 2 },
    { nombre: "Formosa", zona: 2 },
    { nombre: "La Rioja", zona: 2 },
    { nombre: "Mendoza", zona: 2 },
    { nombre: "Misiones", zona: 2 },
    { nombre: "Neuquén", zona: 2 },
    { nombre: "Río Negro", zona: 2 },
    { nombre: "San Juan", zona: 2 },
    { nombre: "San Luis", zona: 2 },
    { nombre: "Santiago del Estero", zona: 2 },
    { nombre: "Tucumán", zona: 2 },
    { nombre: "Chubut", zona: 3 },
    { nombre: "Jujuy", zona: 3 },
    { nombre: "Salta", zona: 3 },
    { nombre: "Santa Cruz", zona: 3 },
    { nombre: "Tierra del Fuego", zona: 3 },
  ],
};

// Packs PREARMADOS: los arma la casa (10 de cada tamaño + temáticos), no son a elección.
// Cada uno cuesta 10% menos que el mismo tamaño armado por el cliente.
// <packs-generados> (catalogo/herramientas/armar_packs.py: no editar a mano)
const PACKS = [
  {"id": "pack-10-01", "nombre": "Pack 1 de 10", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "10", "imagen": "assets/packs/pack-10-01.webp"},
  {"id": "pack-10-02", "nombre": "Pack 2 de 10", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "10", "imagen": "assets/packs/pack-10-02.webp"},
  {"id": "pack-10-03", "nombre": "Pack 3 de 10", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "10", "imagen": "assets/packs/pack-10-03.webp"},
  {"id": "pack-10-04", "nombre": "Pack 4 de 10", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "10", "imagen": "assets/packs/pack-10-04.webp"},
  {"id": "pack-10-05", "nombre": "Pack 5 de 10", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "10", "imagen": "assets/packs/pack-10-05.webp"},
  {"id": "pack-10-06", "nombre": "Pack 6 de 10", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "10", "imagen": "assets/packs/pack-10-06.webp"},
  {"id": "pack-10-07", "nombre": "Pack 7 de 10", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "10", "imagen": "assets/packs/pack-10-07.webp"},
  {"id": "pack-10-08", "nombre": "Pack 8 de 10", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "10", "imagen": "assets/packs/pack-10-08.webp"},
  {"id": "pack-10-09", "nombre": "Pack 9 de 10", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "10", "imagen": "assets/packs/pack-10-09.webp"},
  {"id": "pack-10-10", "nombre": "Pack 10 de 10", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "10", "imagen": "assets/packs/pack-10-10.webp"},
  {"id": "pack-25-01", "nombre": "Pack 1 de 25", "unidades": 25, "precio": 13390, "precioTransferencia": 12050, "grupo": "25", "imagen": "assets/packs/pack-25-01.webp"},
  {"id": "pack-25-02", "nombre": "Pack 2 de 25", "unidades": 25, "precio": 13390, "precioTransferencia": 12050, "grupo": "25", "imagen": "assets/packs/pack-25-02.webp"},
  {"id": "pack-25-03", "nombre": "Pack 3 de 25", "unidades": 25, "precio": 13390, "precioTransferencia": 12050, "grupo": "25", "imagen": "assets/packs/pack-25-03.webp"},
  {"id": "pack-25-04", "nombre": "Pack 4 de 25", "unidades": 25, "precio": 13390, "precioTransferencia": 12050, "grupo": "25", "imagen": "assets/packs/pack-25-04.webp"},
  {"id": "pack-25-05", "nombre": "Pack 5 de 25", "unidades": 25, "precio": 13390, "precioTransferencia": 12050, "grupo": "25", "imagen": "assets/packs/pack-25-05.webp"},
  {"id": "pack-25-06", "nombre": "Pack 6 de 25", "unidades": 25, "precio": 13390, "precioTransferencia": 12050, "grupo": "25", "imagen": "assets/packs/pack-25-06.webp"},
  {"id": "pack-25-07", "nombre": "Pack 7 de 25", "unidades": 25, "precio": 13390, "precioTransferencia": 12050, "grupo": "25", "imagen": "assets/packs/pack-25-07.webp"},
  {"id": "pack-25-08", "nombre": "Pack 8 de 25", "unidades": 25, "precio": 13390, "precioTransferencia": 12050, "grupo": "25", "imagen": "assets/packs/pack-25-08.webp"},
  {"id": "pack-25-09", "nombre": "Pack 9 de 25", "unidades": 25, "precio": 13390, "precioTransferencia": 12050, "grupo": "25", "imagen": "assets/packs/pack-25-09.webp"},
  {"id": "pack-25-10", "nombre": "Pack 10 de 25", "unidades": 25, "precio": 13390, "precioTransferencia": 12050, "grupo": "25", "imagen": "assets/packs/pack-25-10.webp"},
  {"id": "pack-50-01", "nombre": "Pack 1 de 50", "unidades": 50, "precio": 25200, "precioTransferencia": 22680, "grupo": "50", "imagen": "assets/packs/pack-50-01.webp"},
  {"id": "pack-50-02", "nombre": "Pack 2 de 50", "unidades": 50, "precio": 25200, "precioTransferencia": 22680, "grupo": "50", "imagen": "assets/packs/pack-50-02.webp"},
  {"id": "pack-50-03", "nombre": "Pack 3 de 50", "unidades": 50, "precio": 25200, "precioTransferencia": 22680, "grupo": "50", "imagen": "assets/packs/pack-50-03.webp"},
  {"id": "pack-50-04", "nombre": "Pack 4 de 50", "unidades": 50, "precio": 25200, "precioTransferencia": 22680, "grupo": "50", "imagen": "assets/packs/pack-50-04.webp"},
  {"id": "pack-50-05", "nombre": "Pack 5 de 50", "unidades": 50, "precio": 25200, "precioTransferencia": 22680, "grupo": "50", "imagen": "assets/packs/pack-50-05.webp"},
  {"id": "pack-50-06", "nombre": "Pack 6 de 50", "unidades": 50, "precio": 25200, "precioTransferencia": 22680, "grupo": "50", "imagen": "assets/packs/pack-50-06.webp"},
  {"id": "pack-50-07", "nombre": "Pack 7 de 50", "unidades": 50, "precio": 25200, "precioTransferencia": 22680, "grupo": "50", "imagen": "assets/packs/pack-50-07.webp"},
  {"id": "pack-50-08", "nombre": "Pack 8 de 50", "unidades": 50, "precio": 25200, "precioTransferencia": 22680, "grupo": "50", "imagen": "assets/packs/pack-50-08.webp"},
  {"id": "pack-50-09", "nombre": "Pack 9 de 50", "unidades": 50, "precio": 25200, "precioTransferencia": 22680, "grupo": "50", "imagen": "assets/packs/pack-50-09.webp"},
  {"id": "pack-50-10", "nombre": "Pack 10 de 50", "unidades": 50, "precio": 25200, "precioTransferencia": 22680, "grupo": "50", "imagen": "assets/packs/pack-50-10.webp"},
  {"id": "pack-100-01", "nombre": "Pack 1 de 100", "unidades": 100, "precio": 47250, "precioTransferencia": 42530, "grupo": "100", "imagen": "assets/packs/pack-100-01.webp"},
  {"id": "pack-100-02", "nombre": "Pack 2 de 100", "unidades": 100, "precio": 47250, "precioTransferencia": 42530, "grupo": "100", "imagen": "assets/packs/pack-100-02.webp"},
  {"id": "pack-100-03", "nombre": "Pack 3 de 100", "unidades": 100, "precio": 47250, "precioTransferencia": 42530, "grupo": "100", "imagen": "assets/packs/pack-100-03.webp"},
  {"id": "pack-100-04", "nombre": "Pack 4 de 100", "unidades": 100, "precio": 47250, "precioTransferencia": 42530, "grupo": "100", "imagen": "assets/packs/pack-100-04.webp"},
  {"id": "pack-100-05", "nombre": "Pack 5 de 100", "unidades": 100, "precio": 47250, "precioTransferencia": 42530, "grupo": "100", "imagen": "assets/packs/pack-100-05.webp"},
  {"id": "pack-100-06", "nombre": "Pack 6 de 100", "unidades": 100, "precio": 47250, "precioTransferencia": 42530, "grupo": "100", "imagen": "assets/packs/pack-100-06.webp"},
  {"id": "pack-100-07", "nombre": "Pack 7 de 100", "unidades": 100, "precio": 47250, "precioTransferencia": 42530, "grupo": "100", "imagen": "assets/packs/pack-100-07.webp"},
  {"id": "pack-100-08", "nombre": "Pack 8 de 100", "unidades": 100, "precio": 47250, "precioTransferencia": 42530, "grupo": "100", "imagen": "assets/packs/pack-100-08.webp"},
  {"id": "pack-100-09", "nombre": "Pack 9 de 100", "unidades": 100, "precio": 47250, "precioTransferencia": 42530, "grupo": "100", "imagen": "assets/packs/pack-100-09.webp"},
  {"id": "pack-100-10", "nombre": "Pack 10 de 100", "unidades": 100, "precio": 47250, "precioTransferencia": 42530, "grupo": "100", "imagen": "assets/packs/pack-100-10.webp"},
  {"id": "tema-rock-10", "nombre": "Rock internacional · 10 stickers", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "tematicos", "imagen": "assets/packs/tema-rock-10.webp"},
  {"id": "tema-rock-25", "nombre": "Rock internacional · 25 stickers", "unidades": 25, "precio": 13390, "precioTransferencia": 12050, "grupo": "tematicos", "imagen": "assets/packs/tema-rock-25.webp"},
  {"id": "tema-simpson-10", "nombre": "Los Simpson · 10 stickers", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "tematicos", "imagen": "assets/packs/tema-simpson-10.webp"},
  {"id": "tema-simpson-25", "nombre": "Los Simpson · 25 stickers", "unidades": 25, "precio": 13390, "precioTransferencia": 12050, "grupo": "tematicos", "imagen": "assets/packs/tema-simpson-25.webp"},
  {"id": "tema-kpop-10", "nombre": "Guerreras K-pop · 10 stickers", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "tematicos", "imagen": "assets/packs/tema-kpop-10.webp"},
  {"id": "tema-kpop-25", "nombre": "Guerreras K-pop · 25 stickers", "unidades": 25, "precio": 13390, "precioTransferencia": 12050, "grupo": "tematicos", "imagen": "assets/packs/tema-kpop-25.webp"},
  {"id": "tema-frases-10", "nombre": "Frases argentinas · 10 stickers", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "tematicos", "imagen": "assets/packs/tema-frases-10.webp"},
  {"id": "tema-frases-25", "nombre": "Frases argentinas · 25 stickers", "unidades": 25, "precio": 13390, "precioTransferencia": 12050, "grupo": "tematicos", "imagen": "assets/packs/tema-frases-25.webp"},
  {"id": "tema-seleccion-10", "nombre": "Selección argentina · 10 stickers", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "tematicos", "imagen": "assets/packs/tema-seleccion-10.webp"},
  {"id": "tema-seleccion-25", "nombre": "Selección argentina · 25 stickers", "unidades": 25, "precio": 13390, "precioTransferencia": 12050, "grupo": "tematicos", "imagen": "assets/packs/tema-seleccion-25.webp"},
  {"id": "tema-fauna-10", "nombre": "Fauna argentina · 10 stickers", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "tematicos", "imagen": "assets/packs/tema-fauna-10.webp"},
  {"id": "tema-fauna-25", "nombre": "Fauna argentina · 25 stickers", "unidades": 25, "precio": 13390, "precioTransferencia": 12050, "grupo": "tematicos", "imagen": "assets/packs/tema-fauna-25.webp"},
  {"id": "tema-rock-nacional-10", "nombre": "Rock nacional · 10 stickers", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "tematicos", "imagen": "assets/packs/tema-rock-nacional-10.webp"},
  {"id": "tema-rock-nacional-25", "nombre": "Rock nacional · 25 stickers", "unidades": 25, "precio": 13390, "precioTransferencia": 12050, "grupo": "tematicos", "imagen": "assets/packs/tema-rock-nacional-25.webp"},
  {"id": "tema-provincias-10", "nombre": "Provincias y turismo · 10 stickers", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "tematicos", "imagen": "assets/packs/tema-provincias-10.webp"},
  {"id": "tema-provincias-25", "nombre": "Provincias y turismo · 25 stickers", "unidades": 25, "precio": 13390, "precioTransferencia": 12050, "grupo": "tematicos", "imagen": "assets/packs/tema-provincias-25.webp"},
  {"id": "tema-mafalda-10", "nombre": "Mafalda · 10 stickers", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "tematicos", "imagen": "assets/packs/tema-mafalda-10.webp"},
  {"id": "tema-clubes-10", "nombre": "Clubes argentinos · 10 stickers", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "tematicos", "imagen": "assets/packs/tema-clubes-10.webp"},
  {"id": "tema-videojuegos-10", "nombre": "Videojuegos · 10 stickers", "unidades": 10, "precio": 5670, "precioTransferencia": 5100, "grupo": "tematicos", "imagen": "assets/packs/tema-videojuegos-10.webp"},
];
// </packs-generados>

// Stickers a elección: ver js/catalogo.js (const PRODUCTOS).

