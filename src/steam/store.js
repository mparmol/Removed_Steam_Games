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

/**
 * Codigos numericos de `type` en GetItems, comprobados uno a uno contra el catalogo
 * (enumerando por filtro de tipo y mirando que devuelve cada uno).
 *
 * La tabla anterior estaba inventada y fallaba justo en demos (1) y musica (11), que
 * acababan como "otro": 30.756 apps mal etiquetadas y los filtros de la app inservibles
 * para el tipo de contenido que mas se retira.
 */
const CODIGOS = {
  0: 'game',
  1: 'demo',
  4: 'dlc',
  6: 'application',
  7: 'video',
  10: 'hardware',
  11: 'music',
};

export function normalizarTipo(t) {
  if (typeof t === 'string') return TIPOS[t.toLowerCase()] ?? 'otro';
  return CODIGOS[t] ?? 'otro';
}

/**
 * Paises con los que se confirma una retirada.
 *
 * Medido: consultando SOLO desde Espana, 4 de 7 candidatos a retirada resultaron
 * estar simplemente bloqueados por region (Earth:Revival y カラオケJOYSOUND visibles
 * en JP; Snowbreak y BSide visibles en CN). Un 57% de falsos positivos. La bandera
 * `visible` es relativa al pais, asi que una retirada solo es tal si no se ve en
 * NINGUNO de estos mercados.
 */
export const PAISES_CONFIRMACION = ['ES', 'US', 'JP', 'CN'];

/**
 * Consulta el estado de un lote de appids.
 * @returns {Promise<Map<number, {appid:number, visible:boolean, nombre:string, tipo:string, gratis:boolean, precio:string|null}>>}
 */
export async function consultarLote(appids, limitador, pais = 'ES') {
  if (appids.length === 0) return new Map();
  if (appids.length > LOTE_MAX) throw new Error(`lote de ${appids.length} supera el maximo de ${LOTE_MAX}`);

  const entrada = {
    ids: appids.map((appid) => ({ appid: Number(appid) })),
    context: { language: 'spanish', country_code: pais, steam_realm: 1 },
    // el precio se pide para poder guardarlo ANTES de que el juego desaparezca:
    // una vez retirado, Steam ya no lo devuelve por ninguna via
    data_request: { include_basic_info: true, include_release: true, include_all_purchase_options: true },
  };
  const url = `${GETITEMS}?input_json=${encodeURIComponent(JSON.stringify(entrada))}`;
  const res = await pedir(url, { limitador });

  const salida = new Map();
  for (const item of res?.response?.store_items ?? []) {
    const appid = Number(item.appid ?? item.id);
    if (!appid) continue;
    const compra = item.best_purchase_option ?? item.purchase_options?.[0] ?? null;
    const gratis = item.is_free === true;
    // Un juego sin lanzar esta visible y SIN opciones de compra, igual que uno al que
    // le han quitado el ultimo paquete. Hay 52.752 asi en la tienda, o sea que sin
    // esta distincion el detector de "ya no se vende" seria un generador de ruido.
    const lanzamiento = Number(item.release?.steam_release_date ?? 0);
    const lanzado = lanzamiento > 0 && lanzamiento * 1000 < Date.now();
    salida.set(appid, {
      appid,
      // `visible: false` cubre tanto "retirado" como "nunca existio". No los distingue,
      // y da igual: lo que detectamos es la TRANSICION visible -> no visible.
      visible: item.visible === true,
      nombre: item.name ?? '',
      tipo: normalizarTipo(item.type),
      gratis,
      precio: compra?.formatted_final_price ?? compra?.formatted_original_price ?? null,
      lanzado,
      // Si le retiran el ultimo paquete, la pagina sigue viva pero no hay forma de
      // comprarlo. Practicamente es una retirada, y mirar solo `visible` no lo ve.
      // Caso real: Anvillage (2026300) visible=true con 0 opciones de compra.
      // Solo cuenta en juegos ya lanzados, por lo dicho arriba.
      comprable: !lanzado || gratis || (item.purchase_options?.length ?? 0) > 0 || item.best_purchase_option != null,
    });
  }
  return salida;
}

