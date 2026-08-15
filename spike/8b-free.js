// SPIKE 8b: distinguir FREE WEEKEND de FREE-TO-KEEP y leer la ventana temporal
const SteamUser = require('steam-user');
const user = new SteamUser({ enablePicsCache: false });
user.on('error', e => { console.log('ERROR:', e.message); process.exit(1); });

const iso = t => t ? new Date(Number(t) * 1000).toISOString().slice(0, 16).replace('T', ' ') : null;

user.on('loggedOn', async () => {
  const cur = (await user.getProductChanges(0)).currentChangeNumber;
  const ch = await user.getProductChanges(cur - 7000);
  const ids = ch.packageChanges.map(p => p.packageid);
  console.log(`paquetes cambiados en la ventana: ${ids.length}`);

  const info = await user.getProductInfo([], ids, true);
  const pkgs = Object.values(info.packages).map(p => p.packageinfo).filter(Boolean);

  const promos = [];
  for (const p of pkgs) {
    const e = p.extended || {};
    if (p.billingtype !== 12 || (!e.starttime && !e.expirytime)) continue;
    const esFinde = String(e.freeweekend) === 'true' || e.freeweekend === true;
    promos.push({
      pkg: p.packageid, tipo: esFinde ? 'FREE WEEKEND' : 'FREE TO KEEP',
      inicio: iso(e.starttime), fin: iso(e.expirytime),
      apps: p.appids || [], flags: Object.keys(e).join('|'),
    });
  }
  promos.sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));

  console.log(`\npromos con ventana temporal detectadas: ${promos.length}`);
  const ahora = Date.now();
  for (const p of promos) {
    const finTs = Date.parse(p.fin + ':00Z');
    const estado = !p.inicio ? '?' : Date.parse(p.inicio + ':00Z') > ahora ? 'PROXIMA' : finTs > ahora ? 'ACTIVA' : 'terminada';
    console.log(`  [${p.tipo.padEnd(12)}] ${String(estado).padEnd(9)} pkg=${String(p.pkg).padEnd(8)} ${p.inicio} -> ${p.fin}  apps=${p.apps.join(',')}`);
  }

  // nombres de las apps de las promos próximas/activas para ver que es usable
  const interesantes = promos.filter(p => p.fin && Date.parse(p.fin + ':00Z') > ahora).flatMap(p => p.apps).slice(0, 10);
  if (interesantes.length) {
    const inp = { ids: interesantes.map(a => ({ appid: a })), context: { language: 'spanish', country_code: 'ES', steam_realm: 1 }, data_request: { include_basic_info: true } };
    const r = await (await fetch(`https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(inp))}`)).json();
    console.log('\nnombres de apps en promo vigente:');
    for (const it of r.response?.store_items ?? []) console.log(`   ${String(it.appid).padStart(8)} visible=${it.visible} "${it.name}"`);
  }
  user.logOff(); setTimeout(() => process.exit(0), 300);
});
user.logOn({ anonymous: true });
