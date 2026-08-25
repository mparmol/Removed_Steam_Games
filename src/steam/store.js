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
  12: 'playtest',
};

/**
 * Tipos que NUNCA se compran: no tener opciones de compra es su estado normal, no
 * una retirada. Los playtests dieron 22 falsos positivos de "ya no se vende" en el
 * primer ciclo, porque se abren y se cierran constantemente.
 */
const NO_VENDIBLES = new Set(['demo', 'playtest', 'hardware', 'otro']);

export function normalizarTipo(t) {
  if (typeof t === 'string') return TIPOS[t.toLowerCase()] ?? 'otro';
  return CODIGOS[t] ?? 'otro';
}

/**
 * Nota al estilo SteamDB a partir del porcentaje de reseñas positivas.
 *
 * Steam enseña el porcentaje pelado, que con pocas reseñas no dice nada: 50% de 2
 * reseñas (Pro Cycling Manager 2019 Editor) y 50% de 20.000 no son lo mismo. La
 * formula publicada por SteamDB tira ese porcentaje hacia el 50% cuanto menos
 * respaldo tiene:
 *
 *   nota = p - (p - 0,5) * 2^(-log10(n + 1))
 *
 * Portal 2 (98% de 389.337) da 97,0; Crysis 3 (85% de 4.659) da 82,3.
 *
 * OJO: SteamDB calcula sobre su propio recuento y aqui se usa `summary_filtered` de
 * Steam, asi que puede bailar alguna decima respecto a lo que muestra su web.
 */
export function notaSteamDb(porcentaje, resenas) {
  if (!resenas || resenas <= 0) return null;
  const p = porcentaje / 100;
  const nota = p - (p - 0.5) * 2 ** (-Math.log10(resenas + 1));
  return Math.round(nota * 1000) / 10;
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

/** El mercado desde el que compra el usuario: es el que decide que se le cuenta. */
export const PAIS_USUARIO = 'ES';

/**
 * Traduce el resultado de `confirmarRetirada` a lo que hay que contarle al usuario.
 *
 * Antes cualquier cosa que no fuese una retirada global acababa etiquetada como
 * "bloqueado en Espana", incluidos dos casos que no lo eran:
 *
 *  - Dungeon Siege III (39160) salio con "sigue a la venta en ES, US, JP, CN". O sea
 *    comprable AQUI, en los cuatro mercados: no habia nada que contar. La bandera
 *    `visible` de Steam da false en ES aunque se pueda comprar, asi que la deteccion
 *    era un falso positivo que la propia confirmacion ya desmentia.
 *  - Rocket League (252950) solo se compra en CN. No es un bloqueo regional: se retiro
 *    de Steam hace anos y lo unico que queda es el escaparate chino, que va por su
 *    cuenta. Para quien compra desde aqui, es sencillamente que ya no se vende.
 */
export function clasificar(conf) {
  if (conf.retirado) return 'retirado';
  // se puede comprar en nuestro mercado: no hay noticia
  if (conf.comprableEn.includes(PAIS_USUARIO)) return null;
  if (conf.comprableEn.length === 0) return 'no_comprable';
  // el realm chino es una tienda aparte: que solo quede ahi no es una alternativa real
  if (conf.comprableEn.every((p) => p === 'CN')) return 'no_comprable';
  return 'bloqueo_regional';
}

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
    // `include_reviews` no cuesta una peticion aparte: viene en el mismo lote de 200
    data_request: { include_basic_info: true, include_release: true, include_all_purchase_options: true, include_reviews: true },
  };
  const url = `${GETITEMS}?input_json=${encodeURIComponent(JSON.stringify(entrada))}`;
  const res = await pedir(url, { limitador });

  const salida = new Map();
  for (const item of res?.response?.store_items ?? []) {
    const appid = Number(item.appid ?? item.id);
    if (!appid) continue;
    const compra = item.best_purchase_option ?? item.purchase_options?.[0] ?? null;
    const gratis = item.is_free === true;
    // Promocion "quedatelo gratis": un juego de pago con 100% de descuento durante
    // unas horas. No es lo mismo que `is_free` (eso es un free-to-play de siempre) y
    // trae el plazo exacto, que es justo lo que hay que poner en la notificacion.
    // Comprobado con Dokimon Quest (2019300): discount_pct 100, is_free_to_keep true,
    // free_to_keep_ends 1787763600 = 26 ago 2026 19:00.
    const opciones = item.purchase_options ?? (compra ? [compra] : []);
    const promoGratis = opciones.find((o) => o.is_free_to_keep === true) ?? null;
    // Un juego sin lanzar esta visible y SIN opciones de compra, igual que uno al que
    // le han quitado el ultimo paquete. Hay 52.752 asi en la tienda, o sea que sin
    // esta distincion el detector de "ya no se vende" seria un generador de ruido.
    const tipo = normalizarTipo(item.type);
    const lanzamiento = Number(item.release?.steam_release_date ?? 0);
    const lanzado = lanzamiento > 0 && lanzamiento * 1000 < Date.now();
    // Se captura como el precio, y por lo mismo: en cuanto la ficha desaparece,
    // GetItems devuelve el item vacio y las resenas ya no hay forma de recuperarlas.
    const resumen = item.reviews?.summary_filtered ?? null;
    const resenas = Number(resumen?.review_count ?? 0);
    const porcentaje = resenas > 0 ? Number(resumen?.percent_positive ?? 0) : null;
    salida.set(appid, {
      appid,
      // `visible: false` cubre tanto "retirado" como "nunca existio". No los distingue,
      // y da igual: lo que detectamos es la TRANSICION visible -> no visible.
      visible: item.visible === true,
      nombre: item.name ?? '',
      tipo,
      gratis,
      // con una promo al 100% el precio final es "0,00 €": lo que interesa guardar
      // es lo que costaba, para poder decir cuanto te ahorras
      precio: (promoGratis
        ? promoGratis.formatted_original_price
        : compra?.formatted_final_price ?? compra?.formatted_original_price) ?? null,
      lanzado,
      // valoracion: el porcentaje crudo de Steam y la nota ponderada estilo SteamDB
      porcentaje,
      resenas,
      nota: porcentaje == null ? null : notaSteamDb(porcentaje, resenas),
      // se lo queda para siempre quien lo reclame antes de `gratisHasta`
      promoGratis: promoGratis != null,
      gratisHasta: promoGratis?.free_to_keep_ends
        ? new Date(Number(promoGratis.free_to_keep_ends) * 1000).toISOString()
        : null,
      // Si le retiran el ultimo paquete, la pagina sigue viva pero no hay forma de
      // comprarlo. Practicamente es una retirada, y mirar solo `visible` no lo ve.
      // Caso real: Anvillage (2026300) visible=true con 0 opciones de compra.
      // No aplica a lo que aun no ha salido ni a lo que nunca se vende.
      comprable: !lanzado || NO_VENDIBLES.has(tipo) || gratis ||
        (item.purchase_options?.length ?? 0) > 0 || item.best_purchase_option != null,
    });
  }
  return salida;
}

