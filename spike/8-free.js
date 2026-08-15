// SPIKE 8: ¿se detectan las promos free-to-keep en los paquetes de PICS?
const SteamUser = require('steam-user');
const user = new SteamUser({ enablePicsCache: false });
user.on('error', e => { console.log('ERROR:', e.message); process.exit(1); });

user.on('loggedOn', async () => {
  const cur = (await user.getProductChanges(0)).currentChangeNumber;
  const ch = await user.getProductChanges(cur - 7000);
  const pkgIds = ch.packageChanges.map(p => p.packageid);
  console.log(`ventana: ${ch.appChanges.length} apps, ${pkgIds.length} paquetes cambiados`);

  const lote = pkgIds.slice(0, 400);
  const info = await user.getProductInfo([], lote, true);
  const pkgs = Object.values(info.packages);
  console.log(`getProductInfo devolvió ${pkgs.length} paquetes\n`);

  const bt = {}, lic = {};
  const candidatos = [];
  for (const p of pkgs) {
    const pi = p.packageinfo; if (!pi) continue;
    const b = pi.billingtype, l = pi.licensetype;
    bt[b] = (bt[b] || 0) + 1; lic[l] = (lic[l] || 0) + 1;
    const ext = pi.extended || {};
    // billingtype 12 = FreeOnDemand, 62 = ? ; nos interesan los que llevan ventana temporal
    if (b === 12 || b === 62 || ext.freepromotion || pi.starttime || pi.expirytime) {
      candidatos.push({
        id: pi.packageid, billingtype: b, licensetype: l,
        start: pi.starttime ? new Date(pi.starttime * 1000).toISOString().slice(0, 16) : null,
        expiry: pi.expirytime ? new Date(pi.expirytime * 1000).toISOString().slice(0, 16) : null,
        apps: (pi.appids ? Object.values(pi.appids) : []).slice(0, 4),
        ext: Object.keys(ext).slice(0, 6),
      });
    }
  }
  console.log('distribución billingtype:', JSON.stringify(bt));
  console.log('distribución licensetype:', JSON.stringify(lic));
  console.log(`\ncandidatos a promo gratuita: ${candidatos.length}`);
  for (const c of candidatos.slice(0, 12)) console.log('  ', JSON.stringify(c));

  // campos completos de un paquete cualquiera, para ver qué hay disponible
  const muestra = pkgs.find(p => p.packageinfo)?.packageinfo;
  console.log('\ncampos de packageinfo:', Object.keys(muestra).join(','));
  console.log('ejemplo:', JSON.stringify(muestra).slice(0, 500));

  user.logOff(); setTimeout(() => process.exit(0), 300);
});
user.logOn({ anonymous: true });
