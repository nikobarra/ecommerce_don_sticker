(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const { api } = window.Cuenta;
  const aviso = texto => { $('taller-aviso').textContent = texto; };
  async function equipos() {
    const r = await api('/admin/taller/equipos');
    if (!r.ok) { aviso(r.datos.mensaje || 'No pude consultar los equipos.'); return; }
    $('taller-equipos').replaceChildren();
    for (const e of r.datos.equipos) {
      const li = document.createElement('li');
      li.append(document.createTextNode(`${e.nombre} · vence ${new Date(e.expires_at).toLocaleString('es-AR')} `));
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'boton boton--claro'; b.textContent = 'Revocar acceso';
      b.addEventListener('click', async () => {
        b.disabled = true;
        const r = await api('/admin/taller/revocar', { method: 'POST', cuerpo: { id: e.id } });
        if (r.ok) { aviso('Acceso revocado.'); equipos(); }
        else { b.disabled = false; aviso(r.datos.mensaje || 'No pude revocar el acceso.'); }
      });
      li.append(b); $('taller-equipos').append(li);
    }
    if (!r.datos.equipos.length) $('taller-equipos').textContent = 'No hay equipos vinculados.';
  }
  $('taller-vincular').addEventListener('submit', async event => {
    event.preventDefault();
    const b = event.target.querySelector('button'); b.disabled = true;
    try {
      const r = await api('/admin/taller/aprobar', { method: 'POST', cuerpo: { codigo: $('taller-codigo').value } });
      aviso(r.ok ? 'Computadora autorizada. Volvé a la app y pulsá Comprobar acceso.' : r.datos.mensaje || 'No pude vincular el equipo.');
      if (r.ok) { $('taller-codigo').value = ''; equipos(); }
    } finally { b.disabled = false; }
  });
  $('taller-recargar').addEventListener('click', equipos);
  if (location.hash === '#taller-panel') $('taller-panel').open = true;
})();
