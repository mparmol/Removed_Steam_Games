// Pruebas de las funciones puras. No tocan la red.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { promosDePaquetes, promosQueTocanAvisar } from '../src/steam/promos.js';
import { recortarJson, appidsDeTexto, anuncioDeTexto } from '../src/sources/remgc.js';
import { enlacesDe, crearEvento, deduplicar, esUrgente, topicDe } from '../src/core/eventos.js';
import { Limitador } from '../src/lib/http.js';
import { dejaDeVerse, dejaDeVenderse } from '../src/core/ciclo.js';
import { escribirApp, leerApp } from '../src/core/estado.js';
import { clasificar } from '../src/steam/store.js';
import { publicar } from '../src/core/feed.js';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const enSegundos = (ms) => Math.floor(ms / 1000);

test('promos: descarta paquetes de demo desactivada', () => {
  // Caso real del spike: billingtype 12 con ventana temporal, pero es una demo.
  const r = promosDePaquetes([{
    packageid: 1571819,
    billingtype: 12,
    extended: { deactivated_demo: '1', starttime: '1592325000', expirytime: '1592345160', freeweekend: 'false' },
    appids: [4505620],
  }]);
  assert.equal(r.length, 0);
});

test('promos: descarta el timestamp centinela 2020-06-16', () => {
  const centinela = enSegundos(Date.UTC(2020, 5, 16, 16, 30));
  const r = promosDePaquetes([{
    packageid: 1163070,
    billingtype: 12,
    extended: { starttime: String(centinela), expirytime: String(centinela + 20000) },
    appids: [3283270],
  }]);
  assert.equal(r.length, 0);
});

test('promos: descarta promociones ya terminadas', () => {
  const r = promosDePaquetes([{
    packageid: 1,
    billingtype: 12,
    extended: { starttime: '1000000', expirytime: '2000000' },
    appids: [10],
  }]);
  assert.equal(r.length, 0);
});

test('promos: acepta una free-to-keep futura y distingue el finde gratis', () => {
  const futuro = enSegundos(Date.now()) + 86400;
  const paquetes = [
    { packageid: 100, billingtype: 12, extended: { starttime: String(futuro), expirytime: String(futuro + 172800) }, appids: [111] },
    { packageid: 200, billingtype: 12, extended: { starttime: String(futuro), expirytime: String(futuro + 172800), freeweekend: 'true' }, appids: [222] },
    { packageid: 300, billingtype: 10, extended: { starttime: String(futuro) }, appids: [333] }, // no es gratis
  ];
  const r = promosDePaquetes(paquetes);
  assert.equal(r.length, 2);
  assert.equal(r.find((p) => p.packageid === 100).tipo, 'free_to_keep');
  assert.equal(r.find((p) => p.packageid === 200).tipo, 'finde_gratis');
});

test('promos: una promo guardada hace dias dispara su aviso cuando llega la fecha', () => {
  // Esta es la leccion de Deponia: el aviso no puede depender de que PICS
  // vuelva a mencionar el paquete, porque no lo hara.
  const ahora = Date.now();
  const guardadas = {
    500: { packageid: 500, tipo: 'free_to_keep', inicio: new Date(ahora - 60000).toISOString(), fin: new Date(ahora + 86400000).toISOString(), apps: [1], avisado_proximo: true, avisado_inicio: false },
    501: { packageid: 501, tipo: 'free_to_keep', inicio: new Date(ahora + 86400000).toISOString(), fin: new Date(ahora + 172800000).toISOString(), apps: [2], avisado_proximo: false, avisado_inicio: false },
    502: { packageid: 502, tipo: 'free_to_keep', inicio: new Date(ahora - 172800000).toISOString(), fin: new Date(ahora - 86400000).toISOString(), apps: [3], avisado_proximo: true, avisado_inicio: true },
  };
  const { proximas, empiezan } = promosQueTocanAvisar(guardadas, ahora);
  assert.deepEqual(empiezan.map((p) => p.packageid), [500]);
  assert.deepEqual(proximas.map((p) => p.packageid), [501]);
});

