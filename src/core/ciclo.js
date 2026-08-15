// El ciclo de vigilancia: una pasada completa por todas las fuentes.

import { Limitador } from '../lib/http.js';
import * as pics from '../steam/pics.js';
import { consultarMuchos, gratisAhora, confirmarRetirada } from '../steam/store.js';
import { promosDePaquetes, promosQueTocanAvisar } from '../steam/promos.js';
import { comentariosNuevos } from '../sources/remgc.js';
import { articulosNuevos } from '../sources/delisted.js';
import { anunciosDe, elegirObjetivos } from '../sources/anuncios.js';
import { fichasRecientes } from '../sources/curator.js';
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
    // Sospechoso = ha dejado de verse, O ha dejado de poder comprarse aun con la
    // pagina viva. Lo segundo es el caso Anvillage: Steam mantiene la ficha con un
    // aviso de "no longer available" y `visible` sigue en true.
    const sospechosos = [...vistos.values()]
      .filter((v) => {
        const antes = leerApp(estado, v.appid);
        if (!antes) return false;
        return (antes.visible && !v.visible) || (antes.comprable && !v.comprable);
      })
      .map((v) => v.appid);

    const confirmacion = sospechosos.length > 0 ? await confirmarRetirada(sospechosos, limitador) : new Map();
    if (sospechosos.length > 0) {
      const regionales = [...confirmacion.values()].filter((c) => !c.retirado).length;
      registrar(`  ${sospechosos.length} sospechosos: ${sospechosos.length - regionales} retirados, ${regionales} solo bloqueo regional`);
    }

    for (const [appid, ahora] of vistos) {
      const antes = leerApp(estado, appid);
      const pendiente = estado.pendientes[appid];

      // Desaparecido solo en algunos mercados: no es una retirada, pero interesa
      // saberlo. Va al feed con su propio tipo y nunca genera notificacion.
      const conf = confirmacion.get(appid);
      if (conf && !conf.retirado) {
        // Pagina viva en algun mercado pero sin forma de comprarlo en ninguno:
        // para el usuario equivale a una retirada.
        const tipoEvento = conf.soloEscaparate ? 'no_comprable' : 'bloqueo_regional';
        const detalle = conf.soloEscaparate
          ? 'La ficha sigue publicada pero no hay ninguna forma de comprarlo'
          : `Sigue a la venta en ${conf.comprableEn.join(', ') || conf.visibleEn.join(', ')}`;
        registrar(`  ${appid}: ${tipoEvento} (visible en ${conf.visibleEn.join(',')}, comprable en ${conf.comprableEn.join(',') || 'ninguno'})`);

        eventos.push(crearEvento({
          tipo: tipoEvento,
          appid,
          nombre: ahora.nombre || antes?.nombre || '',
          app_type: ahora.tipo !== 'otro' ? ahora.tipo : antes?.tipo,
          precio: antes?.precio,
          fuente: 'pics',
          confianza: 'confirmado',
          detalle,
        }));
        if (conf.soloEscaparate) estado.retirados[appid] = new Date().toISOString();
        escribirApp(estado, appid, {
          visible: ahora.visible,
          nombre: ahora.nombre || antes?.nombre || '',
          tipo: ahora.tipo,
          precio: ahora.precio,
          comprable: ahora.comprable,
        });
        continue;
      }

      if (pendiente) {
        // segunda mirada: confirmamos o descartamos
        const sigue = pendiente.tipo === 'retirado' ? !ahora.visible : ahora.visible;
        if (sigue) {
          // deja constancia para poder distinguir un regreso real de un estreno
          if (pendiente.tipo === 'retirado') estado.retirados[appid] = new Date().toISOString();
          else delete estado.retirados[appid];
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
        // Una app que pasa a visible solo "ha vuelto" si la vimos retirar. Si nunca
        // estuvo retirada es un estreno de pagina de tienda, no una resurreccion.
        if (ahora.visible && !estado.retirados[appid]) {
          escribirApp(estado, appid, { visible: true, nombre: ahora.nombre, tipo: ahora.tipo, precio: ahora.precio });
          continue;
        }
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
        comprable: ahora.comprable,
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
    const { nuevos, vistos, total, paginasLeidas } = await comentariosNuevos(
      estado.remgc.vistos ?? [],
      estado.remgc.total ?? null,
      limitador,
    );
    resumen.remgc = nuevos.length;
    registrar(`  RemGC: ${total} comentarios (${paginasLeidas} pag. leidas), ${nuevos.length} nuevos`);

    const appidsRemgc = [...new Set(nuevos.flatMap((c) => c.appids))];
    const info = appidsRemgc.length ? await consultarMuchos(appidsRemgc, limitador) : new Map();

    // Al retroceder paginas salen anuncios de juegos que YA se retiraron. Decir
    // "lo van a retirar" de algo que ya no existe es ruido: se registra y se calla.
    let yaFuera = 0;
    const anunciados = new Set();
    for (const com of nuevos) {
      for (const appid of com.appids) {
        if (anunciados.has(appid)) continue;
        anunciados.add(appid);

        const dato = info.get(appid);
        if (dato && !dato.visible) {
          yaFuera++;
          if (!estado.retirados[appid]) estado.retirados[appid] = new Date().toISOString();
          continue;
        }
        if (dato) escribirApp(estado, appid, dato);

        eventos.push(crearEvento({
          tipo: 'retirada_anunciada',
          appid,
          nombre: dato?.nombre ?? leerApp(estado, appid)?.nombre ?? '',
          app_type: dato?.tipo ?? leerApp(estado, appid)?.tipo ?? 'otro',
          precio: dato?.precio ?? leerApp(estado, appid)?.precio,
          fuente: 'remgc',
          anuncio: com.anuncio,
          confianza: 'confirmado',
        }));
      }
    }
    if (yaFuera > 0) registrar(`  RemGC: ${yaFuera} appids omitidos porque ya estan retirados`);
    estado.remgc = { vistos, total };
  } catch (e) {
    registrar(`  RemGC fallo: ${e.message}`);
  }

  // ---- 6. delistedgames.com: segundo agregador humano ---------------------------
  try {
    const arts = await articulosNuevos(estado.delisted?.vistos ?? [], limitador);
    resumen.delisted = arts.length;
    registrar(`  delistedgames: ${arts.length} articulos nuevos`);

    // el nombre y el precio no suelen estar en el estado si la app aun no se conoce
    const conAppid = arts.filter((a) => a.appid);
    const info = conAppid.length ? await consultarMuchos(conAppid.map((a) => a.appid), limitador) : new Map();

    for (const a of arts) {
      if (!a.appid) continue;
      const dato = info.get(a.appid);
      const conocida = leerApp(estado, a.appid);
      // mismo criterio que con RemGC: si ya no esta a la venta, no es un preaviso
      if (dato && !dato.visible) {
        if (!estado.retirados[a.appid]) estado.retirados[a.appid] = new Date().toISOString();
        continue;
      }
      // guardamos lo aprendido: si luego lo retiran, ya tendremos nombre y precio
      if (dato) escribirApp(estado, a.appid, dato);
      eventos.push(crearEvento({
        tipo: 'retirada_anunciada',
        appid: a.appid,
        nombre: dato?.nombre || conocida?.nombre || '',
        app_type: dato?.tipo ?? conocida?.tipo ?? 'otro',
        precio: dato?.precio ?? conocida?.precio,
        fuente: 'delistedgames',
        anuncio: a.url,
        detalle: a.titulo,
        confianza: 'confirmado',
      }));
    }
    estado.delisted = { vistos: [...arts.map((a) => a.url), ...(estado.delisted?.vistos ?? [])].slice(0, 200) };
  } catch (e) {
    registrar(`  delistedgames fallo: ${e.message}`);
  }

  // ---- 7. Avisos de los propios desarrolladores ---------------------------------
  // La fuente de mas valor: un estudio que anuncia "lo retiramos el dia X" da dias
  // de margen. No hay feed global, asi que se pregunta app por app con presupuesto
  // limitado y recorrido rotatorio.
  try {
    const senaladas = eventos.filter((e) => e.tipo === 'retirada_anunciada').map((e) => e.appid);
    const catalogo = Object.keys(estado.apps).map(Number);
    const { objetivos, cursor } = elegirObjetivos({
      senaladas,
      cambiadas: cambios.apps,
      catalogo,
      cursor: estado.anuncios?.cursor ?? 0,
      presupuesto: Number(process.env.PRESUPUESTO_ANUNCIOS ?? 120),
    });

    const yaAvisados = new Set(estado.anuncios?.avisados ?? []);
    let encontrados = 0;
    for (const appid of objetivos) {
      const avisos = await anunciosDe(appid, limitador).catch(() => []);
      for (const av of avisos) {
        if (yaAvisados.has(av.url)) continue;
        yaAvisados.add(av.url);
        encontrados++;
        const conocida = leerApp(estado, appid);
        eventos.push(crearEvento({
          tipo: 'retirada_anunciada',
          appid,
          nombre: conocida?.nombre ?? '',
          app_type: conocida?.tipo ?? 'otro',
          precio: conocida?.precio,
          fuente: 'desarrollador',
          anuncio: av.url,
          detalle: av.extracto,
          confianza: 'confirmado',
        }));
        registrar(`  AVISO DEL ESTUDIO ${appid}: ${av.titulo.slice(0, 70)}`);
      }
    }
    resumen.anuncios = { revisadas: objetivos.length, encontrados };
    registrar(`  anuncios: ${objetivos.length} apps revisadas, ${encontrados} avisos de retirada`);
    estado.anuncios = { cursor, avisados: [...yaAvisados].slice(-500) };
  } catch (e) {
    registrar(`  anuncios fallo: ${e.message}`);
  }

  // ---- 8. Curador "Games at risk of removal" ------------------------------------
  // La mejor fuente de preaviso: trae appid, precio y FECHA EXACTA de retirada.
  try {
    const fichas = await fichasRecientes(50, limitador);
    resumen.curador = fichas.length;
    registrar(`  curador: ${fichas.length} avisos con fecha`);

    for (const f of fichas) {
      const clave = `${f.appid}|${f.fecha_retirada ?? 'pronto'}`;
      const previa = estado.previstas[f.appid];

      // guardamos siempre la fecha para poder dar la ultima llamada mas adelante
      estado.previstas[f.appid] = {
        fecha: f.fecha_retirada,
        nombre: f.nombre,
        precio: f.precio,
        anuncio: f.anuncio,
        nota: f.nota,
        avisado: previa?.clave === clave ? previa.avisado : false,
        ultima_llamada: previa?.clave === clave ? previa.ultima_llamada : false,
        clave,
      };
      if (previa?.clave === clave && previa.avisado) continue;

      estado.previstas[f.appid].avisado = true;
      eventos.push(crearEvento({
        tipo: 'retirada_anunciada',
        appid: f.appid,
        nombre: f.nombre,
        app_type: leerApp(estado, f.appid)?.tipo ?? 'game',
        precio: f.precio,
        fuente: 'curador',
        anuncio: f.anuncio,
        detalle: f.nota,
        vence: f.fecha_retirada,
        confianza: 'confirmado',
      }));
    }
  } catch (e) {
    registrar(`  curador fallo: ${e.message}`);
  }

  // ---- 9. Ultima llamada: el plazo se acaba -------------------------------------
  // Sin esto, un aviso de "lo retiran el 21 de septiembre" llega en julio y se olvida.
  const AVISO_MS = 72 * 60 * 60 * 1000;
  for (const [appid, p] of Object.entries(estado.previstas)) {
    if (!p.fecha || p.ultima_llamada) continue;
    const restante = Date.parse(p.fecha) - Date.now();
    if (restante < 0 || restante > AVISO_MS) continue;

    p.ultima_llamada = true;
    const horas = Math.round(restante / 3600000);
    eventos.push(crearEvento({
      tipo: 'retirada_anunciada',
      appid: Number(appid),
      nombre: p.nombre,
      app_type: leerApp(estado, appid)?.tipo ?? 'game',
      precio: p.precio,
      fuente: 'ultima_llamada',
      anuncio: p.anuncio,
      detalle: `ULTIMA LLAMADA: lo retiran en ${horas} h`,
      vence: p.fecha,
      confianza: 'confirmado',
    }));
    registrar(`  ULTIMA LLAMADA ${appid} ${p.nombre}: ${horas} h`);
  }

  // ---- 10. Cerrar cursor --------------------------------------------------------
  if (cambios.actual) estado.cursor.changenumber = cambios.actual;
  estado.cursor.ultimo_ciclo = new Date().toISOString();
  estado.cursor.ventana_perdida = cambios.ventanaPerdida;

  return { eventos: deduplicar(eventos), resumen };
}
