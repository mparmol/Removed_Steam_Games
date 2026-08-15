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
