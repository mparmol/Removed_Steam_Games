// Consultas a la tienda de Steam.
//
// IStoreBrowseService/GetItems es el endpoint bueno: no pide API key, acepta lotes
// y devuelve un campo `visible` explicito. Validado en el spike contra 7 casos con
// 100% de acierto (225140, 226320 y 386660 retirados; 620 y 570 vivos).
//
// OJO con endpoints muertos: ISteamApps/GetAppList da 404 en todas sus versiones e
// IStoreService/GetAppList exige API key (403). No hay enumeracion gratis del catalogo.

import { pedir, Limitador } from '../lib/http.js';

// 200 appids por peticion es el maximo: a 500 la URL supera el limite del servidor (400).
export const LOTE_MAX = 200;

const GETITEMS = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/';

/** Tipos de app tal y como los devuelve la tienda, normalizados a nuestro vocabulario. */
const TIPOS = { game: 'game', dlc: 'dlc', music: 'music', demo: 'demo', video: 'video', application: 'application' };

export function normalizarTipo(t) {
  if (typeof t === 'string') return TIPOS[t.toLowerCase()] ?? 'otro';
  // GetItems devuelve tambien un enum numerico en algunos casos
  return { 0: 'game', 4: 'dlc', 10: 'music', 13: 'video', 14: 'demo', 2: 'application' }[t] ?? 'otro';
}

/**
 * Consulta el estado de un lote de appids.
 * @returns {Promise<Map<number, {appid:number, visible:boolean, nombre:string, tipo:string, gratis:boolean}>>}
 */
export async function consultarLote(appids, limitador) {
  if (appids.length === 0) return new Map();
  if (appids.length > LOTE_MAX) throw new Error(`lote de ${appids.length} supera el maximo de ${LOTE_MAX}`);

  const entrada = {
    ids: appids.map((appid) => ({ appid: Number(appid) })),
    context: { language: 'spanish', country_code: 'ES', steam_realm: 1 },
    data_request: { include_basic_info: true, include_release: true },
  };
  const url = `${GETITEMS}?input_json=${encodeURIComponent(JSON.stringify(entrada))}`;
  const res = await pedir(url, { limitador });

  const salida = new Map();
  for (const item of res?.response?.store_items ?? []) {
    const appid = Number(item.appid ?? item.id);
    if (!appid) continue;
    salida.set(appid, {
      appid,
      // `visible: false` cubre tanto "retirado" como "nunca existio". No los distingue,
      // y da igual: lo que detectamos es la TRANSICION visible -> no visible.
      visible: item.visible === true,
      nombre: item.name ?? '',
      tipo: normalizarTipo(item.type),
      gratis: item.is_free === true,
    });
  }
  return salida;
}

/**
 * Consulta muchos appids troceando en lotes. Devuelve un Map unico.
 * @param {number[]} appids
 * @param {Limitador} limitador
 * @param {(hechos:number, total:number)=>void} [alAvanzar]
 */
export async function consultarMuchos(appids, limitador, alAvanzar) {
  const salida = new Map();
  for (let i = 0; i < appids.length; i += LOTE_MAX) {
    const lote = appids.slice(i, i + LOTE_MAX);
    const res = await consultarLote(lote, limitador);
    for (const [k, v] of res) salida.set(k, v);
    alAvanzar?.(Math.min(i + LOTE_MAX, appids.length), appids.length);
  }
  return salida;
}

/**
 * Juegos gratis AHORA MISMO, segun la busqueda de la tienda.
 *
 * Esta es la fuente de verdad de `gratis_activo`, no PICS: se comprobo con Deponia
 * (214340) que una promo viva puede no aparecer en la ventana de PICS, porque el
 * paquete cambia cuando la promo se CONFIGURA, no cuando empieza.
 *
 * Hay que parsear el HTML: el mismo endpoint con &json=1 devuelve solo nombres,
 * sin appids (da "Deponia" pero no 214340).
 */
export async function gratisAhora(limitador) {
  const url = 'https://store.steampowered.com/search/?hwtype=0&maxprice=free&category1=998&specials=1&ndl=1&cc=es';
  const html = await pedir(url, { limitador, comoTexto: true });
  const appids = [...new Set([...html.matchAll(/data-ds-appid="(\d+)"/g)].map((m) => Number(m[1])))];
  return { appids, bytes: html.length };
}