test('remgc: recortarJson sobrevive a llaves dentro de cadenas', () => {
  // El contador ingenuo de llaves se rompe justo aqui y devuelve un objeto truncado.
  const html = `basura "comments_raw":{"1":{"text":"esto tiene una } y una { dentro","author":"a"},"2":{"text":"ok","author":"b"}} mas basura`;
  const r = recortarJson(html, 'comments_raw');
  assert.equal(Object.keys(r).length, 2);
  assert.equal(r['2'].text, 'ok');
});

test('remgc: extrae appids de las tres formas de enlace', () => {
  const texto = 'Coast Defender https://steamcommunity.com/games/2503150/announcements/detail/698772986506775359/ https://steamdb.info/app/2503150/ y https://store.steampowered.com/app/620/';
  assert.deepEqual(appidsDeTexto(texto).sort((a, b) => a - b), [620, 2503150]);
  assert.match(anuncioDeTexto(texto), /announcements\/detail\/698772986506775359/);
});

test('eventos: el enlace de allkeyshop usa el nombre, no el appid', () => {
  const e = enlacesDe(226320, 'Marvel Heroes');
  assert.equal(e.allkeyshop, 'https://www.allkeyshop.com/blog/products/?search_name=Marvel%20Heroes');
  assert.equal(e.steam, 'https://store.steampowered.com/app/226320/');
  // sin nombre no se puede buscar: mejor no poner el enlace que ponerlo roto
  assert.equal(enlacesDe(1, '').allkeyshop, undefined);
});

test('eventos: deduplicar conserva el confirmado sobre el provisional', () => {
  const base = { tipo: 'retirado', appid: 226320, nombre: 'X', fuente: 'pics', detectado: '2026-08-15T10:00:00.000Z' };
  const r = deduplicar([
    crearEvento({ ...base, confianza: 'provisional' }),
    crearEvento({ ...base, confianza: 'confirmado' }),
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].confianza, 'confirmado');
});

test('eventos: urgencia y topics segun el tipo de contenido', () => {
  const juego = crearEvento({ tipo: 'retirado', appid: 1, app_type: 'game', fuente: 'pics' });
  const dlc = crearEvento({ tipo: 'retirado', appid: 2, app_type: 'dlc', fuente: 'pics' });
  const gratis = crearEvento({ tipo: 'gratis_activo', appid: 3, app_type: 'game', fuente: 'tienda' });

  assert.equal(esUrgente(juego), true);
  assert.equal(esUrgente(dlc), false, 'el DLC va a resumen, que si no es un bombardeo');
  assert.equal(esUrgente(gratis), true);
  assert.equal(topicDe(dlc), 'retirado_dlc');
  assert.equal(topicDe(gratis), 'gratis_activo');
});

test('eventos: rechaza tipos desconocidos', () => {
  assert.throws(() => crearEvento({ tipo: 'inventado', appid: 1, fuente: 'x' }), /tipo de evento desconocido/);
});

test('limitador: bloquea al agotar el cupo y deja pasar al vencer la ventana', async () => {
  // ventana corta a proposito: con 5 min reales el test dejaria un temporizador colgando
  const l = new Limitador(3, 400);
  for (let i = 0; i < 3; i++) await l.esperarTurno();

  let pasó = false;
  const cuarta = l.esperarTurno().then(() => { pasó = true; });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(pasó, false, 'la cuarta peticion deberia quedarse esperando');

  await cuarta;
  assert.equal(pasó, true, 'al vencer la ventana deberia continuar sola');
});

