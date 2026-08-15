// SPIKE 4: ¿cuántos appids por petición acepta GetItems y a qué ritmo? -> coste del barrido completo
const j = async (url) => {
  const t = Date.now();
  const r = await fetch(url);
  const body = r.status === 200 ? await r.json() : await r.text();
  return { status: r.status, ms: Date.now() - t, body };
};

const build = (ids) => {
  const input = {
    ids: ids.map(a => ({ appid: a })),
    context: { language: 'english', country_code: 'ES', steam_realm: 1 },
    data_request: { include_basic_info: true },
  };
  return `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`;
};

(async () => {
  // ISteamApps/GetAppList está muerto (404) -> generamos un pool de appids por rango
  const CATALOGO_EST = 5120000; // appid más alto visto en PICS
  const pool = Array.from({ length: 6000 }, (_, i) => 10 + i * 7);
  const apps = { length: CATALOGO_EST };
  console.log(`pool sintético de ${pool.length} appids (rango 10..${pool[pool.length - 1]})\n`);

  console.log('=== A) tamaño máximo de lote ===');
  for (const n of [50, 100, 200, 500, 1000]) {
    const ids = pool.slice(0, n);
    const r = await j(build(ids));
    const got = r.body?.response?.store_items?.length;
    console.log(`  pedidos=${String(n).padStart(4)} HTTP=${r.status} devueltos=${got ?? '-'} ${r.ms}ms url_len=${build(ids).length}`);
    if (r.status !== 200) { console.log('   -> corta aquí:', String(r.body).slice(0, 120)); break; }
    await new Promise(s => setTimeout(s, 1500));
  }

  console.log('\n=== B) ritmo: 20 peticiones seguidas de 200 ids (¿429?) ===');
  let ok = 0, fail = 0;
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) {
    const ids = pool.slice(i * 200, (i + 1) * 200);
    const r = await j(build(ids));
    if (r.status === 200) ok++; else { fail++; console.log(`  petición ${i}: HTTP ${r.status}`); }
    process.stdout.write(`  ${i + 1}:${r.status}(${r.ms}ms) `);
  }
  const total = (Date.now() - t0) / 1000;
  console.log(`\n  ok=${ok} fail=${fail} en ${total.toFixed(1)}s => ${(ok * 200 / total).toFixed(0)} apps/s`);
  console.log(`  ESTIMACIÓN barrido completo (${apps.length} apps): ${(apps.length / (ok * 200 / total) / 60).toFixed(1)} min`);
})();
