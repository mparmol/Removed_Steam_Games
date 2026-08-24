// Escritura del feed que consume la app: JSON estatico servido por GitHub Pages.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const DIR_FEED = process.env.DIR_FEED ?? 'data/feed';
const MAX_LATEST = 1500;
/** Plazas reservadas a preavisos y juegos gratis, que no puede robar el ruido masivo. */
const CUOTA_AVISOS = 600;

const leerJson = async (ruta, pordefecto) => {
  try {
    return JSON.parse(await readFile(ruta, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return pordefecto;
    throw e;
  }
};

/**
 * Anade eventos al feed: `latest.json` (ventana corta que lee la app), el archivo
 * mensual NDJSON y el manifiesto.
 */
export async function publicar(eventos, dir = DIR_FEED) {
  await mkdir(dir, { recursive: true });

  const rutaLatest = join(dir, 'latest.json');
  const previos = await leerJson(rutaLatest, []);

  const conocidos = new Set(previos.map((e) => e.id));
  const nuevos = eventos.filter((e) => !conocidos.has(e.id));

  if (nuevos.length > 0) {
    // Los avisos PREVIOS a la retirada son lo que da valor a la app, y el barrido
    // genera miles de eventos de arrastre que los expulsaban de la ventana: llego a
    // haber 469 no_comprable y un solo retirada_anunciada. Se les reserva cuota.
    const todos = [...nuevos, ...previos].sort((a, b) => b.detectado.localeCompare(a.detectado));
    const esAviso = (e) => e.tipo === 'retirada_anunciada' || e.tipo === 'gratis_activo' || e.tipo === 'gratis_proximo';

    const avisos = todos.filter(esAviso).slice(0, CUOTA_AVISOS);
    const resto = todos.filter((e) => !esAviso(e)).slice(0, MAX_LATEST - avisos.length);
    const latest = [...avisos, ...resto].sort((a, b) => b.detectado.localeCompare(a.detectado));

    await writeFile(rutaLatest, JSON.stringify(latest, null, 0));

    // archivo mensual, agrupando por el mes del evento
    const porMes = new Map();
    for (const ev of nuevos) {
      const mes = ev.detectado.slice(0, 7);
      if (!porMes.has(mes)) porMes.set(mes, []);
      porMes.get(mes).push(ev);
    }
    for (const [mes, lote] of porMes) {
      const ruta = join(dir, `${mes}.ndjson`);
      const linea = lote.map((e) => JSON.stringify(e)).join('\n') + '\n';
      await writeFile(ruta, linea, { flag: 'a' });
    }
  }

  const manifiesto = {
    actualizado: new Date().toISOString(),
    eventos_totales: (await leerJson(rutaLatest, [])).length,
    nuevos_este_ciclo: nuevos.length,
  };
  await writeFile(join(dir, 'index.json'), JSON.stringify(manifiesto, null, 2));

  return { nuevos: nuevos.length, ignorados: eventos.length - nuevos.length };
}
