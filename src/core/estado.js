// Estado persistente. En local vive en .data/; en CI se descarga y se sube como
// asset de una Release fija, para no versionar 3 MB cada 15 minutos en el repo.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname } from 'node:path';
import { notaSteamDb } from '../steam/store.js';

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
    // packageid -> appids que incluye, mientras el paquete siga a la venta.
    // Un paquete ya retirado no devuelve sus appids, asi que el mapa hay que tenerlo
    // guardado de antes para saber a que juego afecta la retirada.
    paquetes: {},
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
    // appid -> fecha del ultimo preaviso emitido, sea cual sea la fuente.
    // El hilo de RemGC repite el mismo juego en varios mensajes y ademas se editan
    // mensajes viejos para anadir juegos; sin este registro compartido, releer el hilo
    // para pillar las ediciones repetiria avisos ya dados.
    avisados: {},
    // preavisos abiertos: appid -> {desde, nombre, precio}. Se revisan cada ciclo
    // para poder pasarlos a "ya no se vende" cuando el aviso se cumple; PICS no
    // vuelve a mencionar una app una vez retirada, asi que hay que preguntar aparte.
    vigilando: {},
    // apps que NOSOTROS vimos retirar: appid -> fecha. Es un registro historico:
    // sirve para no volver a dar por nuevo algo ya retirado cuando una fuente humana
    // lo menciona tarde.
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

// fila = [visible, nombre, tipo, precio, comprable, porcentaje, resenas]
// El precio se guarda porque una vez retirado el juego Steam ya no lo devuelve por
// ninguna via: si no se captura antes, la alerta no puede decir cuanto costaba. Con
// las resenas pasa lo mismo: la ficha desaparece y GetItems devuelve el item vacio.
// `comprable` distingue "pagina viva pero sin forma de comprarlo" de "a la venta".
export const leerApp = (estado, appid) => {
  const fila = estado.apps[appid];
  if (!fila) return null;
  return {
    visible: fila[0] === 1,
    nombre: fila[1],
    tipo: fila[2],
    precio: fila[3] ?? null,
    // las filas viejas no traen el campo: se asume comprable si estaba visible
    comprable: fila[4] == null ? fila[0] === 1 : fila[4] === 1,
    // Si nunca se midio, no hay transicion que detectar: la primera vez solo se
    // anota. Sin esto, el primer barrido tras anadir el campo saco 500 avisos de
    // golpe de apps que ya llevaban tiempo sin poder comprarse.
    comprableConocido: fila[4] != null,
    porcentaje: fila[5] ?? null,
    resenas: fila[6] ?? 0,
    nota: fila[5] == null ? null : notaSteamDb(fila[5], fila[6] ?? 0),
  };
};

export const escribirApp = (estado, appid, { visible, nombre, tipo, precio, comprable, porcentaje, resenas }) => {
  const previo = estado.apps[appid];
  estado.apps[appid] = [
    visible ? 1 : 0,
    nombre ?? '',
    tipo ?? 'otro',
    // si ya no es visible no habra precio nuevo: conservamos el ultimo conocido
    precio ?? previo?.[3] ?? null,
    // Omitir `comprable` conserva lo ultimo MEDIDO. Antes caia a `visible`, y eso
    // reescribia el valor real en cada barrido: al dia siguiente volvia a "cambiar"
    // y se reemitia el aviso. Suponer nada es mejor que suponer mal.
    (comprable ?? (previo ? previo[4] === 1 : visible)) ? 1 : 0,
    // igual que el precio: si no viene dato nuevo se conserva el ultimo conocido
    porcentaje ?? previo?.[5] ?? null,
    resenas || previo?.[6] || 0,
  ];
};

export const contarVisibles = (estado) =>
  Object.values(estado.apps).reduce((n, f) => n + (f[0] === 1 ? 1 : 0), 0);
