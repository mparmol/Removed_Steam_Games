// SPIKE 6: ¿aguanta el ritmo? 300 peticiones seguidas (60.000 appids) buscando el 429
const build = (ids) => {
  const input = { ids: ids.map(a => ({ appid: a })), context: { language: 'english', country_code: 'ES', steam_realm: 1 }, data_request: { include_basic_info: true } };
  return `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`;
};

(async () => {
  const t0 = Date.now();
  let ok = 0, err = 0, visibles = 0, firstErr = null;
  const lat = [];
  for (let i = 0; i < 300; i++) {
    const ids = Array.from({ length: 200 }, (_, k) => 10 + (i * 200 + k) * 3);
    const t = Date.now();
    let r;
    try { r = await fetch(build(ids)); } catch (e) { err++; firstErr ??= `${i}: ${e.message}`; continue; }
    lat.push(Date.now() - t);
    if (r.status === 200) {
      ok++;
      const b = await r.json();
      visibles += (b.response?.store_items ?? []).filter(x => x.visible).length;
    } else {
      err++; firstErr ??= `petición ${i}: HTTP ${r.status}`;
      console.log(`\n  !! HTTP ${r.status} en la petición ${i} (t=${((Date.now() - t0) / 1000).toFixed(0)}s, ${ok} ok previas)`);
      if (r.status === 429) { console.log('  RATE LIMIT alcanzado'); break; }
    }
    if (i % 50 === 0) process.stdout.write(`[${i}]`);
  }
  const s = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  console.log(`\n\nok=${ok} err=${err} primerError=${firstErr ?? 'ninguno'}`);
  console.log(`tiempo=${s.toFixed(1)}s  ritmo=${(ok * 200 / s).toFixed(0)} apps/s  lat p50=${lat[Math.floor(lat.length / 2)]}ms p95=${lat[Math.floor(lat.length * 0.95)]}ms`);
  console.log(`apps visibles encontradas en la muestra: ${visibles} de ${ok * 200} (${(visibles / (ok * 200) * 100).toFixed(1)}%)`);
  console.log(`EXTRAPOLACIÓN barrido de 5,12M appids: ${(5120000 / (ok * 200 / s) / 60).toFixed(0)} min`);
})();
