// Curador "Games at risk of removal" (clan 31857481).
//
// Es la mejor fuente de preaviso que hemos encontrado: mantenida a mano, con 1.534
// fichas y, sobre todo, con la FECHA EXACTA de retirada en el texto
// ("Will be removed from Steam on August 31, 2026"), ademas del precio actual y el
// enlace al anuncio del estudio.
//
// A diferencia del hilo RemGC, aqui la informacion ya viene estructurada por appid,
// asi que no hay que adivinar nada.

import { pedir } from '../lib/http.js';

const CLAN = 31857481;
const ENDPOINT = (inicio, cuantos) =>
  `https://store.steampowered.com/curator/${CLAN}/ajaxgetfilteredrecommendations/render/` +
  `?query=&start=${inicio}&count=${cuantos}&tagids=&sort=recent&types=0&cc=ES&l=english`;

const MESES = 'january|february|march|april|may|june|july|august|september|october|november|december';

/**
 * Saca la fecha de retirada del texto del curador.
 * Formatos vistos: "on August 31, 2026", "on September 21, 2026", "soon".
 * @returns {{fecha:string|null, inminente:boolean}}
 */
export function fechaDeRetirada(texto) {
  const t = String(texto);

  const conFecha = t.match(new RegExp(`\\b(${MESES})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, 'i'));
  if (conFecha) {
    const d = new Date(`${conFecha[1]} ${conFecha[2]}, ${conFecha[3]} UTC`);
    if (!Number.isNaN(d.getTime())) return { fecha: d.toISOString(), inminente: true };
  }

  // "will be removed soon" / "removed from Steam soon": sin fecha pero urgente
  if (/\b(soon|any day|shortly)\b/i.test(t)) return { fecha: null, inminente: true };

  return { fecha: null, inminente: false };
}

/** Distingue un aviso real de retirada de las fichas meramente informativas. */
const ES_AVISO = /\b(will be removed|being removed|removed from steam|delisted|no longer|last chance|end of sales?|expir\w+)\b/i;

const entidades = (s) =>
  s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/**
 * Lee las fichas mas recientes del curador.
 * @returns {Promise<{appid:number, nombre:string, precio:string|null, nota:string, fecha_retirada:string|null, inminente:boolean, anuncio:string|null, publicado:string|null, total:number}[]>}
 */
export async function fichasRecientes(cuantas = 50, limitador = null) {
  const res = await pedir(ENDPOINT(0, cuantas), { limitador });
  const html = res?.results_html ?? '';
  const total = res?.total_count ?? 0;

  // cada ficha empieza en un div.recommendation
  const bloques = html.split('<div data-panel=').slice(1);
  const salida = [];

  for (const b of bloques) {
    const appid = Number((b.match(/data-ds-appid="(\d+)"/) ?? [])[1]);
    if (!appid) continue;

    const nombre = entidades((b.match(/alt="([^"]*)"/) ?? [, ''])[1]);
    const precio = (b.match(/class="discount_final_price"[^>]*>([^<]+)</) ?? [, null])[1];
    const nota = entidades((b.match(/class="recommendation_desc"[^>]*>([\s\S]*?)<\/div>/) ?? [, ''])[1])
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const anuncio = (b.match(/class="recommendation_readmore"><a href="([^"]+)"/) ?? [, null])[1];
    const publicado = (b.match(/class="curator_review_date">([^<]+)</) ?? [, null])[1];

    if (!nota || !ES_AVISO.test(nota)) continue;

    const { fecha, inminente } = fechaDeRetirada(nota);
    salida.push({
      appid,
      nombre,
      precio: precio?.trim() ?? null,
      nota,
      fecha_retirada: fecha,
      inminente,
      anuncio: anuncio?.split('?')[0] ?? null,
      publicado: publicado?.trim() ?? null,
      total,
    });
  }
  return salida;
}
