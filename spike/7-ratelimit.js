// SPIKE 7: caracterizar el rate limit real -> dimensiona el barrido diario
const build = (ids) => {
  const input = { ids: ids.map(a => ({ appid: a })), context: { language: 'english', country_code: 'ES', steam_realm: 1 }, data_request: { include_basic_info: true } };
  return `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`;
};
const hit = async (off) => {
  const ids = Array.from({ length: 200 }, (_, k) => 10 + (off * 200 + k) * 3);
  try { return (await fetch(build(ids))).status; } catch { return 0; }
};
const sleep = ms => new Promise(s => setTimeout(s, ms));

(async () => {
  // A) ¿cuánto tarda en levantarse el bloqueo?
  console.log('A) esperando a que se levante el 429 (sondeo cada 30s)...');
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) {
    const st = await hit(9000 + i);
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`   t+${el}s -> HTTP ${st}`);
    if (st === 200) { console.log(`   DESBLOQUEADO tras ~${el}s`); break; }
    await sleep(30000);
  }

  // B) ritmo sostenido: 1 petición cada 1.6s (=125 apps/s) durante 4 min
  console.log('\nB) probando ritmo sostenido 1 req/1.6s durante 4 min...');
  let ok = 0, ko = 0;
  const t1 = Date.now();
  for (let i = 0; i < 150; i++) {
    const st = await hit(20000 + i);
    if (st === 200) ok++; else { ko++; console.log(`   !! HTTP ${st} en req ${i} (t+${((Date.now() - t1) / 1000).toFixed(0)}s)`); if (ko > 2) break; }
    await sleep(1600);
  }
  const s = (Date.now() - t1) / 1000;
  console.log(`   ok=${ok} ko=${ko} en ${s.toFixed(0)}s -> ${(ok * 200 / s).toFixed(0)} apps/s sostenidas`);
  console.log(`   catálogo conocido (~300k apps): ${(300000 / (ok * 200 / s) / 60).toFixed(0)} min por vuelta`);
  console.log(`   espacio completo (5,12M): ${(5120000 / (ok * 200 / s) / 3600).toFixed(1)} h desde 1 IP`);
})();