/**
 * Estado de un lote de PAQUETES.
 *
 * GetItems acepta `packageid` igual que `appid`, y ahi esta la senal que publica
 * SteamDB como "Removed from store": el paquete 893255 (Untamed Kingdom), retirado,
 * devuelve `visible: false` y sin nombre; uno vivo devuelve `visible: true` y los
 * appids que incluye. PICS avisa de que el paquete ha cambiado pero no deja leerlo
 * con login anonimo (`missingToken: true`), asi que el detalle sale de aqui.
 *
 * @returns {Promise<Map<number, {packageid:number, visible:boolean, nombre:string, appids:number[]}>>}
 */
export async function consultarPaquetes(packageids, limitador) {
  const salida = new Map();
  for (let i = 0; i < packageids.length; i += LOTE_MAX) {
    const lote = packageids.slice(i, i + LOTE_MAX);
    const entrada = {
      ids: lote.map((packageid) => ({ packageid: Number(packageid) })),
      context: { language: 'spanish', country_code: PAIS_USUARIO, steam_realm: 1 },
      data_request: { include_basic_info: true, include_included_items: true },
    };
    const url = `${GETITEMS}?input_json=${encodeURIComponent(JSON.stringify(entrada))}`;
    const res = await pedir(url, { limitador });

    for (const item of res?.response?.store_items ?? []) {
      const packageid = Number(item.id);
      if (!packageid) continue;
      salida.set(packageid, {
        packageid,
        visible: item.visible === true,
        nombre: item.name ?? '',
        // un paquete ya retirado NO devuelve sus appids: el mapa hay que tenerlo de antes
        appids: (item.included_appids ?? item.included_items?.included_appids ?? []).map(Number),
      });
    }
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
