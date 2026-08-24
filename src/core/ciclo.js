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
import { appidsYaAvisados } from './feed.js';

/**
 * Deja de verse: la unica transicion que significa "lo han quitado de la tienda".
 */
export const dejaDeVerse = (antes, ahora) => antes.visible && !ahora.visible;

/**
 * Deja de venderse con la ficha en pie (caso Anvillage).
 *
 * Las DOS observaciones tienen que tener la pagina publicada. `comprable` vale true
 * por definicion en los tipos que nunca se venden (demo, playtest, y el cajon 'otro'),
 * asi que compararlo contra una app que ya estaba invisible hace oscilar el valor en
 * cada pasada: 4.344 falsos "retirado" de tipo `otro` en nueve dias, los mismos
 * appids un dia tras otro.
 */
export const dejaDeVenderse = (antes, ahora) =>
  antes.visible && ahora.visible && antes.comprableConocido && antes.comprable && !ahora.comprable;

/** Un mismo appid no vuelve a dar preaviso hasta pasado este plazo. */
const REAVISO_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Registra que ya hemos avisado de este appid y dice si toca avisar.
 * Las fuentes humanas (RemGC, delistedgames) repiten el mismo juego en varios
 * mensajes y ademas editan los antiguos, asi que sin esto una sola retirada puede
 * notificarse tres o cuatro veces.
 */
function tocaAvisar(estado, appid) {
  const previo = estado.avisados?.[appid];
  if (previo && Date.now() - Date.parse(previo) < REAVISO_MS) return false;
  estado.avisados ??= {};
  estado.avisados[appid] = new Date().toISOString();
  return true;
}

/**
 * @param {object} estado  se MUTA con lo aprendido en el ciclo
 * @param {{registrar?: (msg:string)=>void}} opciones
 * @returns {Promise<{eventos: object[], resumen: object}>}
 */