/**
 * Confirma si unos appids estan retirados de VERDAD, mirandolos en varios mercados.
 * Solo se llama sobre candidatos, no sobre todo el catalogo, asi que el coste extra
 * es despreciable.
 *
 * @returns {Promise<Map<number, {retirado:boolean, visibleEn:string[]}>>}
 */
export async function confirmarRetirada(appids, limitador) {
  const visibleEn = new Map(appids.map((a) => [Number(a), []]));
  const comprableEn = new Map(appids.map((a) => [Number(a), []]));

  for (const pais of PAISES_CONFIRMACION) {
    for (let i = 0; i < appids.length; i += LOTE_MAX) {
      const res = await consultarLote(appids.slice(i, i + LOTE_MAX), limitador, pais);
      for (const [appid, dato] of res) {
        if (dato.visible) visibleEn.get(appid)?.push(pais);
        if (dato.comprable) comprableEn.get(appid)?.push(pais);
      }
    }
  }

  const salida = new Map();
  for (const [appid, paises] of visibleEn) {
    const compra = comprableEn.get(appid) ?? [];
    salida.set(appid, {
      retirado: paises.length === 0,
      visibleEn: paises,
      // visible en algun sitio pero sin forma de comprarlo en ninguno
      soloEscaparate: paises.length > 0 && compra.length === 0,
      comprableEn: compra,
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
 * Enumera el catalogo completo de la tienda.
 *
 * ISteamApps/GetAppList esta muerto (404) e IStoreService/GetAppList exige API key,
 * asi que durante un tiempo la unica salida parecia ser sondear por fuerza bruta los
 * 5,2M de appids posibles (~14 h). IStoreQueryService/Query lo resuelve sin key:
 * 1.000 ids por peticion sobre ~304.000 registros, o sea ~305 peticiones (~15 min).
 *
 * @param {(hechos:number, total:number)=>void} [alAvanzar]
 */
export async function enumerarCatalogo(limitador, alAvanzar) {
  const POR_PAGINA = 1000;

  // La consulta por defecto NO trae demos ni bandas sonoras, y solo parte del DLC:
  // medido, 304.484 por defecto frente a 35.597 demos, 10.924 music y 60.417 dlc por
  // separado. Con solo la consulta base el catalogo salia con 1 demo y 8 soundtracks,
  // y las retiradas de esos tipos eran invisibles para el sistema.
  const CONSULTAS = [
    ['base', undefined],
    ['demos', { type_filters: { include_demos: true } }],
    ['music', { type_filters: { include_music: true } }],
    ['dlc', { type_filters: { include_dlc: true } }],
    ['software', { type_filters: { include_software: true } }],
    ['games', { type_filters: { include_games: true } }],
    ['video', { type_filters: { include_video: true } }],
  ];

  const todos = new Set();

  for (const [nombre, filters] of CONSULTAS) {
    let total = Infinity;
    for (let inicio = 0; inicio < total; inicio += POR_PAGINA) {
      const entrada = {
        query: { start: inicio, count: POR_PAGINA, ...(filters ? { filters } : {}) },
        context: { language: 'english', country_code: 'ES', steam_realm: 1 },
      };
      const url = `https://api.steampowered.com/IStoreQueryService/Query/v1/?input_json=${encodeURIComponent(JSON.stringify(entrada))}`;
      const res = await pedir(url, { limitador });

      total = res?.response?.metadata?.total_matching_records ?? 0;
      const ids = (res?.response?.ids ?? []).map((x) => Number(x.appid)).filter(Boolean);
      if (ids.length === 0) break;

      for (const id of ids) todos.add(id);
      alAvanzar?.(todos.size, nombre, Math.min(inicio + POR_PAGINA, total), total);
    }
  }
  return [...todos];
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
