// PICS: el sistema con el que Steam avisa de que una app o un paquete ha cambiado.
//
// Se accede con login ANONIMO (sin credenciales del usuario). Validado en el spike
// tanto en local (1,07 s) como desde un runner de GitHub (3 logins seguidos, 1129 /
// 488 / 321 ms, sin rate limit por IP).
//
// TRAMPA IMPORTANTE: la ventana de histórico es de ~7.200 changenumbers (~9,5 h al
// ritmo medido de 12,7/min) y al salirse de ella Steam NO da error: devuelve
// {appChanges: [], packageChanges: []}, indistinguible de "no ha cambiado nada".
// Por eso comprobamos el hueco a mano antes de fiarnos del resultado.

import SteamUser from 'steam-user';

/** Margen de seguridad sobre los ~7.200 changenumbers medidos. */
export const HUECO_MAX = 5000;
/** Si el ultimo ciclo fue hace mas de esto, no nos fiamos de la ventana. */
export const ANTIGUEDAD_MAX_MS = 8 * 60 * 60 * 1000;

/** Abre sesion anonima y ejecuta `tarea`, cerrando siempre al terminar. */
export async function conSesion(tarea, { timeoutMs = 120000 } = {}) {
  const user = new SteamUser({ enablePicsCache: false });

  return await new Promise((resolve, reject) => {
    let resuelto = false;
    const terminar = (fn, arg) => {
      if (resuelto) return;
      resuelto = true;
      clearTimeout(reloj);
      try { user.logOff(); } catch { /* ya estaba cerrada */ }
      fn(arg);
    };

    const reloj = setTimeout(() => terminar(reject, new Error(`PICS: timeout tras ${timeoutMs} ms`)), timeoutMs);
    user.on('error', (e) => terminar(reject, e));
    user.on('loggedOn', async () => {
      try {
        terminar(resolve, await tarea(user));
      } catch (e) {
        terminar(reject, e);
      }
    });

    user.logOn({ anonymous: true });
  });
}

/**
 * Cambios desde `cursor`. Si `cursor` es null o esta fuera de ventana, devuelve
 * `ventanaPerdida: true` para que el llamante encole un barrido completo en vez de
 * creerse un resultado vacio.
 */
export async function cambiosDesde(cursor, { ultimoCicloMs = null } = {}) {
  return await conSesion(async (user) => {
    const actual = (await user.getProductChanges(0)).currentChangeNumber;

    const hueco = cursor ? actual - cursor : Infinity;
    const demasiadoViejo = ultimoCicloMs != null && Date.now() - ultimoCicloMs > ANTIGUEDAD_MAX_MS;
    const ventanaPerdida = !cursor || hueco > HUECO_MAX || demasiadoViejo;

    if (ventanaPerdida) {
      return { actual, hueco, ventanaPerdida, apps: [], paquetes: [], motivo: !cursor ? 'sin-cursor' : demasiadoViejo ? 'ciclo-antiguo' : 'hueco-grande' };
    }

    const r = await user.getProductChanges(cursor);
    return {
      actual: r.currentChangeNumber,
      hueco,
      ventanaPerdida: false,
      apps: r.appChanges.map((a) => a.appid),
      paquetes: r.packageChanges.map((p) => p.packageid),
      motivo: null,
    };
  });
}

/**
 * Apps que el editor ha pedido retirar.
 *
 * `common.app_retired_publisher_request` es la senal autoritativa de Steam para el
 * caso "retirado a peticion del editor": la ficha se queda publicada con el aviso de
 * "no longer available" y `visible` sigue en true. Comprobado: Anvillage (2026300) lo
 * tiene a 1 y Portal 2 no.
 *
 * Es de alta precision pero poca cobertura: las retiradas antiguas por licencia
 * (Marvel Heroes, TMNT) no lo llevan. Sirve para confirmar sin dudas, no para detectar
 * todo.
 *
 * @returns {Promise<Set<number>>}
 */
/**
 * Ritmo de PICS por defecto, en changenumbers por minuto.
 *
 * El 12,7 del spike inicial se quedaba corto un 60%: contrastado el 27 de agosto
 * contra casos limpios (Astrobuilder, cambiado ~22:09 del 26 con cn 38359138, y los
 * DLC de The Witcher 3, ~20:01 del 25 con cn 38327162) el ritmo real rondaba los 20,
 * y la mediana sobre 46 eventos detectados por PICS daba 22. Con 12,7 las edades
 * salian infladas 1,5x y el filtro de "30 dias" cortaba de hecho en 19.
 *
 * Solo se usa hasta que haya histórico propio: ver `ritmoDeCambios`.
 */
