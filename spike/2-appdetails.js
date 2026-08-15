// SPIKE 2: ¿appdetails acepta appids en lote? ¿distingue retirado de bloqueado por región?
// appids de prueba: vivo, F2P, retirado conocido, y uno inexistente
const CASES = {
  620: 'Portal 2 (vivo, de pago)',
  570: 'Dota 2 (vivo, F2P)',
  6120: 'Alan Wake (retirado en 2017 por licencias musicales)',
  10190: 'Call of Duty MW2 (retirado/relistado)',
  35140: 'Batman Arkham Asylum GOTY (retirado por licencias, 2010s)',
  99999999: 'appid inexistente',
};

const get = async (url) => {
  const r = await fetch(url, { headers: { 'Accept-Language': 'es-ES,es;q=0.9' } });
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
};

(async () => {
  const ids = Object.keys(CASES).join(',');

  console.log('=== A) LOTE con filters=basic ===');
  const a = await get(`https://store.steampowered.com/api/appdetails?appids=${ids}&filters=basic&cc=es&l=spanish`);
  console.log('HTTP', a.status);
  if (a.status === 200) {
    const keys = Object.keys(a.body);
    console.log(`devuelve ${keys.length} de ${Object.keys(CASES).length} appids solicitados`);
    for (const k of keys) {
      const d = a.body[k];
      console.log(`  ${k.padStart(9)} success=${String(d.success).padEnd(5)} name="${d.data?.name ?? '-'}" | ${CASES[k] ?? '?'}`);
    }
  }

  console.log('\n=== B) LOTE con filters=price_overview ===');
  const b = await get(`https://store.steampowered.com/api/appdetails?appids=${ids}&filters=price_overview&cc=es&l=spanish`);
  console.log('HTTP', b.status, b.status === 200 ? JSON.stringify(b.body).slice(0, 400) : '');

  console.log('\n=== C) LOTE sin filters (¿solo devuelve el primero?) ===');
  const c = await get(`https://store.steampowered.com/api/appdetails?appids=${ids}&cc=es&l=spanish`);
  console.log('HTTP', c.status, c.status === 200 ? `claves devueltas: ${Object.keys(c.body).join(',')}` : '');

  console.log('\n=== D) INDIVIDUAL completo: qué campos delatan el estado ===');
  for (const id of Object.keys(CASES)) {
    const r = await get(`https://store.steampowered.com/api/appdetails?appids=${id}&cc=es&l=spanish`);
    if (r.status !== 200) { console.log(`  ${id}: HTTP ${r.status}`); continue; }
    const d = r.body[id];
    const g = d.data ?? {};
    console.log(`  ${id.padStart(9)} success=${String(d.success).padEnd(5)} type=${g.type ?? '-'} is_free=${g.is_free ?? '-'} ` +
      `pkgs=${g.package_groups ? g.package_groups.length : '-'} price=${g.price_overview?.final_formatted ?? '-'} ` +
      `release=${g.release_date?.date ?? '-'} | ${CASES[id]}`);
    await new Promise(s => setTimeout(s, 1500));
  }
})();
