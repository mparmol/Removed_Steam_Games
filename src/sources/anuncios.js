// Avisos de retirada en los anuncios de los propios desarrolladores.
//
// Es la fuente de mas valor: cuando un estudio dice "lo retiramos el dia X", ese
// aviso llega DIAS antes de que el juego desaparezca. El problema es que no existe
// ningun feed global de anuncios de Steam: el calendario de eventos sin sesion solo
// devuelve una seleccion destacada (14 eventos en 12 h, imposible para 300k apps) y
// el feed de noticias de la tienda es solo el blog de Valve. Asi que hay que
// preguntar app por app, y por tanto elegir bien a que apps se pregunta.

import { pedir } from '../lib/http.js';

/**
 * Patrones de retirada DE LA TIENDA.
 *
 * Un patron laxo con "removed" da falsos positivos constantes: las notas de parche
 * estan llenas de "we removed unwanted stains" o "wind-path sections will be removed".
 * Por eso se exige que el verbo aparezca junto a algo de tienda/venta.
 */
const PATRONES = [
  /\b(remov\w+|delist\w+|pull\w+|taken?\s+down)\b[^.!?]{0,60}\b(from\s+(the\s+)?(steam\s+)?(store|storefront)|from\s+sale|from\s+steam|off\s+steam)\b/i,
  /\b(no longer|won'?t\s+be)\b[^.!?]{0,40}\b(available\s+(for\s+(purchase|sale)|on\s+steam)|purchasable|for\s+sale)\b/i,
  /\blast\s+chance\s+to\s+(buy|purchase|grab|get|own)\b/i,
  /\b(will\s+be|going\s+to\s+be|being)\s+(removed|delisted|pulled)\b/i,
  /\b(sales?|store\s+page)\s+will\s+(end|close|be\s+discontinued)\b/i,
  /\b(end\s+of\s+sales?|discontinu\w+\s+sales?)\b/i,
  // castellano, por si el estudio publica en varios idiomas
  /\b(ser[aá]\s+retirado|dejar[aá]\s+de\s+estar\s+disponible|[uú]ltima\s+oportunidad\s+para\s+comprar)\b/i,
];

/** Palabras que casi siempre indican que el texto habla del JUEGO, no de la tienda. */
const DESCARTES = /\b(removed\s+(the\s+)?(bug|stain|texture|item|weapon|map|level|sound|typo)|from\s+the\s+(game|build|map|level))\b/i;

export function analizarTexto(texto) {
  const limpio = String(texto)
    .replace(/\[\/?[a-z][^\]]*\]/gi, ' ') // BBCode
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  for (const p of PATRONES) {
    const m = limpio.match(p);
    if (!m) continue;
    const i = Math.max(0, m.index - 100);
    const contexto = limpio.slice(i, m.index + m[0].length + 140).trim();
    if (DESCARTES.test(contexto)) continue;
    return { coincide: true, extracto: contexto, patron: p.source.slice(0, 40) };
  }
  return { coincide: false };
}

/**
 * Ultimos anuncios de una app. Devuelve los que hablan de retirada de la tienda.
 * @param {number} appid
 */
export async function anunciosDe(appid, limitador, cuantos = 5) {
  const url = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appid}&count=${cuantos}&maxlength=1200`;
  const res = await pedir(url, { limitador });
  const items = res?.appnews?.newsitems ?? [];

  const avisos = [];
  for (const it of items) {
    // las noticias externas (prensa) no son avisos del desarrollador
    if (it.is_external_url) continue;
    const analisis = analizarTexto(`${it.title}. ${it.contents ?? ''}`);
    if (!analisis.coincide) continue;
    avisos.push({
      appid,
      titulo: it.title,
      url: it.url,
      fecha: new Date(Number(it.date) * 1000).toISOString(),
      extracto: analisis.extracto,
    });
  }
  return avisos;
}

/**
 * Elige a que apps preguntar en este ciclo.
 *
 * Presupuesto limitado (~100 peticiones por ventana de 5 min), asi que se prioriza:
 *   1. lo que alguna fuente humana acaba de senalar
 *   2. lo que acaba de cambiar en PICS (un estudio que prepara una retirada suele
 *      tocar el producto: precio, paquetes, metadatos)
 *   3. un recorrido rotatorio del resto del catalogo, para que nada quede sin mirar
 */
export function elegirObjetivos({ senaladas = [], cambiadas = [], catalogo = [], cursor = 0, presupuesto = 120 }) {
  const elegidas = [];
  const vistos = new Set();
  const anadir = (lista) => {
    for (const a of lista) {
      if (elegidas.length >= presupuesto) return;
      const n = Number(a);
      if (vistos.has(n)) continue;
      vistos.add(n);
      elegidas.push(n);
    }
  };

  anadir(senaladas);
  anadir(cambiadas);

  let nuevoCursor = cursor;
  if (elegidas.length < presupuesto && catalogo.length > 0) {
    const faltan = presupuesto - elegidas.length;
    for (let i = 0; i < faltan; i++) {
      anadir([catalogo[(cursor + i) % catalogo.length]]);
    }
    nuevoCursor = (cursor + faltan) % catalogo.length;
  }
  return { objetivos: elegidas, cursor: nuevoCursor };
}
