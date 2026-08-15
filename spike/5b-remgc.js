// SPIKE 5b: extracción limpia del hilo RemGC vía endpoint AJAX + comments_raw
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const OWNER = '103582791435030951', FEATURE = '611696927926638786', FEATURE2 = '1736595131052961774';
const TOPIC = 'https://steamcommunity.com/groups/RemGC/discussions/9/1736595131052961774/';

const H = { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9' };

// extrae el objeto JSON que sigue a una clave, contando llaves
function grabJson(html, key) {
  const i = html.indexOf(`"${key}":{`);
  if (i < 0) return null;
  let d = 0, s = html.indexOf('{', i);
  for (let k = s; k < html.length; k++) {
    if (html[k] === '{') d++;
    else if (html[k] === '}') { d--; if (d === 0) return JSON.parse(html.slice(s, k + 1)); }
  }
  return null;
}

const appidsOf = (t) => [...new Set([
  ...[...t.matchAll(/steamdb\.info\/app\/(\d+)/g)].map(m => m[1]),
  ...[...t.matchAll(/store\.steampowered\.com\/app\/(\d+)/g)].map(m => m[1]),
  ...[...t.matchAll(/steamcommunity\.com\/games\/(\d+)\/announcements/g)].map(m => m[1]),
])];

(async () => {
  // --- 1) total_count desde la página del hilo
  const html = await (await fetch(TOPIC, { headers: H })).text();
  const total = Number(html.match(/"total_count":(\d+)/)[1]);
  const pagesize = Number(html.match(/"pagesize":(\d+)/)[1]);
  console.log(`total_count=${total} pagesize=${pagesize} ultimaPagina=${Math.ceil(total / pagesize)}`);

  // --- 2) endpoint AJAX directo a los más recientes
  const ajax = `https://steamcommunity.com/comment/ForumTopic/render/${OWNER}/${FEATURE}/?start=${total - 10}&count=10&feature2=${FEATURE2}&oldestfirst=true`;
  const r = await fetch(ajax, { headers: { ...H, 'X-Requested-With': 'XMLHttpRequest' } });
  console.log(`\nAJAX render: HTTP ${r.status}`);
  let comments = null;
  if (r.status === 200) {
    const jr = await r.json();
    console.log('  claves:', Object.keys(jr).join(','), '| total_count:', jr.total_count, '| start:', jr.start);
    if (jr.comments_raw) { comments = jr.comments_raw; console.log('  -> trae comments_raw'); }
    else if (jr.comments_html) {
      console.log('  -> solo comments_html, bytes:', jr.comments_html.length);
      const ids = [...jr.comments_html.matchAll(/id="comment_(\d+)"/g)].map(m => m[1]);
      console.log('  ids en html:', ids.slice(-5).join(','));
    }
  }

  // --- 3) fallback: comments_raw de la última página
  if (!comments) {
    const lastHtml = await (await fetch(`${TOPIC}?ctp=${Math.ceil(total / pagesize)}`, { headers: H })).text();
    comments = grabJson(lastHtml, 'comments_raw');
    console.log(`\nfallback ctp: comments_raw con ${comments ? Object.keys(comments).length : 0} comentarios`);
  }

  // --- 4) los 5 más recientes, ya parseados
  const list = Object.entries(comments).map(([id, c]) => ({ id, ...c })).sort((a, b) => a.timestamp - b.timestamp);
  console.log(`\n===== ${list.length} comentarios; los 5 últimos =====`);
  for (const c of list.slice(-5)) {
    const text = String(c.text).replace(/\s+/g, ' ').trim();
    console.log(`\n[${new Date(c.timestamp * 1000).toISOString()}] autor=${c.author ?? c.authorid ?? '?'}`);
    console.log(`  texto: ${text.slice(0, 200)}`);
    console.log(`  APPIDS: [${appidsOf(String(c.text)).join(', ')}]`);
  }
  console.log('\ncampos de un comentario:', Object.keys(list[0]).join(','));
})();
