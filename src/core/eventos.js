// Construccion de eventos: la unidad que viaja al feed y a la notificacion.

import { createHash } from 'node:crypto';

export const TIPOS = /** @type {const} */ ([
  'retirado',
  'retirada_anunciada',
  'gratis_activo',
  'gratis_proximo',
  'finde_gratis',
  // Hubo un tipo `revivido` ("ha vuelto a Steam") y se retiro del sistema: en nueve
  // dias dio 433 eventos y NINGUNO era un regreso. Todos eran juegos sin estrenar que
  // acababan de publicar ficha, marcados antes como retirados por el fallo de
  // `comprable`. La informacion no compensaba el ruido.
  // no comprable desde Espana pero vivo en otros mercados: va al feed, nunca a push
  'bloqueo_regional',
  // pagina de tienda viva pero sin ninguna forma de comprarlo (le retiraron el
  // ultimo paquete). En la practica es una retirada, aunque `visible` siga en true.
  'no_comprable',
]);

/** Tipos que jamas generan notificacion, solo entrada en el feed. */
export const SOLO_FEED = new Set(['bloqueo_regional']);

/**
 * Enlaces de accion de un evento.
 *
 * El de Allkeyshop se construye con el NOMBRE, no con el appid: la URL canonica es
 * products/?search_name=<nombre>, a la que redirige catalogue/search-<nombre>/.
 * En una retirada es el enlace mas util, porque Steam ya no te lo vende.
 */
export function enlacesDe(appid, nombre, anuncio = null) {
  const enlaces = {
    steam: `https://store.steampowered.com/app/${appid}/`,
    steamdb: `https://steamdb.info/app/${appid}/`,
  };
  if (nombre) {
    enlaces.allkeyshop = `https://www.allkeyshop.com/blog/products/?search_name=${encodeURIComponent(nombre)}`;
  }
  if (anuncio) enlaces.anuncio = anuncio;
  return enlaces;
}

/**
 * @param {{tipo:string, appid:number, nombre?:string, app_type?:string,
 *          fuente:string, vence?:string|null, anuncio?:string|null,
 *          confianza?:'provisional'|'confirmado', detectado?:string}} datos
 */
export function crearEvento(datos) {
  if (!TIPOS.includes(datos.tipo)) throw new Error(`tipo de evento desconocido: ${datos.tipo}`);

  const detectado = datos.detectado ?? new Date().toISOString();
  // El id agrupa por tipo+appid+dia: si el mismo hecho se redetecta en el mismo dia
  // (p. ej. PICS y luego el barrido), no genera dos entradas en el feed.
  const id = createHash('sha1')
    .update(`${datos.tipo}|${datos.appid}|${detectado.slice(0, 10)}`)
    .digest('hex')
    .slice(0, 16);

  return {
    id,
    tipo: datos.tipo,
    appid: Number(datos.appid),
    nombre: datos.nombre ?? '',
    app_type: datos.app_type ?? 'otro',
    detectado,
    fuente: datos.fuente,
    // ultimo precio conocido antes de desaparecer; Steam ya no lo da una vez retirado
    precio: datos.precio ?? null,
    // texto libre: en que paises sigue vendiendose, o el extracto del aviso del estudio
    detalle: datos.detalle ?? null,
    // nota estilo SteamDB y el porcentaje crudo del que sale, capturados antes de que
    // la ficha desaparezca; null si el juego no tiene resenas
    nota: datos.nota ?? null,
    resenas: datos.resenas || 0,
    // dias estimados desde el ultimo cambio de la app en PICS: distingue una retirada
    // de esta semana de un hallazgo de hace medio ano
    antiguedad_dias: datos.antiguedad_dias ?? null,
    vence: datos.vence ?? null,
    enlaces: enlacesDe(datos.appid, datos.nombre, datos.anuncio),
    confianza: datos.confianza ?? 'provisional',
  };
}

/** Quita eventos repetidos conservando el de mayor confianza. */
export function deduplicar(eventos) {
  const porId = new Map();
  for (const ev of eventos) {
    const previo = porId.get(ev.id);
    if (!previo || (previo.confianza === 'provisional' && ev.confianza === 'confirmado')) {
      porId.set(ev.id, ev);
    }
  }
  return [...porId.values()];
}

/**
 * Prioridad de notificacion. Con cobertura de todo Steam (DLC, musica, demos...) el
 * volumen diario es alto, asi que solo lo urgente interrumpe; el resto va a resumen.
 */
export function esUrgente(ev) {
  if (SOLO_FEED.has(ev.tipo)) return false;
  // Cerrar un preaviso no es noticia: del aviso ya se entero en su momento, y lo que
  // se hace aqui es mover la ficha al grupo que le toca. Interrumpir con ello seria
  // avisar dos veces de lo mismo, la segunda cuando ya no se puede hacer nada.
  if (ev.fuente === 'seguimiento') return false;
  if (ev.tipo === 'gratis_activo' || ev.tipo === 'gratis_proximo') return true;
  // el preaviso es lo que permite comprarlo a tiempo: siempre interrumpe
  if (ev.tipo === 'retirada_anunciada') return true;
  if (ev.tipo === 'retirado' && ev.app_type === 'game') return true;
  // para el usuario "no se puede comprar" equivale a retirado
  if (ev.tipo === 'no_comprable' && ev.app_type === 'game') return true;
  return false;
}

/**
 * Topic de FCM al que se publica el evento.
 *
 * Retirado y no-comprable se parten por tipo de contenido: son los dos que generan
 * volumen, y quien no quiere enterarse de cada DLC o banda sonora tiene que poder
 * cortarlos en ORIGEN. Antes `no_comprable` era un topic plano al que la app ni
 * siquiera se suscribia, asi que no habia forma de regularlo.
 */
export const topicDe = (ev) =>
  ev.tipo === 'retirado' || ev.tipo === 'no_comprable' ? `${ev.tipo}_${ev.app_type}` : ev.tipo;