test('remgc: los ids NO son crecientes, hay que llevar registro de lo visto', () => {
  // Caso real de la pagina 779: dos rangos de id distintos conviviendo, y el mayor
  // aparece ANTES. Filtrar por "id > ultimo" se salta comentarios nuevos.
  const enPagina = ['581679396200450653', '418424007826614558', '418424007826728115'];
  const maximo = enPagina.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
  assert.equal(maximo, '581679396200450653', 'el mayor es el primero de la pagina');

  const conMaximo = enPagina.filter((id) => BigInt(id) > BigInt(maximo));
  assert.equal(conMaximo.length, 0, 'un filtro por maximo se traga los dos siguientes');

  const vistos = new Set(['581679396200450653']);
  const conRegistro = enPagina.filter((id) => !vistos.has(id));
  assert.equal(conRegistro.length, 2, 'el registro explicito si los detecta');
});

test('store: los codigos de tipo son los comprobados contra el catalogo real', async () => {
  const { normalizarTipo } = await import('../src/steam/store.js');
  // verificados enumerando por filtro de tipo y mirando el `type` devuelto
  assert.equal(normalizarTipo(0), 'game');
  assert.equal(normalizarTipo(1), 'demo', 'las demos son 1, no 14');
  assert.equal(normalizarTipo(4), 'dlc');
  assert.equal(normalizarTipo(6), 'application');
  assert.equal(normalizarTipo(7), 'video');
  assert.equal(normalizarTipo(11), 'music', 'la musica es 11, no 10');
  assert.equal(normalizarTipo(99), 'otro');
});

test('reparto de shards: por appid esta sesgado, por posicion no', () => {
  // El 94,6% de los appids de Steam son multiplos de 10, y multiplo de 10 modulo 12
  // siempre da resto par: la mitad de los shards se quedaban vacios.
  const appids = Array.from({ length: 12000 }, (_, i) => (i + 1) * 10);

  const porResto = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, 0]));
  for (const a of appids) porResto[a % 12] += 1;
  const restos = Object.values(porResto);
  assert.equal(Math.min(...restos), 0, 'con % hay shards que no reciben nada');

  const porPosicion = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, 0]));
  [...appids].sort((a, b) => a - b).forEach((_, i) => { porPosicion[i % 12] += 1; });
  const pos = Object.values(porPosicion);
  assert.equal(Math.max(...pos) - Math.min(...pos) <= 1, true, 'por posicion queda equilibrado');
});

test('transiciones: comparar `comprable` a traves de una app invisible es lo que generaba el ruido', () => {
  // `comprable` vale true por definicion en los tipos que nunca se venden ('otro',
  // demo, playtest). Con la app ya invisible, cada barrido veia oscilar el valor y
  // reemitia "retirado": 4.344 falsos de tipo `otro` en nueve dias, los mismos
  // appids una noche tras otra (2855560 "流亡黯道" salio seis dias seguidos).
  const yaFuera = { visible: false, comprable: false, comprableConocido: true };
  const observado = { visible: false, comprable: true };
  assert.equal(dejaDeVerse(yaFuera, observado), false);
  assert.equal(dejaDeVenderse(yaFuera, observado), false, 'sin ficha publicada no hay nada que comparar');

  // el caso legitimo (Anvillage): ficha viva antes y ahora, pero se queda sin paquetes
  const aLaVenta = { visible: true, comprable: true, comprableConocido: true };
  assert.equal(dejaDeVenderse(aLaVenta, { visible: true, comprable: false }), true);
  // y la retirada de toda la vida
  assert.equal(dejaDeVerse(aLaVenta, { visible: false, comprable: false }), true);
});

test('estado: omitir `comprable` conserva lo medido, no lo deduce de `visible`', () => {
  // Deducirlo de `visible` hacia que cada barrido reescribiera el valor real; al dia
  // siguiente volvia a "cambiar" y se repetia el aviso. 942 juegos -> 7.716 eventos.
  const estado = { apps: {} };
  escribirApp(estado, 42, { visible: true, nombre: 'X', tipo: 'game', precio: '9,99€', comprable: false });
  assert.equal(leerApp(estado, 42).comprable, false);

  escribirApp(estado, 42, { visible: true, nombre: 'X', tipo: 'game', precio: '9,99€' });
  assert.equal(leerApp(estado, 42).comprable, false, 'sin dato nuevo se conserva el ultimo medido');
});

