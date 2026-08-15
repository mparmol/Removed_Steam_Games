// delistedgames.com: segundo agregador humano, complementario al hilo RemGC.
//
// Publica avisos con antelacion ("X shutting down on August 31st") y cubre cosas que
// el hilo se salta. Es multiplataforma, asi que hay que quedarse solo con lo que
// referencia a Steam.

import { pedir } from '../lib/http.js';

const FEED = 'https://delistedgames.com/feed/';

const campo = (bloque, etiqueta) => {
  const m = bloque.match(new RegExp(`<${etiqueta}[^>]*>([\\s\\S]*?)<\\/${etiqueta}>`));
  if (!m) return '';
  return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
};

/** Lenguaje de PREaviso: lo que aun no ha pasado es lo que da margen para comprar. */
const PREAVISO = /\b(shutting down|will (be )?(shut|close|end|be removed|be delisted)|scheduled|ahead of|before it|coming|soon|on \w+ \d{1,2}(st|nd|rd|th)?)\b/i;

/**
 * @returns {Promise<{appid:number|null, titulo:string, url:string, fecha:string, preaviso:boolean}[]>}
 */
export async function articulosNuevos(vistos = [], limitador = null) {
  const xml = await pedir(FEED, { limitador, comoTexto: true });
  const bloques = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const yaVistos = new Set(vistos);

  const salida = [];
  for (const b of bloques) {
    const url = campo(b, 'link');
    if (!url || yaVistos.has(url)) continue;

    const titulo = campo(b, 'title');
    const descripcion = campo(b, 'description') + campo(b, 'content:encoded');
    const appid = Number((b.match(/store\.steampowered\.com\/app\/(\d+)/) ?? [])[1]) || null;

    // sin referencia a Steam no nos sirve: el sitio cubre consolas tambien
    if (!appid && !/steam/i.test(titulo + descripcion)) continue;

    salida.push({
      appid,
      titulo,
      url,
      fecha: new Date(campo(b, 'pubDate') || Date.now()).toISOString(),
      preaviso: PREAVISO.test(titulo),
    });
  }
  return salida;
}
