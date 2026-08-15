// SPIKE 5c: parser correcto (consciente de strings) + diagnóstico del endpoint AJAX
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const OWNER = '103582791435030951', FEATURE = '611696927926638786', FEATURE2 = '1736595131052961774';
const TOPIC = 'https://steamcommunity.com/groups/RemGC/discussions/9/1736595131052961774/';
const H = { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9' };

// recorta el objeto JSON tras "key": respetando comillas y escapes
function grabJson(html, key) {
  const i = html.indexOf(`"${key}":{`);
  if (i < 0) return null;
  const s = html.indexOf('{', i);
  let d = 0, inStr = false, esc = false;
  for (let k = s; k < html.length; k++) {
    const c = html[k];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return JSON.parse(html.slice(s, k + 1)); }
  }
  return null;
}

const appidsOf = (t) => [...new Set([
  ...[...t.matchAll(/steamdb\.info\/app\/(\d+)/g)].map(m => m[1]),
  ...[...t.matchAll(/store\.steampowered\.com\/app\/(\d+)/g)].map(m => m[1]),
  ...[...t.matchAll(/steamcommunity\.com\/(?:games|app)\/(\d+)/g)].map(m => m[1]),
])];

(async () => {
  const html = await (await fetch(TOPIC, { headers: H })).text();
  const total = Number(html.match(/"total_count":(\d+)/)[1]);
  const pagesize = Number(html.match(/"pagesize":(\d+)/)[1]);
  const last = Math.ceil(total / pagesize);
  console.log(`total=${total} pagesize=${pagesize} ultimaPagina=${last}`);

  console.log('\n--- diagnóstico endpoint AJAX ---');
  for (const [nombre, url] of [
    ['sin oldestfirst', `https://steamcommunity.com/comment/ForumTopic/render/${OWNER}/${FEATURE}/?start=${total - 10}&count=10&feature2=${FEATURE2}`],
    ['count solo', `https://steamcommunity.com/comment/ForumTopic/render/${OWNER}/${FEATURE}/?count=10&feature2=${FEATURE2}`],
    ['POST', `https://steamcommunity.com/comment/ForumTopic/render/${OWNER}/${FEATURE}/`],
  ]) {
    const opts = nombre === 'POST'
      ? { method: 'POST', headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `start=${total - 10}&count=10&feature2=${FEATURE2}` }
      : { headers: H };
    const r = await fetch(url, opts);
    const t = await r.text();
    console.log(`  ${nombre.padEnd(15)} HTTP=${r.status} ${t.slice(0, 120).replace(/\s+/g, ' ')}`);
  }

  console.log('\n--- última página vía ctp ---');
  const lastHtml = await (await fetch(`${TOPIC}?ctp=${last}`, { headers: H })).text();
  const raw = grabJson(lastHtml, 'comments_raw');
  console.log(`comments_raw: ${raw ? Object.keys(raw).length : 0} comentarios`);
  if (!raw) return;

  const list = Object.entries(raw).map(([id, c]) => ({ id, ...c })).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  console.log('campos disponibles:', Object.keys(list[0]).join(','));

  console.log(`\n===== los 6 comentarios más recientes =====`);
  for (const c of list.slice(-6)) {
    const txt = String(c.text ?? '');
    const ts = c.timestamp ? new Date(c.timestamp * 1000).toISOString().slice(0, 16) : '?';
    console.log(`\n[${ts}] id=${c.id}`);
    console.log(`  ${txt.replace(/\s+/g, ' ').trim().slice(0, 220)}`);
    console.log(`  >> APPIDS: [${appidsOf(txt).join(', ')}]`);
  }
})();
