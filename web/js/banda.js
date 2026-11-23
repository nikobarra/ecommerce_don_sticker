// Banda de stickers en movimiento bajo la portada: los más vendidos (desde la API)
// y, si todavía no hay ventas suficientes, completa con las novedades del catálogo.
(function () {
  const pista = document.getElementById("banda");
  const seccion = document.getElementById("banda-seccion");
  if (!pista || !seccion || typeof PRODUCTOS === "undefined") return;

  const MAX = 12;
  const porId = new Map(PRODUCTOS.map((p) => [p.id, p]));
  const novedades = PRODUCTOS
    .filter((p) => p.imagen)
    .sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "") || (b.numero || 0) - (a.numero || 0));

  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function elegir(ids) {
    const lista = [];
    const vistos = new Set();
    for (const id of ids) {
      const p = porId.get(id);
      if (p && p.imagen && !vistos.has(p.id)) { vistos.add(p.id); lista.push(p); }
    }
    for (const p of novedades) {
      if (lista.length >= MAX) break;
      if (!vistos.has(p.id)) { vistos.add(p.id); lista.push(p); }
    }
    return lista;
  }

  const item = (p) =>
    `<li class="banda__item"><a href="#catalogo" aria-label="${esc(p.nombre)}, ver en el catálogo"><img src="${esc(p.imagen)}" alt="" width="120" height="120" loading="lazy"></a></li>`;

  function pintar(lista) {
    if (!lista.length) return;
    // Dos copias seguidas para que el desplazamiento sea continuo; la segunda no se lee ni se enfoca.
    const una = lista.map(item).join("");
    pista.innerHTML = una + lista.map(item).join("").replace(/<li class="banda__item">/g, '<li class="banda__item" inert>');
    pista.style.setProperty("--duracion", Math.max(20, lista.length * 3) + "s");
    seccion.hidden = false;
  }

  fetch("/api/destacados", { headers: { accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : { ids: [] }))
    .catch(() => ({ ids: [] }))
    .then((d) => pintar(elegir(Array.isArray(d.ids) ? d.ids : [])));
})();
