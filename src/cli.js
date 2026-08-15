#!/usr/bin/env node
// Punto de entrada.
//
//   watch      ciclo de vigilancia completo (PICS + tienda + RemGC)
//   bootstrap  sondea un trozo del espacio de appids y escribe lo visible
//   sweep      revisa un trozo del catalogo conocido y escribe lo observado
//   fusionar   junta la salida de los shards, emite eventos y actualiza estado
//   estado     resumen de lo que hay guardado
//
// Los comandos por shard NO tocan el estado global: escriben un fichero parcial
// que `fusionar` combina despues. Es lo que permite repartir el barrido entre
// varios runners, cada uno con su IP y por tanto con su propio cupo de Steam.

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { cargarEstado, guardarEstado, contarVisibles, escribirApp, leerApp, RUTA_ESTADO } from './core/estado.js';
import { ejecutarCiclo } from './core/ciclo.js';
import { publicar } from './core/feed.js';
import { crearEvento, deduplicar, esUrgente } from './core/eventos.js';
import { consultarMuchos } from './steam/store.js';
import { Limitador } from './lib/http.js';
import { descargarEstado, subirEstado } from './lib/release.js';

const args = process.argv.slice(2);
const comando = args[0];
const bandera = (n) => args.includes(`--${n}`);
const valor = (n, pordefecto) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : pordefecto;
};

const seco = bandera('dry-run');
const remoto = bandera('remoto');

const shard = Number(valor('shard', 0));
const deTotal = Number(valor('of', 1));

/** Reparte por resto de la division: cada shard coge 1 de cada M elementos. */
const meToca = (n) => n % deTotal === shard;

async function traerEstado() {
  if (remoto) {
    const habia = await descargarEstado(RUTA_ESTADO);
    console.log(habia ? '  estado descargado de la Release' : '  no hay estado publicado todavia: empezamos de cero');
  }
  return await cargarEstado();
}

async function dejarEstado(estado) {
  const bytes = await guardarEstado(estado);
  if (remoto) {
    const subidos = await subirEstado(RUTA_ESTADO);
    console.log(`  estado subido a la Release: ${(subidos / 1024 / 1024).toFixed(2)} MB comprimidos`);
  }
  return bytes;
}

// --- watch ----------------------------------------------------------------------

async function watch() {
  console.log(`== ciclo de vigilancia ==${seco ? '  [DRY RUN]' : ''}`);
  const estado = await traerEstado();
  console.log(`  estado: ${Object.keys(estado.apps).length} apps conocidas (${contarVisibles(estado)} visibles)`);

  const { eventos, resumen } = await ejecutarCiclo(estado);

  console.log(`\n== ${eventos.length} eventos ==`);
  for (const ev of eventos) {
    console.log(`  [${ev.confianza === 'confirmado' ? 'OK ' : '...'}] ${ev.tipo.padEnd(18)} ${String(ev.appid).padStart(8)} ${(ev.nombre || '(sin nombre)').slice(0, 40).padEnd(42)} ${esUrgente(ev) ? 'URGENTE' : 'resumen'}`);
  }

  if (seco) return console.log('\n(dry run: no se guarda estado ni feed)');

  const confirmados = eventos.filter((e) => e.confianza === 'confirmado');
  const pub = await publicar(confirmados);
  await dejarEstado(estado);
  console.log(`\nfeed: ${pub.nuevos} nuevos, ${pub.ignorados} ya conocidos`);

  // lo consume el workflow para decidir si dispara el barrido de emergencia
  await escribirSalidaAccion({ ventana_perdida: resumen.pics?.ventanaPerdida === true, eventos: confirmados.length });
  if (resumen.pics?.ventanaPerdida) console.log('AVISO: ventana de PICS perdida -> hace falta barrido');
}

// --- comandos por shard ----------------------------------------------------------

async function bootstrap() {
  const hasta = Number(valor('hasta', 5200000));
  const salida = valor('salida', `.data/shard-${shard}.json`);

  const objetivos = [];
  for (let a = 1; a <= hasta; a++) if (meToca(a)) objetivos.push(a);

  console.log(`== bootstrap shard ${shard}/${deTotal}: ${objetivos.length} appids a sondear ==`);
  const limitador = new Limitador(100);
  const encontradas = {};

  await consultarMuchos(objetivos, limitador, (h, t) => {
    if (h % 20000 === 0 || h === t) console.log(`  ${h}/${t} (${((h / t) * 100).toFixed(1)}%)  visibles hasta ahora: ${Object.keys(encontradas).length}`);
  }).then((vistos) => {
    // solo guardamos lo visible: ~96% del espacio de appids no existe
    for (const [appid, d] of vistos) if (d.visible) encontradas[appid] = [1, d.nombre, d.tipo];
  });

  console.log(`\n${Object.keys(encontradas).length} apps visibles encontradas`);
  await escribirParcial(salida, { modo: 'bootstrap', shard, apps: encontradas });
}

