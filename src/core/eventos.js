// Construccion de eventos: la unidad que viaja al feed y a la notificacion.

import { createHash } from 'node:crypto';

export const TIPOS = /** @type {const} */ ([
  'retirado',
  'retirada_anunciada',
  'gratis_activo',
  'gratis_proximo',
  'finde_gratis',
  'revivido',
]);

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
  if (ev.tipo === 'gratis_activo' || ev.tipo === 'gratis_proximo') return true;
  if (ev.tipo === 'retirada_anunciada') return true;
  if (ev.tipo === 'retirado' && ev.app_type === 'game') return true;
  return false;
}

/** Topic de FCM al que se publica el evento. */
export const topicDe = (ev) =>
  ev.tipo === 'retirado' ? `retirado_${ev.app_type}` : ev.tipo;
