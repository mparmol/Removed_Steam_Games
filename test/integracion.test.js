// Pruebas contra Steam de verdad. Requieren red y consumen cupo del rate limit.
// Ejecutar con: node --test test/integracion.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { consultarLote, gratisAhora } from '../src/steam/store.js';
import { comentariosNuevos } from '../src/sources/remgc.js';
import { cambiosDesde, HUECO_MAX } from '../src/steam/pics.js';
import { Limitador } from '../src/lib/http.js';

const limitador = new Limitador(100);

test('deteccion de retirados: casos validados en el spike', async () => {
  // 225140 Duke Nukem 3D Megaton, 226320 Marvel Heroes y 386660 TMNT siguen retirados.
  // 620 Portal 2 y 570 Dota 2 siguen vivos.
  const r = await consultarLote([620, 570, 225140, 226320, 386660], limitador);

  assert.equal(r.get(620).visible, true, 'Portal 2 deberia estar visible');
  assert.equal(r.get(570).visible, true, 'Dota 2 deberia estar visible');
  assert.equal(r.get(225140).visible, false, 'Duke Nukem 3D Megaton sigue retirado');
  assert.equal(r.get(226320).visible, false, 'Marvel Heroes sigue retirado');
  assert.equal(r.get(386660).visible, false, 'TMNT Mutants in Manhattan sigue retirado');

  assert.equal(r.get(620).nombre, 'Portal 2');
  assert.equal(r.get(620).tipo, 'game');
});

test('is_free no distingue promo de F2P (por eso hace falta la busqueda de la tienda)', async () => {
  const r = await consultarLote([570, 620], limitador);
  assert.equal(r.get(570).gratis, true, 'Dota 2 es F2P permanente');
  assert.equal(r.get(620).gratis, false);
});

test('la busqueda de la tienda devuelve appids parseables', async () => {
  const { appids, bytes } = await gratisAhora(limitador);
  assert.ok(bytes > 10000, 'la pagina deberia traer contenido');
  assert.ok(Array.isArray(appids));
  // Si esto empieza a dar 0 durante dias seguidos es que Valve cambio el marcado
  // data-ds-appid y nos hemos quedado ciegos en silencio.
  for (const a of appids) assert.ok(Number.isInteger(a) && a > 0);
});

test('RemGC: se lee el hilo y se extraen appids de los enlaces', async () => {
  const { total, ultimaPagina, comentarios } = await comentariosNuevos(null, limitador);
  assert.ok(total > 11000, `el hilo deberia tener miles de comentarios, tiene ${total}`);
  assert.equal(ultimaPagina, Math.ceil(total / 15));
  assert.ok(comentarios.length > 0, 'la ultima pagina deberia traer comentarios');
  // los ids han de ser crecientes para poder saber que es nuevo
  const ids = comentarios.map((c) => BigInt(c.id));
  assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? -1 : 1)));
});

test('PICS: sin cursor y con hueco enorme se avisa de ventana perdida', async () => {
  const sinCursor = await cambiosDesde(null);
  assert.equal(sinCursor.ventanaPerdida, true);
  assert.equal(sinCursor.motivo, 'sin-cursor');
  assert.ok(sinCursor.actual > 38000000, 'deberia devolver el changenumber actual igualmente');

  // Este es el fallo silencioso que hay que atrapar: Steam devuelve listas vacias
  // sin error cuando te sales de la ventana, y no debemos leerlo como "nada cambio".
  const conHueco = await cambiosDesde(sinCursor.actual - (HUECO_MAX + 50000));
  assert.equal(conHueco.ventanaPerdida, true);
  assert.equal(conHueco.motivo, 'hueco-grande');
});

test('PICS: un cursor reciente si devuelve cambios', async () => {
  const ahora = await cambiosDesde(null);
  const reciente = await cambiosDesde(ahora.actual - 2000);
  assert.equal(reciente.ventanaPerdida, false);
  assert.ok(reciente.apps.length > 0, 'deberia haber apps cambiadas en 2000 changenumbers');
});