async function sweep() {
  const salida = valor('salida', `.data/shard-${shard}.json`);
  const estado = await traerEstado();

  const mias = Object.keys(estado.apps).map(Number).filter(meToca);
  console.log(`== barrido shard ${shard}/${deTotal}: ${mias.length} apps de ${Object.keys(estado.apps).length} ==`);

  const limitador = new Limitador(100);
  const observado = {};
  await consultarMuchos(mias, limitador, (h, t) => {
    if (h % 5000 === 0 || h === t) console.log(`  ${h}/${t}`);
  }).then((vistos) => {
    for (const [appid, d] of vistos) observado[appid] = [d.visible ? 1 : 0, d.nombre, d.tipo];
  });

  console.log(`\n${Object.keys(observado).length} apps observadas`);
  await escribirParcial(salida, { modo: 'sweep', shard, apps: observado });
}

async function escribirParcial(ruta, contenido) {
  await mkdir(join(ruta, '..'), { recursive: true });
  await writeFile(ruta, JSON.stringify(contenido));
  console.log(`  escrito ${ruta}`);
}

// --- fusionar --------------------------------------------------------------------

async function fusionar() {
  const dir = valor('entradas', '.data/shards');
  const estado = await traerEstado();

  const ficheros = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('.json'));
  console.log(`== fusionando ${ficheros.length} ficheros de shard ==`);

  const eventos = [];
  let vistas = 0;

  for (const f of ficheros) {
    const parcial = JSON.parse(await readFile(join(dir, f), 'utf8'));
    for (const [appidStr, fila] of Object.entries(parcial.apps)) {
      const appid = Number(appidStr);
      const ahora = { visible: fila[0] === 1, nombre: fila[1], tipo: fila[2] };
      vistas++;

      const antes = leerApp(estado, appid);
      // Un cambio detectado por el barrido ya viene mirado dos veces (PICS lo vio o no,
      // y el barrido lo confirma), asi que sale confirmado directamente.
      if (antes && antes.visible !== ahora.visible) {
        eventos.push(crearEvento({
          tipo: ahora.visible ? 'revivido' : 'retirado',
          appid,
          nombre: ahora.nombre || antes.nombre,
          app_type: ahora.tipo !== 'otro' ? ahora.tipo : antes.tipo,
          fuente: parcial.modo === 'bootstrap' ? 'bootstrap' : 'sweep',
          confianza: 'confirmado',
        }));
      }
      escribirApp(estado, appid, {
        visible: ahora.visible,
        nombre: ahora.nombre || antes?.nombre || '',
        tipo: ahora.tipo !== 'otro' ? ahora.tipo : antes?.tipo,
      });
    }
  }

  const unicos = deduplicar(eventos);
  console.log(`  ${vistas} observaciones -> ${unicos.length} cambios`);
  for (const ev of unicos.slice(0, 50)) console.log(`   ${ev.tipo.padEnd(10)} ${String(ev.appid).padStart(8)} ${ev.nombre}`);
  if (unicos.length > 50) console.log(`   ... y ${unicos.length - 50} mas`);

  console.log(`  catalogo: ${Object.keys(estado.apps).length} apps (${contarVisibles(estado)} visibles)`);

  if (seco) return console.log('\n(dry run: no se guarda nada)');

  // el barrido es la segunda mirada: lo pendiente que ya no cambia deja de estar pendiente
  estado.pendientes = {};
  estado.cursor.ventana_perdida = false;

  await publicar(unicos);
  await dejarEstado(estado);
  await escribirSalidaAccion({ eventos: unicos.length, apps: Object.keys(estado.apps).length });
}

// --- utilidades ------------------------------------------------------------------

/** Expone valores al workflow via $GITHUB_OUTPUT. */
async function escribirSalidaAccion(pares) {
  const destino = process.env.GITHUB_OUTPUT;
  if (!destino) return;
  const lineas = Object.entries(pares).map(([k, v]) => `${k}=${v}`).join('\n');
  await writeFile(destino, lineas + '\n', { flag: 'a' });
}

async function mostrarEstado() {
  const estado = await traerEstado();
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

const comandos = { watch, sweep, bootstrap, fusionar, estado: mostrarEstado };

if (!comandos[comando]) {
  console.error('uso: node src/cli.js <watch|sweep|bootstrap|fusionar|estado> [--dry-run] [--remoto] [--shard N --of M] [--salida f] [--entradas dir]');
  process.exit(1);
}

comandos[comando]().then(
  () => process.exit(0),
  (e) => { console.error('ERROR:', e.stack ?? e.message); process.exit(1); },
);
