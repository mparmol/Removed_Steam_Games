// El ciclo de vigilancia: una pasada completa por todas las fuentes.

import { Limitador } from '../lib/http.js';
import * as pics from '../steam/pics.js';
import { consultarMuchos, gratisAhora, confirmarRetirada } from '../steam/store.js';
import { promosDePaquetes, promosQueTocanAvisar } from '../steam/promos.js';
import { comentariosNuevos } from '../sources/remgc.js';
import { leerApp, escribirApp } from './estado.js';
import { crearEvento, deduplicar } from './eventos.js';

/**
 * @param {object} estado  se MUTA con lo aprendido en el ciclo
 * @param {{registrar?: (msg:string)=>void}} opciones
 * @returns {Promise<{eventos: object[], resumen: object}>}
 */
export async function ejecutarCiclo(estado, { registrar = console.log } = {}) {
  const limitador = new Limitador(100);
  const eventos = [];
  const resumen = { pics: null, verificadas: 0, remgc: 0, promos: 0, gratis: 0 };

  // ---- 1. PICS: que ha cambiado -------------------------------------------------
  let cambios;
  try {
    cambios = await pics.cambiosDesde(estado.cursor.changenumber, {
      ultimoCicloMs: estado.cursor.ultimo_ciclo ? Date.parse(estado.cursor.ultimo_ciclo) : null,
    });
  } catch (e) {
    registrar(`  PICS fallo: ${e.message} -- se sigue con el resto de fuentes`);
    cambios = { actual: estado.cursor.changenumber, apps: [], paquetes: [], ventanaPerdida: true, motivo: 'error' };
  }

  resumen.pics = { actual: cambios.actual, apps: cambios.apps.length, paquetes: cambios.paquetes.length, ventanaPerdida: cambios.ventanaPerdida, motivo: cambios.motivo };
  registrar(`  PICS: changenumber=${cambios.actual} apps=${cambios.apps.length} pkgs=${cambios.paquetes.length}` +
    (cambios.ventanaPerdida ? `  [VENTANA PERDIDA: ${cambios.motivo} -> hace falta barrido]` : ''));

  // ---- 2. Verificar candidatos + reverificar pendientes --------------------------
  // Los pendientes son detecciones provisionales del ciclo anterior: se confirman o
  // se descartan mirandolas por segunda vez.
  const aVerificar = [...new Set([...cambios.apps, ...Object.keys(estado.pendientes).map(Number)])];

  if (aVerificar.length > 0) {
    const vistos = await consultarMuchos(aVerificar, limitador, (hechos, total) => {
      if (hechos % 2000 === 0 || hechos === total) registrar(`  verificando ${hechos}/${total}`);
    });
    resumen.verificadas = vistos.size;

    // La bandera `visible` es RELATIVA AL PAIS: un juego bloqueado en Espana parece
    // retirado. Medido: 4 de 7 candidatos eran bloqueos regionales, no retiradas.
    // Por eso los que "desaparecen" se contrastan contra varios mercados antes de nada.
    const sospechosos = [...vistos.values()]
      .filter((v) => !v.visible && leerApp(estado, v.appid)?.visible)
      .map((v) => v.appid);

    const confirmacion = sospechosos.length > 0 ? await confirmarRetirada(sospechosos, limitador) : new Map();
    if (sospechosos.length > 0) {
      const regionales = [...confirmacion.values()].filter((c) => !c.retirado).length;
      registrar(`  ${sospechosos.length} sospechosos: ${sospechosos.length - regionales} retirados, ${regionales} solo bloqueo regional`);
    }

    for (const [appid, ahora] of vistos) {
      const antes = leerApp(estado, appid);
      const pendiente = estado.pendientes[appid];

      // desaparecido solo en algunos mercados: no es una retirada
      const conf = confirmacion.get(appid);
      if (conf && !conf.retirado) {
        registrar(`  ${appid} sigue visible en ${conf.visibleEn.join(',')}: bloqueo regional, no retirada`);
        continue;
      }

      if (pendiente) {
        // segunda mirada: confirmamos o descartamos
        const sigue = pendiente.tipo === 'retirado' ? !ahora.visible : ahora.visible;
        if (sigue) {
          eventos.push(crearEvento({
            tipo: pendiente.tipo,
            appid,
            nombre: ahora.nombre || pendiente.nombre,
            app_type: ahora.tipo !== 'otro' ? ahora.tipo : pendiente.app_type,
            precio: antes?.precio ?? pendiente.precio,
            fuente: 'pics',
            confianza: 'confirmado',
          }));
        } else {
          registrar(`  descartado falso positivo: ${appid} (${pendiente.tipo})`);
        }
        delete estado.pendientes[appid];
      } else if (antes && antes.visible !== ahora.visible) {
        // transicion nueva: se emite provisional y queda pendiente de confirmar
        const tipo = ahora.visible ? 'revivido' : 'retirado';
        // el nombre se pierde cuando deja de ser visible: conservamos el que teniamos
        const nombre = ahora.nombre || antes.nombre;
        const app_type = ahora.tipo !== 'otro' ? ahora.tipo : antes.tipo;
        const precio = antes.precio;
        eventos.push(crearEvento({ tipo, appid, nombre, app_type, precio, fuente: 'pics', confianza: 'provisional' }));
        estado.pendientes[appid] = { tipo, nombre, app_type, precio, visto: new Date().toISOString() };
      }

      // el estado se actualiza siempre, aunque no haya evento
      escribirApp(estado, appid, {
        visible: ahora.visible,
        nombre: ahora.nombre || antes?.nombre || '',
        tipo: ahora.tipo !== 'otro' ? ahora.tipo : antes?.tipo,
        precio: ahora.precio,
      });
    }
  }

  // ---- 3. Promociones: PICS como preaviso ---------------------------------------
  if (cambios.paquetes.length > 0) {
    try {
      const paquetes = await pics.infoPaquetes(cambios.paquetes);
      const promos = promosDePaquetes(paquetes);
      for (const promo of promos) {
        const previa = estado.promos[promo.packageid];
        estado.promos[promo.packageid] = {
          ...promo,
          avisado_proximo: previa?.avisado_proximo ?? false,
          avisado_inicio: previa?.avisado_inicio ?? false,
        };
      }
      resumen.promos = promos.length;
      registrar(`  promos en paquetes: ${promos.length} creibles de ${paquetes.length} paquetes`);
    } catch (e) {
      registrar(`  info de paquetes fallo: ${e.message}`);
    }
  }

  // avisos programados a partir de lo persistido (una promo vista hace dias avisa hoy)
  const { proximas, empiezan } = promosQueTocanAvisar(estado.promos);
  for (const promo of [...proximas, ...empiezan]) {
    const empieza = empiezan.includes(promo);
    for (const appid of promo.apps) {
      const conocida = leerApp(estado, appid);
      eventos.push(crearEvento({
        tipo: empieza ? (promo.tipo === 'finde_gratis' ? 'finde_gratis' : 'gratis_activo') : 'gratis_proximo',
        appid,
        nombre: conocida?.nombre ?? '',
        app_type: conocida?.tipo ?? 'otro',
        fuente: 'pics',
        vence: promo.fin,
        confianza: 'confirmado',
      }));
    }
    if (empieza) estado.promos[promo.packageid].avisado_inicio = true;
    else estado.promos[promo.packageid].avisado_proximo = true;
  }

  // ---- 4. Promociones: la tienda es la verdad de "gratis ahora" ------------------
  // Deponia (214340) demostro que una promo viva puede no estar en la ventana de PICS.
  try {
    const { appids } = await gratisAhora(limitador);
    const antes = new Set(estado.gratis_ahora ?? []);
    const nuevos = appids.filter((a) => !antes.has(a));
    resumen.gratis = appids.length;
    registrar(`  gratis ahora segun la tienda: ${appids.length} (${nuevos.length} nuevos)`);

    if (appids.length > 0) {
      const info = await consultarMuchos(nuevos, limitador);
      for (const appid of nuevos) {
        const dato = info.get(appid);
        eventos.push(crearEvento({
          tipo: 'gratis_activo',
          appid,
          nombre: dato?.nombre ?? leerApp(estado, appid)?.nombre ?? '',
          app_type: dato?.tipo ?? 'otro',
          fuente: 'tienda',
          confianza: 'confirmado',
        }));
      }
      estado.gratis_ahora = appids;
    }
  } catch (e) {
    registrar(`  busqueda de gratis fallo: ${e.message}`);
  }

  // ---- 5. Hilo RemGC: retiradas anunciadas por humanos ---------------------------
  try {
    const { nuevos, ultimoIdVisto, total } = await comentariosNuevos(estado.remgc.ultimo_id, limitador);
    resumen.remgc = nuevos.length;
    registrar(`  RemGC: ${total} comentarios, ${nuevos.length} nuevos`);

    const appidsRemgc = [...new Set(nuevos.flatMap((c) => c.appids))];
    const info = appidsRemgc.length ? await consultarMuchos(appidsRemgc, limitador) : new Map();

    for (const com of nuevos) {
      for (const appid of com.appids) {
        const dato = info.get(appid);
        eventos.push(crearEvento({
          tipo: 'retirada_anunciada',
          appid,
          nombre: dato?.nombre ?? leerApp(estado, appid)?.nombre ?? '',
          app_type: dato?.tipo ?? 'otro',
          fuente: 'remgc',
          anuncio: com.anuncio,
          confianza: 'confirmado',
        }));
      }
    }
    estado.remgc.ultimo_id = ultimoIdVisto;
  } catch (e) {
    registrar(`  RemGC fallo: ${e.message}`);
  }

  // ---- 6. Cerrar cursor ---------------------------------------------------------
  if (cambios.actual) estado.cursor.changenumber = cambios.actual;
  estado.cursor.ultimo_ciclo = new Date().toISOString();
  estado.cursor.ventana_perdida = cambios.ventanaPerdida;

  return { eventos: deduplicar(eventos), resumen };
}
