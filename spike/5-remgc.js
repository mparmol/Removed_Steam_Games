// SPIKE 5: parsear la última página del hilo RemGC (nombre + appid + enlaces)
const URL = 'https://steamcommunity.com/groups/RemGC/discussions/9/1736595131052961774/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

const get = async (u) => {
  const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9' } });
  return { status: r.status, html: await r.text() };
};

(async () => {
  // 1) total de comentarios desde la página 1
  const p1 = await get(URL);
  console.log('HTTP página 1:', p1.status, '| bytes:', p1.html.length);
  const m = p1.html.match(/Showing\s+([\d,]+)-([\d,]+)\s+of\s+([\d,]+)\s+comments/i);
  if (!m) {
    console.log('NO encontrado el contador. Buscando alternativas...');
    const alt = p1.html.match(/of\s+([\d,]+)\s+comments/i) || p1.html.match(/commentthread_.*?_totalcount[^\d]*(\d+)/i);
    console.log('alt:', alt && alt[0]);
  } else {
    console.log(`contador: mostrando ${m[1]}-${m[2]} de ${m[3]}`);
  }
  const total = m ? Number(m[3].replace(/,/g, '')) : null;
  const perPage = m ? (Number(m[2].replace(/,/g, '')) - Number(m[1].replace(/,/g, '')) + 1) : 15;
  const last = total ? Math.ceil(total / perPage) : null;
  console.log(`total=${total} porPagina=${perPage} ultimaPagina=${last}`);

  // 2) última página
  const pl = await get(`${URL}?ctp=${last}`);
  console.log(`\nHTTP última página (ctp=${last}):`, pl.status, '| bytes:', pl.html.length);
  const chk = pl.html.match(/Showing\s+([\d,]+)-([\d,]+)\s+of\s+([\d,]+)\s+comments/i);
  console.log('contador última página:', chk ? chk[0] : 'no encontrado');

  // 3) extraer comentarios: id, autor, fecha, texto, appids enlazados
  const blocks = [...pl.html.matchAll(/<div class="commentthread_comment [^"]*"[^>]*id="comment_(\d+)"[\s\S]*?<div class="commentthread_comment_text"[^>]*>([\s\S]*?)<\/div>/g)];
  console.log(`\ncomentarios parseados: ${blocks.length}`);
  const strip = (h) => h.replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim().replace(/\s+/g, ' ');

  for (const b of blocks.slice(-4)) {
    const text = strip(b[2]);
    const appids = [...b[2].matchAll(/(?:steamdb\.info\/app|store\.steampowered\.com\/app)\/(\d+)/g)].map(x => x[1]);
    const news = [...b[2].matchAll(/steamcommunity\.com\/games\/(\d+)\/announcements\/detail\/(\d+)/g)].map(x => x[1]);
    console.log(`\n  id=${b[1]}`);
    console.log(`  texto: ${text.slice(0, 180)}`);
    console.log(`  appids en enlaces: [${[...new Set([...appids, ...news])].join(', ')}]`);
  }

  // 4) autores/fechas por si el bloque anterior no los captura
  const authors = [...pl.html.matchAll(/data-miniprofile="\d+"[^>]*>\s*([^<]+?)\s*<\/a>/g)].map(x => x[1]);
  const dates = [...pl.html.matchAll(/commentthread_comment_timestamp"[^>]*data-timestamp="(\d+)"/g)].map(x => new Date(Number(x[1]) * 1000).toISOString());
  console.log(`\nautores detectados: ${authors.length} | últimos: ${authors.slice(-3).join(', ')}`);
  console.log(`fechas detectadas: ${dates.length} | últimas: ${dates.slice(-3).join(', ')}`);
})();
