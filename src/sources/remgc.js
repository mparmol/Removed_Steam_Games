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

/**
 * Lee la ultima pagina del hilo y devuelve los comentarios posteriores a `ultimoId`.
 * Coste: 2 peticiones HTTP.
 */
export async function comentariosNuevos(ultimoId = null, limitador = null) {
  const portada = await pedir(HILO, { limitador, comoTexto: true });

  const total = Number(portada.match(/"total_count":(\d+)/)?.[1]);
  const porPagina = Number(portada.match(/"pagesize":(\d+)/)?.[1]);
  if (!total || !porPagina) throw new Error('RemGC: no se encuentran total_count/pagesize en el HTML');

  const ultimaPagina = Math.ceil(total / porPagina);
  const html = await pedir(`${HILO}?ctp=${ultimaPagina}`, { limitador, comoTexto: true });

  const crudos = recortarJson(html, 'comments_raw') ?? {};
  const comentarios = Object.entries(crudos)
    .map(([id, c]) => ({
      id,
      texto: String(c.text ?? ''),
      autor: c.author ?? null,
      appids: appidsDeTexto(String(c.text ?? '')),
      anuncio: anuncioDeTexto(String(c.text ?? '')),
    }))
    // los ids son crecientes: sirven para ordenar y para saber que es nuevo
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

  const nuevos = ultimoId
    ? comentarios.filter((c) => BigInt(c.id) > BigInt(ultimoId))
    : comentarios;

  return { total, ultimaPagina, comentarios, nuevos, ultimoIdVisto: comentarios.at(-1)?.id ?? ultimoId };
}
