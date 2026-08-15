// SPIKE 1b: la pregunta que decide GitHub Actions -> ¿cuánto TIEMPO cubre la ventana de PICS?
const SteamUser = require('steam-user');
const user = new SteamUser({ enablePicsCache: false });

user.on('error', e => { console.log('ERROR:', e.message); process.exit(1); });

user.on('loggedOn', async () => {
  const c0 = (await user.getProductChanges(0)).currentChangeNumber;
  console.log(`t=0   changenumber=${c0}`);

  // 1) frontera exacta de la ventana de APPS (búsqueda binaria)
  let lo = 0, hi = 20000;
  while (hi - lo > 250) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await user.getProductChanges(c0 - mid);
    if (r.appChanges.length > 0) lo = mid; else hi = mid;
    process.stdout.write(`  probe -${mid}: apps=${r.appChanges.length} pkgs=${r.packageChanges.length}\n`);
  }
  console.log(`FRONTERA APPS: entre -${lo} y -${hi} changenumbers`);

  // 2) respuesta cruda al salirse de la ventana (¿avisa Steam de algún modo?)
  const out = await user.getProductChanges(c0 - 60000);
  console.log('fuera de ventana, claves:', JSON.stringify(out).slice(0, 300));

  // 3) ritmo: cuántos changenumbers pasan en 3 minutos
  console.log('midiendo ritmo durante 3 min...');
  await new Promise(s => setTimeout(s, 180000));
  const c1 = (await user.getProductChanges(0)).currentChangeNumber;
  const perMin = (c1 - c0) / 3;
  console.log(`t=3min changenumber=${c1}  =>  ${perMin.toFixed(1)} changenumbers/min`);
  console.log(`VENTANA APPS ESTIMADA: ${(lo / perMin).toFixed(0)} min (~${(lo / perMin / 60).toFixed(1)} h)`);

  user.logOff();
  setTimeout(() => process.exit(0), 300);
});

user.logOn({ anonymous: true });
