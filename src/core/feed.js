// Escritura del feed que consume la app: JSON estatico servido por GitHub Pages.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const DIR_FEED = process.env.DIR_FEED ?? 'data/feed';
const MAX_LATEST = 500;

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
    const latest = [...nuevos, ...previos]
      .sort((a, b) => b.detectado.localeCompare(a.detectado))
      .slice(0, MAX_LATEST);
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
