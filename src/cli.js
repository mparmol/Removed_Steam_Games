#!/usr/bin/env node
// Punto de entrada. Comandos: watch | sweep | bootstrap | estado

import { cargarEstado, guardarEstado, contarVisibles, escribirApp, leerApp } from './core/estado.js';
import { ejecutarCiclo } from './core/ciclo.js';
import { publicar } from './core/feed.js';
import { crearEvento, deduplicar, esUrgente } from './core/eventos.js';
import { consultarMuchos, LOTE_MAX } from './steam/store.js';
import { Limitador } from './lib/http.js';

const args = process.argv.slice(2);
const comando = args[0];
const bandera = (n) => args.includes(`--${n}`);
const valor = (n, pordefecto) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : pordefecto;
};

const seco = bandera('dry-run');

// --- watch ---------------------------------------------------------------------

async function watch() {
  console.log(`== ciclo de vigilancia ==${seco ? '  [DRY RUN: no se escribe nada]' : ''}`);
  const estado = await cargarEstado();
  console.log(`  estado: ${Object.keys(estado.apps).length} apps conocidas (${contarVisibles(estado)} visibles)`);

  const { eventos, resumen } = await ejecutarCiclo(estado);

  console.log(`\n== ${eventos.length} eventos ==`);
  for (const ev of eventos) {
    console.log(`  [${ev.confianza === 'confirmado' ? 'OK ' : '...'}] ${ev.tipo.padEnd(18)} ${String(ev.appid).padStart(8)} ${(ev.nombre || '(sin nombre)').slice(0, 40).padEnd(42)} ${esUrgente(ev) ? 'URGENTE' : 'resumen'}`);
    if (ev.enlaces.allkeyshop) console.log(`        ${ev.enlaces.allkeyshop}`);
  }

  if (seco) {
    console.log('\n(dry run: no se guarda estado ni feed)');
    return;
  }

  const notificables = eventos.filter((e) => e.confianza === 'confirmado');
  const pub = await publicar(notificables);
  const bytes = await guardarEstado(estado);
  console.log(`\nfeed: ${pub.nuevos} nuevos, ${pub.ignorados} ya conocidos`);
  console.log(`estado guardado: ${(bytes / 1024 / 1024).toFixed(2)} MB sin comprimir`);
  if (resumen.pics?.ventanaPerdida) console.log('AVISO: ventana de PICS perdida -> conviene lanzar sweep');
}

// --- sweep / bootstrap ----------------------------------------------------------

/** Reparte un rango entre shards para paralelizar en varias IPs. */
function trocear(lista, shard, deTotal) {
  return lista.filter((_, i) => i % deTotal === shard);
}

async function sweep() {
  const shard = Number(valor('shard', 0));
  const deTotal = Number(valor('of', 1));
  const estado = await cargarEstado();
  const conocidas = Object.keys(estado.apps).map(Number);
  const mias = trocear(conocidas, shard, deTotal);

  console.log(`== barrido shard ${shard}/${deTotal}: ${mias.length} apps de ${conocidas.length} ==`);
  const limitador = new Limitador(100);
  const eventos = [];

  const vistos = await consultarMuchos(mias, limitador, (h, t) => {
    if (h % 5000 === 0 || h === t) console.log(`  ${h}/${t}`);
  });

  for (const [appid, ahora] of vistos) {
    const antes = leerApp(estado, appid);
    if (antes && antes.visible !== ahora.visible) {
      eventos.push(crearEvento({
        tipo: ahora.visible ? 'revivido' : 'retirado',
        appid,
        nombre: ahora.nombre || antes.nombre,
        app_type: ahora.tipo !== 'otro' ? ahora.tipo : antes.tipo,
        fuente: 'sweep',
        // el barrido ES la segunda mirada: lo que encuentra va confirmado
        confianza: 'confirmado',
      }));
    }
    escribirApp(estado, appid, { visible: ahora.visible, nombre: ahora.nombre || antes?.nombre || '', tipo: ahora.tipo !== 'otro' ? ahora.tipo : antes?.tipo });
  }

  console.log(`\n${eventos.length} cambios detectados`);
  for (const ev of eventos) console.log(`  ${ev.tipo.padEnd(10)} ${ev.appid} ${ev.nombre}`);

  if (!seco) {
    await publicar(deduplicar(eventos));
    await guardarEstado(estado);
  }
}

async function bootstrap() {
  const shard = Number(valor('shard', 0));
  const deTotal = Number(valor('of', 1));
  const hasta = Number(valor('hasta', 5200000));

  // Solo ~4% del espacio de appids esta visible (933 de 23.400 sondeados en el spike),
  // asi que el catalogo real ronda las 200.000 apps.
  const todos = [];
  for (let a = 1; a <= hasta; a++) if (a % deTotal === shard) todos.push(a);

  console.log(`== bootstrap shard ${shard}/${deTotal}: ${todos.length} appids a sondear ==`);
  const limitador = new Limitador(100);
  const estado = await cargarEstado();
  let visibles = 0;

  await consultarMuchos(todos, limitador, (h, t) => {
    if (h % 20000 === 0 || h === t) console.log(`  ${h}/${t} (${((h / t) * 100).toFixed(1)}%)`);
  }).then((vistos) => {
    for (const [appid, dato] of vistos) {
      if (!dato.visible) continue; // no guardamos los 96% que no existen
      visibles++;
      escribirApp(estado, appid, dato);
    }
  });

  console.log(`\n${visibles} apps visibles encontradas`);
  if (!seco) await guardarEstado(estado);
}

async function mostrarEstado() {
  const estado = await cargarEstado();
  console.log(JSON.stringify({
    apps: Object.keys(estado.apps).length,
    visibles: contarVisibles(estado),
    cursor: estado.cursor,
    promos: Object.keys(estado.promos).length,
    pendientes: Object.keys(estado.pendientes).length,
    gratis_ahora: estado.gratis_ahora,
    remgc: estado.remgc,
  }, null, 2));
}

const comandos = { watch, sweep, bootstrap, estado: mostrarEstado };

if (!comandos[comando]) {
  console.error('uso: node src/cli.js <watch|sweep|bootstrap|estado> [--dry-run] [--shard N --of M]');
  process.exit(1);
}

comandos[comando]().then(
  () => process.exit(0),
  (e) => { console.error('ERROR:', e.stack ?? e.message); process.exit(1); },
);
