// Hilo "Removed Games Collectors" del grupo RemGC: curacion humana de retiradas
// anunciadas, que es informacion que ninguna API de Steam da.
//
// La pagina embebe todo lo que hace falta en el propio HTML:
//   - "total_count": 11686  y  "pagesize": 15   -> ultima pagina = ceil(total/pagesize)
//   - "comments_raw": {...} -> BBCode CRUDO de cada comentario de esa pagina
//
// El endpoint AJAX (comment/ForumTopic/render/...) NO sirve: responde
// {"success":false,"error":"Este perfil es privado."} sin sesion iniciada.

import { pedir } from '../lib/http.js';

const HILO = 'https://steamcommunity.com/groups/RemGC/discussions/9/1736595131052961774/';

/**
 * Recorta el objeto JSON que sigue a `"clave":` contando llaves, pero respetando
 * comillas y escapes. Un contador ingenuo se rompe: hay llaves dentro de strings
 * (p. ej. el campo extended_data), y devuelve un objeto truncado.
 */
export function recortarJson(html, clave) {
  const marca = html.indexOf(`"${clave}":{`);
  if (marca < 0) return null;

  const inicio = html.indexOf('{', marca);
  let prof = 0;
  let enCadena = false;
  let escapado = false;

  for (let i = inicio; i < html.length; i++) {
    const c = html[i];
    if (escapado) { escapado = false; continue; }
    if (c === '\\') { escapado = true; continue; }
    if (c === '"') { enCadena = !enCadena; continue; }
    if (enCadena) continue;
    if (c === '{') prof++;
    else if (c === '}') {
      prof--;
      if (prof === 0) return JSON.parse(html.slice(inicio, i + 1));
    }
  }
  return null;
}

/** Saca appids de los enlaces que la gente pega en los mensajes. */
export function appidsDeTexto(texto) {
  return [...new Set([
    ...[...texto.matchAll(/steamdb\.info\/app\/(\d+)/g)].map((m) => Number(m[1])),
    ...[...texto.matchAll(/store\.steampowered\.com\/app\/(\d+)/g)].map((m) => Number(m[1])),
    ...[...texto.matchAll(/steamcommunity\.com\/(?:games|app)\/(\d+)/g)].map((m) => Number(m[1])),
  ])];
}

/** Primer enlace a un anuncio oficial del desarrollador, si lo hay. */
export function anuncioDeTexto(texto) {
  const m = texto.match(/https?:\/\/steamcommunity\.com\/games\/\d+\/announcements\/detail\/\d+\/?/);
  return m ? m[0] : null;
}

/** Cuantas paginas hacia atras leer como maximo en una pasada. */
const PAGINAS_MAX = 8;

/**
 * Devuelve los comentarios del hilo posteriores a `ultimoId`.
 *
 * Leer SOLO la ultima pagina no basta, por dos motivos:
 *  - En el primer arranque esa pagina puede tener un unico comentario, y todo el
 *    resto del dia queda sin ver.
 *  - Cuando una pagina se llena Steam abre otra; si entre dos ciclos llegan
 *    comentarios repartidos entre las dos, los de la anterior se pierden.
 *
 * Por eso se calcula cuantos comentarios han entrado desde la ultima vez
 * (comparando total_count) y se retrocede lo necesario, con un margen de una pagina.
 *
 * OJO con los ids: NO son crecientes. En una misma pagina conviven rangos distintos
 * (581679396200450653 aparece antes que 418424007826614558 pese a ser mayor), asi que
 * no sirven para decidir que es nuevo comparando con un maximo. Hay que llevar el
 * registro explicito de lo ya procesado.
 *
 * @param {Set<string>|string[]} vistos  ids ya procesados
 * @param {number|null} ultimoTotal      total_count de la ejecucion anterior
 */
export async function comentariosNuevos(vistos = [], ultimoTotal = null, limitador = null) {
  const yaVistos = vistos instanceof Set ? vistos : new Set(vistos);
  const portada = await pedir(HILO, { limitador, comoTexto: true });

  const total = Number(portada.match(/"total_count":(\d+)/)?.[1]);
  const porPagina = Number(portada.match(/"pagesize":(\d+)/)?.[1]);
  if (!total || !porPagina) throw new Error('RemGC: no se encuentran total_count/pagesize en el HTML');

  const ultimaPagina = Math.ceil(total / porPagina);

  // sin referencia previa cogemos un colchon de 3 paginas (~45 comentarios)
  const entrantes = ultimoTotal != null ? Math.max(0, total - ultimoTotal) : porPagina * 3;
  const cuantasPaginas = Math.min(PAGINAS_MAX, Math.max(1, Math.ceil(entrantes / porPagina) + 1));

  const comentarios = [];
  for (let i = 0; i < cuantasPaginas; i++) {
    const pagina = ultimaPagina - i;
    if (pagina < 1) break;
    const html = await pedir(`${HILO}?ctp=${pagina}`, { limitador, comoTexto: true });
    const crudos = recortarJson(html, 'comments_raw') ?? {};
    for (const [id, c] of Object.entries(crudos)) {
      const texto = String(c.text ?? '');
      comentarios.push({ id, texto, autor: c.author ?? null, appids: appidsDeTexto(texto), anuncio: anuncioDeTexto(texto) });
    }
  }

  const nuevos = comentarios.filter((c) => !yaVistos.has(c.id));

  return {
    total,
    ultimaPagina,
    paginasLeidas: cuantasPaginas,
    comentarios,
    nuevos,
    // se conservan mas ids de los que caben en las paginas leidas, por si el hilo
    // se mueve mucho entre ciclos
    vistos: [...comentarios.map((c) => c.id), ...yaVistos].slice(0, 600),
  };
}