export async function ejecutarCiclo(estado, { registrar = console.log } = {}) {
  const limitador = new Limitador(100);
  const eventos = [];
  const resumen = { pics: null, verificadas: 0, remgc: 0, promos: 0, gratis: 0 };

  // ---- 0. Sembrar el registro de avisados a partir del feed ya publicado --------
  if (!estado.avisados_migrado) {
    const previos = await appidsYaAvisados().catch(() => new Map());
    estado.avisados = { ...Object.fromEntries(previos), ...(estado.avisados ?? {}) };
    estado.avisados_migrado = true;
    registrar(`  sembrado el registro de avisados con ${previos.size} appids del archivo`);
  }

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
        return dejaDeVerse(antes, v) || dejaDeVenderse(antes, v);
      })
      .map((v) => v.appid);

    const confirmacion = sospechosos.length > 0 ? await confirmarRetirada(sospechosos, limitador) : new Map();

    // Steam marca en PICS las retiradas pedidas por el editor: es la senal mas fiable
    // que da, y aparece DIAS antes de que la ficha desaparezca de la tienda.
    let porEditor = new Set();
    if (sospechosos.length > 0) {
      porEditor = await pics.retiradasPorEditor(sospechosos).catch(() => new Set());
      const regionales = [...confirmacion.values()].filter((c) => !c.retirado && !c.soloEscaparate).length;
      registrar(`  ${sospechosos.length} sospechosos: ${porEditor.size} con flag de retirada del editor,` +
        ` ${regionales} bloqueo regional`);
    }

    for (const [appid, ahora] of vistos) {
      const antes = leerApp(estado, appid);
      const pendiente = estado.pendientes[appid];
      const conf = confirmacion.get(appid);

      // Flag `app_retired_publisher_request`: el editor ha PEDIDO la retirada.
      //
      // Antes esto solo forzaba `retirado: true` en la confirmacion por paises, con lo
      // que el caso caia en la rama de "ha cambiado la visibilidad"; como la ficha
      // seguia publicada no habia cambio y no se emitia NADA. Nova Slash (1896510) se
      // anuncio el 23 de agosto con el flag puesto y jamas llego al feed. Es
      // exactamente el preaviso que da valor a la app, asi que va por su propia rama.
      if (porEditor.has(appid)) {
        const enPie = conf ? conf.visibleEn.length > 0 : ahora.visible;
        registrar(`  ${appid}: RETIRADA PEDIDA POR EL EDITOR (${enPie ? 'ficha aun publicada' : 'ya fuera'})`);
        delete estado.pendientes[appid];
        if (tocaAvisar(estado, appid)) {
          eventos.push(crearEvento({
            tipo: enPie ? 'retirada_anunciada' : 'retirado',
            appid,
            nombre: ahora.nombre || antes?.nombre || '',
            app_type: ahora.tipo !== 'otro' ? ahora.tipo : antes?.tipo,
            precio: antes?.precio ?? ahora.precio,
            fuente: 'steam_editor',
            detalle: 'El editor ha pedido a Steam que lo retire',
            confianza: 'confirmado',
          }));
        }
        if (!enPie) estado.retirados[appid] = new Date().toISOString();
        escribirApp(estado, appid, {
          visible: ahora.visible,
          nombre: ahora.nombre || antes?.nombre || '',
          tipo: ahora.tipo !== 'otro' ? ahora.tipo : antes?.tipo,
          precio: ahora.precio,
          comprable: ahora.comprable,
        });
        continue;
      }

      // Desaparecido solo en algunos mercados: no es una retirada, pero interesa
      // saberlo. Va al feed con su propio tipo y nunca genera notificacion.
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
        if (!ahora.visible) {
          // deja constancia de que la retirada la vimos nosotros
          estado.retirados[appid] = new Date().toISOString();
          eventos.push(crearEvento({
            tipo: 'retirado',
            appid,
            nombre: ahora.nombre || pendiente.nombre,
            app_type: ahora.tipo !== 'otro' ? ahora.tipo : pendiente.app_type,
            precio: antes?.precio ?? pendiente.precio,
            fuente: 'pics',
            confianza: 'confirmado',
          }));
        } else {
          registrar(`  descartado falso positivo: ${appid} (retirado)`);
        }
        delete estado.pendientes[appid];
      } else if (antes && dejaDeVerse(antes, ahora)) {
        // Solo la DESAPARICION genera evento. El camino contrario ("ha vuelto") se
        // retiro del sistema: en la practica solo lo disparaban juegos sin estrenar
        // que acababan de publicar ficha, nunca un regreso de verdad.
        // el nombre se pierde cuando deja de ser visible: conservamos el que teniamos
        const nombre = ahora.nombre || antes.nombre;
        const app_type = ahora.tipo !== 'otro' ? ahora.tipo : antes.tipo;
        const precio = antes.precio;
        // transicion nueva: se emite provisional y queda pendiente de confirmar
        eventos.push(crearEvento({ tipo: 'retirado', appid, nombre, app_type, precio, fuente: 'pics', confianza: 'provisional' }));
        estado.pendientes[appid] = { tipo: 'retirado', nombre, app_type, precio, visto: new Date().toISOString() };
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
  //
  // Esta busqueda cubre tambien los juegos de pago rebajados al 100%, que es la forma
  // habitual de regalar un juego: Dokimon Quest (2019300, 14,79 € al -100%) salio aqui.
  // Lo que faltaba era el PLAZO, que es lo unico que de verdad importa en un regalo.
  try {
    const { appids } = await gratisAhora(limitador);
    const antes = new Set(estado.gratis_ahora ?? []);
    const nuevos = appids.filter((a) => !antes.has(a));
    resumen.gratis = appids.length;
    registrar(`  gratis ahora segun la tienda: ${appids.length} (${nuevos.length} nuevos)`);

    if (nuevos.length > 0) {
      const info = await consultarMuchos(nuevos, limitador);
      for (const appid of nuevos) {
        const dato = info.get(appid);
        eventos.push(crearEvento({
          tipo: 'gratis_activo',
          appid,
          nombre: dato?.nombre ?? leerApp(estado, appid)?.nombre ?? '',
          app_type: dato?.tipo ?? 'otro',
          precio: dato?.precio,
          fuente: 'tienda',
          // el plazo sale de `free_to_keep_ends` de la propia opcion de compra
          vence: dato?.gratisHasta ?? null,
          detalle: dato?.gratisHasta ? 'Anadelo a la cuenta antes del plazo y es tuyo para siempre' : null,
          confianza: 'confirmado',
        }));
        registrar(`  GRATIS ${appid} ${dato?.nombre ?? ''}${dato?.gratisHasta ? ` hasta ${dato.gratisHasta}` : ''}`);
      }
    }
    // Se apunta SIEMPRE, tambien cuando la lista se vacia: si no, una promo terminada
    // se queda pegada en el estado y ese juego no vuelve a avisar nunca.
    estado.gratis_ahora = appids;
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
        // Releer un mensaje editado hace que su appid vuelva a considerarse nuevo:
        // es lo que queremos (asi se pillan las ediciones que anaden un juego), pero
        // sin este filtro tambien repetiria los que ya avisamos.
        if (!tocaAvisar(estado, appid)) continue;

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
      if (!tocaAvisar(estado, a.appid)) continue;
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
        if (!tocaAvisar(estado, appid)) continue;
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

      // Los editores aplazan: Fenrir Banquet anunciaba retirada el 17 jul 2026 y un
      // mes despues seguia a la venta por 1,99 €. Mantener esa fecha como "vence"
      // enganaria al usuario y ademas descoloca el orden de proximas retiradas.
      const caducada = f.fecha_retirada && Date.parse(f.fecha_retirada) < Date.now();
      const detalle = caducada
        ? `${f.nota} (la fecha anunciada ya pasó y sigue a la venta)`
        : f.nota;

      estado.previstas[f.appid].avisado = true;
      // el curador trae fecha y precio exactos, asi que avisa aunque otra fuente ya
      // lo mencionara; pero deja constancia para que las otras no lo repitan despues
      estado.avisados ??= {};
      estado.avisados[f.appid] = new Date().toISOString();
      eventos.push(crearEvento({
        tipo: 'retirada_anunciada',
        appid: f.appid,
        nombre: f.nombre,
        app_type: leerApp(estado, f.appid)?.tipo ?? 'game',
        precio: f.precio,
        fuente: 'curador',
        anuncio: f.anuncio,
        detalle,
        vence: caducada ? null : f.fecha_retirada,
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