export const RITMO_POR_DEFECTO = 20;

/** Muestras mas antiguas que esto no cuentan para calcular el ritmo. */
const HISTORIAL_MAX_MS = 30 * 24 * 60 * 60 * 1000;
/** Por debajo de este arco no hay muestra suficiente y se usa el valor por defecto. */
const ARCO_MINIMO_MS = 12 * 60 * 60 * 1000;

/**
 * Ritmo real de PICS a partir de nuestras propias muestras `[ms, changenumber]`.
 *
 * Steam va a rafagas —medido: 4,6 cambios/min una noche tranquila y mas de 200/min
 * durante una actualizacion masiva— asi que cualquier constante fija esta mal casi
 * siempre. Con el histórico propio el promedio se corrige solo.
 */
export function ritmoDeCambios(historial = []) {
  const corte = Date.now() - HISTORIAL_MAX_MS;
  const m = historial.filter(([t, cn]) => t >= corte && cn > 0).sort((a, b) => a[0] - b[0]);
  if (m.length < 2) return RITMO_POR_DEFECTO;

  const [t0, cn0] = m[0];
  const [t1, cn1] = m[m.length - 1];
  if (t1 - t0 < ARCO_MINIMO_MS || cn1 <= cn0) return RITMO_POR_DEFECTO;

  return (cn1 - cn0) / ((t1 - t0) / 60000);
}

/** Anade una muestra al histórico y lo poda. Devuelve el histórico nuevo. */
export function anotarRitmo(historial = [], changenumber, ahora = Date.now()) {
  if (!changenumber) return historial;
  const corte = ahora - HISTORIAL_MAX_MS;
  return [...historial.filter(([t]) => t >= corte), [ahora, changenumber]].slice(-2000);
}

/**
 * Dias transcurridos desde el ultimo cambio de cada app en PICS.
 *
 * Es el unico "cuando paso esto" que da Steam gratis. La fecha del feed dice cuando
 * lo vimos NOSOTROS, que no es lo mismo: el primer barrido con el campo `comprable`
 * bien escrito solto 1.006 avisos de golpe y 482 eran de apps que llevaban mas de
 * medio ano sin tocarse. Distant Kingdoms daba ~189 dias; Crysis 3, 6.
 *
 * Es un PROXY, no un dato: mide el ultimo cambio de cualquier cosa de la app, no la
 * fecha de retirada. Un juego retirado en febrero y parcheado la semana pasada
 * parecera reciente.
 *
 * `ritmo` en changenumbers por minuto; sale de `ritmoDeCambios(estado.ritmo)`.
 *
 * @returns {Promise<Map<number, number>>} appid -> dias (redondeados)
 */
export async function antiguedadDeCambio(appids, ritmo = RITMO_POR_DEFECTO) {
  if (appids.length === 0) return new Map();
  const porDia = ritmo * 60 * 24;
  return await conSesion(async (user) => {
    const actual = (await user.getProductChanges(0)).currentChangeNumber;
    const info = await user.getProductInfo(appids, [], true);

    const salida = new Map();
    for (const [appid, p] of Object.entries(info.apps)) {
      if (!p.changenumber) continue;
      salida.set(Number(appid), Math.round((actual - p.changenumber) / porDia));
    }
    return salida;
  }, { timeoutMs: 180000 });
}

export async function retiradasPorEditor(appids) {
  if (appids.length === 0) return new Set();
  return await conSesion(async (user) => {
    const info = await user.getProductInfo(appids, [], true);
    const marcadas = new Set();
    for (const [appid, p] of Object.entries(info.apps)) {
      if (p.appinfo?.common?.app_retired_publisher_request) marcadas.add(Number(appid));
    }
    return marcadas;
  });
}

/** Datos crudos de paquetes (para detectar promociones). */
export async function infoPaquetes(packageids) {
  if (packageids.length === 0) return [];
  return await conSesion(async (user) => {
    const info = await user.getProductInfo([], packageids, true);
    return Object.values(info.packages)
      .map((p) => p.packageinfo)
      .filter(Boolean);
  });
}
