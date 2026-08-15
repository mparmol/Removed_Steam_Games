// SPIKE 1: ¿funciona el login anónimo de Steam + PICS? ¿cuánto histórico guarda?
const SteamUser = require('steam-user');

const t0 = Date.now();
const user = new SteamUser({ enablePicsCache: false });
let done = false;

const finish = (code) => { if (!done) { done = true; try { user.logOff(); } catch {} setTimeout(() => process.exit(code), 300); } };

user.on('error', (e) => { console.log('ERROR:', e.eresult, e.message); finish(1); });
user.on('disconnected', (r, m) => console.log('disconnected:', r, m));

user.on('loggedOn', async () => {
  console.log(`LOGIN OK en ${Date.now() - t0} ms | steamID: ${user.steamID.getSteamID64()}`);
  try {
    // changenumber actual: pedir "desde 0" devuelve lista vacía + el número actual
    const now = await user.getProductChanges(0);
    const cur = now.currentChangeNumber;
    console.log(`changenumber actual: ${cur}`);

    // ¿cuánto histórico hay realmente? probamos saltos hacia atrás
    for (const back of [500, 2000, 10000, 50000, 200000]) {
      const r = await user.getProductChanges(cur - back);
      console.log(
        `  -${String(back).padStart(6)} => apps:${String(r.appChanges.length).padStart(6)}` +
        ` pkgs:${String(r.packageChanges.length).padStart(6)}` +
        ` forceFull:${r.forceFullUpdate || r.forceFullAppUpdate || r.forceFullPackageUpdate}`
      );
    }

    // muestra de appids cambiados en la ventana reciente
    const recent = await user.getProductChanges(cur - 2000);
    console.log('muestra appids:', recent.appChanges.slice(0, 15).map(a => a.appid).join(','));
    console.log('muestra pkgids:', recent.packageChanges.slice(0, 15).map(p => p.packageid).join(','));
    console.log('RESULTADO: PICS ACCESIBLE');
  } catch (e) {
    console.log('FALLO en PICS:', e.message);
    finish(2); return;
  }
  finish(0);
});

setTimeout(() => { console.log('TIMEOUT 90s'); finish(3); }, 90000);
user.logOn({ anonymous: true });
