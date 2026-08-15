// SPIKE 3: juegos REALMENTE retirados hoy vs vivos. ¿Qué campo los delata?
// + comparación entre appdetails (viejo) e IStoreBrowseService/GetItems (nuevo)
const CASES = {
  620: 'VIVO  Portal 2',
  570: 'VIVO  Dota 2 (F2P)',
  226320: 'RETIRADO Marvel Heroes (cerrado 2017)',
  314320: 'RETIRADO Transformers Devastation (licencia, 2017)',
  386660: 'RETIRADO TMNT Mutants in Manhattan (licencia, 2017)',
  225140: 'RETIRADO Duke Nukem 3D Megaton Edition (2016)',
  99999999: 'INEXISTENTE',
};
const IDS = Object.keys(CASES);

const j = async (url) => {
  const r = await fetch(url, { headers: { 'Accept-Language': 'es-ES,es;q=0.9' } });
  if (r.status !== 200) return { _http: r.status };
  try { return await r.json(); } catch { return { _http: r.status, _notjson: true }; }
};

(async () => {
  console.log('=== A) appdetails EN LOTE con filters=price_overview ===');
  const lote = await j(`https://store.steampowered.com/api/appdetails?appids=${IDS.join(',')}&filters=price_overview&cc=es&l=spanish`);
  for (const id of IDS) {
    const d = lote[id];
    console.log(`  ${id.padStart(9)} success=${String(d?.success).padEnd(5)} data=${JSON.stringify(d?.data)?.slice(0, 60).padEnd(62)} | ${CASES[id]}`);
  }

  console.log('\n=== B) appdetails INDIVIDUAL completo ===');
  for (const id of IDS) {
    const r = await j(`https://store.steampowered.com/api/appdetails?appids=${id}&cc=es&l=spanish`);
    const d = r[id]; const g = d?.data ?? {};
    console.log(`  ${id.padStart(9)} success=${String(d?.success).padEnd(5)} name="${(g.name ?? '-').slice(0, 34)}" ` +
      `pkg_groups=${g.package_groups?.length ?? '-'} price=${g.price_overview?.final_formatted ?? '-'} | ${CASES[id]}`);
    await new Promise(s => setTimeout(s, 1200));
  }

  console.log('\n=== C) IStoreBrowseService/GetItems (endpoint moderno, sin API key) ===');
  const input = {
    ids: IDS.map(a => ({ appid: Number(a) })),
    context: { language: 'spanish', country_code: 'ES', steam_realm: 1 },
    data_request: { include_basic_info: true, include_release: true, include_platforms: true },
  };
  const url = `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await j(url);
  if (res._http) { console.log('  HTTP', res._http, '(¿requiere key?)'); }
  else {
    const items = res.response?.store_items ?? [];
    console.log(`  devuelve ${items.length} items para ${IDS.length} solicitados`);
    for (const it of items) {
      console.log(`  appid=${String(it.appid ?? it.id).padStart(9)} visible=${it.visible} unvailable=${it.unvailable_for_country_restriction ?? '-'} ` +
        `name="${(it.name ?? '-').slice(0, 30)}" success=${it.success ?? '-'}`);
    }
    console.log('  claves del primer item:', Object.keys(items[0] ?? {}).join(','));
  }

  console.log('\n=== D) ¿la página de tienda existe? (HTTP + redirección) ===');
  for (const id of IDS) {
    const r = await fetch(`https://store.steampowered.com/app/${id}/?cc=es&l=spanish`, { redirect: 'manual' });
    console.log(`  ${id.padStart(9)} HTTP=${r.status} location=${r.headers.get('location') ?? '-'} | ${CASES[id]}`);
    await new Promise(s => setTimeout(s, 800));
  }
})();
