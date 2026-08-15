// Estado persistente. En local vive en .data/; en CI se descarga y se sube como
// asset de una Release fija, para no versionar 3 MB cada 15 minutos en el repo.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname } from 'node:path';

export const RUTA_ESTADO = process.env.RUTA_ESTADO ?? '.data/state.json.gz';

/** Estado vacio con la forma esperada por el resto del codigo. */
export function estadoVacio() {
  return {
    version: 1,
    cursor: { changenumber: null, ultimo_ciclo: null, ventana_perdida: false },
    // appid -> [visible(0|1), nombre, tipo]  (array para que 200k entradas no pesen tanto)
    apps: {},
    // packageid -> promo persistida con sus fechas y banderas de aviso
    promos: {},
    // appids que la busqueda de la tienda daba como gratis en el ciclo anterior
    gratis_ahora: [],
    // comentarios ya procesados del hilo RemGC (los ids NO son crecientes)
    remgc: { vistos: [], total: null },
    // articulos ya procesados de delistedgames.com
    delisted: { vistos: [] },
    // recorrido rotatorio del catalogo buscando avisos de los desarrolladores
    anuncios: { cursor: 0, avisados: [] },
    // retiradas con fecha conocida: appid -> {fecha, nombre, precio, avisado, ultima_llamada}
    // permite avisar otra vez cuando el plazo esta a punto de cumplirse
    previstas: {},
    // deteccion provisional pendiente de confirmar: appid -> {tipo, visto}
    pendientes: {},
    // apps que NOSOTROS vimos retirar: appid -> fecha.
    // Sin esto, "ha vuelto" se dispara con cualquier app que pase a visible, incluidos
    // los juegos que estrenan pagina de tienda y nunca estuvieron retirados.
    retirados: {},
  };
}

export async function cargarEstado(ruta = RUTA_ESTADO) {
  try {
    const crudo = await readFile(ruta);
    const json = ruta.endsWith('.gz') ? gunzipSync(crudo).toString('utf8') : crudo.toString('utf8');
    return { ...estadoVacio(), ...JSON.parse(json) };
  } catch (e) {
    if (e.code === 'ENOENT') return estadoVacio();
    throw e;
  }
}

export async function guardarEstado(estado, ruta = RUTA_ESTADO) {
  await mkdir(dirname(ruta), { recursive: true });
  const json = JSON.stringify(estado);
  await writeFile(ruta, ruta.endsWith('.gz') ? gzipSync(json, { level: 9 }) : json);
  return json.length;
}

// --- acceso comodo a la tabla de apps -----------------------------------------

// fila = [visible, nombre, tipo, precio]
// El precio se guarda porque una vez retirado el juego Steam ya no lo devuelve por
// ninguna via: si no se captura antes, la alerta no puede decir cuanto costaba.
export const leerApp = (estado, appid) => {
  const fila = estado.apps[appid];
  return fila ? { visible: fila[0] === 1, nombre: fila[1], tipo: fila[2], precio: fila[3] ?? null } : null;
};

export const escribirApp = (estado, appid, { visible, nombre, tipo, precio }) => {
  const previo = estado.apps[appid];
  estado.apps[appid] = [
    visible ? 1 : 0,
    nombre ?? '',
    tipo ?? 'otro',
    // si ya no es visible no habra precio nuevo: conservamos el ultimo conocido
    precio ?? previo?.[3] ?? null,
  ];
};

export const contarVisibles = (estado) =>
  Object.values(estado.apps).reduce((n, f) => n + (f[0] === 1 ? 1 : 0), 0);