test('topics: retirado y no-comprable se parten por tipo de contenido', () => {
  // `no_comprable` era un topic plano al que la app ni se suscribia: no habia forma
  // de silenciar la avalancha de DLC ni de demos.
  assert.equal(topicDe({ tipo: 'no_comprable', app_type: 'dlc' }), 'no_comprable_dlc');
  assert.equal(topicDe({ tipo: 'retirado', app_type: 'demo' }), 'retirado_demo');
  assert.equal(topicDe({ tipo: 'retirada_anunciada', app_type: 'game' }), 'retirada_anunciada');
});

test('eventos: `revivido` ya no existe como tipo', () => {
  // 433 eventos en nueve dias y ninguno era un regreso real.
  assert.throws(() => crearEvento({ tipo: 'revivido', appid: 1, fuente: 'pics' }), /tipo de evento desconocido/);
});

test('clasificar: lo que decide es si se puede comprar desde nuestro mercado', () => {
  // Dungeon Siege III (39160): `visible` daba false en ES pero se compraba en los
  // cuatro mercados. Se publicaba como "bloqueado en Espana" algo que estaba a la
  // venta aqui mismo.
  assert.equal(
    clasificar({ retirado: false, visibleEn: ['US', 'JP'], comprableEn: ['ES', 'US', 'JP', 'CN'] }),
    null,
  )

  // Rocket League (252950): retirado de Steam hace anos, solo queda el escaparate
  // chino, que es otra tienda. Para quien compra desde aqui, ya no se vende.
  assert.equal(
    clasificar({ retirado: false, visibleEn: ['ES', 'US', 'JP'], comprableEn: ['CN'] }),
    'no_comprable',
  )

  // bloqueo regional de verdad: a la venta en mercados normales, aqui no
  assert.equal(
    clasificar({ retirado: false, visibleEn: ['US', 'JP'], comprableEn: ['US', 'JP'] }),
    'bloqueo_regional',
  )
  assert.equal(clasificar({ retirado: true, visibleEn: [], comprableEn: [] }), 'retirado')
})

test('feed: un preaviso cumplido se cae de la ventana', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feed-'))
  const aviso = crearEvento({
    tipo: 'retirada_anunciada', appid: 777, nombre: 'X', fuente: 'remgc',
    detectado: '2026-08-20T10:00:00.000Z', confianza: 'confirmado',
  })
  await publicar([aviso], dir)
  assert.equal(JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8')).length, 1)

  const cumplido = crearEvento({
    tipo: 'no_comprable', appid: 777, nombre: 'X', fuente: 'seguimiento',
    detectado: '2026-08-24T10:00:00.000Z', confianza: 'confirmado',
  })
  await publicar([cumplido], dir)

  const latest = JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8'))
  assert.deepEqual(latest.map((e) => e.tipo), ['no_comprable'])
})

test('feed: la ventana se depura aunque el ciclo no traiga nada nuevo', async () => {
  // FOX XII: el barrido nocturno lo dio por no comprable a las 04:41 y el aviso de
  // "lo van a retirar, 0,99 €" seguia ahi veinte horas despues, porque la ventana
  // solo se rehacia cuando llegaban eventos nuevos.
  const dir = await mkdtemp(join(tmpdir(), 'feed-'))
  const base = [
    crearEvento({ tipo: 'retirada_anunciada', appid: 3791390, nombre: 'FOX XII', fuente: 'remgc', detectado: '2026-08-19T18:46:00.000Z', confianza: 'confirmado' }),
    crearEvento({ tipo: 'no_comprable', appid: 3791390, nombre: 'FOX XII', fuente: 'sweep', detectado: '2026-08-24T04:41:00.000Z', confianza: 'confirmado' }),
  ]
  await writeFile(join(dir, 'latest.json'), JSON.stringify(base))

  const r = await publicar([], dir)
  assert.equal(r.nuevos, 0)
  const latest = JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8'))
  assert.deepEqual(latest.map((e) => e.tipo), ['no_comprable'])
})
