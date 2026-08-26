#!/usr/bin/env node
// Envio a Firebase Cloud Messaging (HTTP v1) por topics.
//
// Se publica por topic y no por dispositivo: asi la app decide a que se suscribe y
// silenciar una categoria (p. ej. DLC retirados) evita el trafico en ORIGEN, en vez
// de recibirlo y descartarlo en el movil.
//
// Requiere el secret FCM_SERVICE_ACCOUNT con el JSON de la cuenta de servicio.

import { readFile, writeFile } from 'node:fs/promises';
import { createSign } from 'node:crypto';
import { join } from 'node:path';

import { esUrgente, topicDe, SOLO_FEED } from './core/eventos.js';

const DIR_FEED = process.env.DIR_FEED ?? 'data/feed';
const RUTA_NOTIFICADOS = join(DIR_FEED, 'notificados.json');
const MAX_RECORDADOS = 3000;

const base64url = (b) => Buffer.from(b).toString('base64url');

/** Token OAuth a partir de la cuenta de servicio (JWT firmado con RS256). */
async function conseguirToken(cuenta) {
  const ahora = Math.floor(Date.now() / 1000);
  const cabecera = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const cuerpo = base64url(JSON.stringify({
    iss: cuenta.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: ahora,
    exp: ahora + 3600,
  }));

  const firma = createSign('RSA-SHA256').update(`${cabecera}.${cuerpo}`).sign(cuenta.private_key, 'base64url');
  const jwt = `${cabecera}.${cuerpo}.${firma}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!r.ok) throw new Error(`OAuth ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()).access_token;
}

/** Para que el resumen diga "12 DLC" y no "12 dlc". */
const ETIQUETAS_CONTENIDO = {
  game: 'juegos', dlc: 'DLC', music: 'bandas sonoras', demo: 'demos',
  playtest: 'playtests', video: 'vídeos', application: 'programas', otro: 'otros',
};

const TITULOS = {
  retirado: 'Retirado de Steam',
  retirada_anunciada: 'Van a retirarlo de Steam',
  gratis_activo: 'Gratis para siempre',
  gratis_proximo: 'Pronto gratis',
  finde_gratis: 'Fin de semana gratis',
  no_comprable: 'Ya no se puede comprar',
};

function cuerpoDe(ev) {
  const nombre = ev.nombre || `appid ${ev.appid}`;
  if (ev.tipo === 'gratis_activo') {
    return ev.vence ? `${nombre} — reclamalo antes del ${new Date(ev.vence).toLocaleString('es-ES')}` : `${nombre} — reclamalo ya`;
  }
  const precio = ev.precio ? ` (costaba ${ev.precio})` : '';
  if (ev.tipo === 'retirada_anunciada') return `${nombre}${precio} — ultima oportunidad para comprarlo`;
  if (ev.tipo === 'retirado') return `${nombre}${precio} — ya no se puede comprar`;
  return nombre;
}

async function enviar(token, proyecto, mensaje) {
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${proyecto}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: mensaje }),
  });
  if (!r.ok) throw new Error(`FCM ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return await r.json();
}

const leerJson = async (ruta, pordefecto) => {
  try { return JSON.parse(await readFile(ruta, 'utf8')); } catch { return pordefecto; }
};

async function principal() {
  const crudo = process.env.FCM_SERVICE_ACCOUNT;
  if (!crudo) {
    console.log('sin FCM_SERVICE_ACCOUNT: no se notifica');
    return;
  }
  const cuenta = JSON.parse(crudo);

  const eventos = await leerJson(join(DIR_FEED, 'latest.json'), []);
  const yaEnviados = new Set(await leerJson(RUTA_NOTIFICADOS, []));

  // Tras un arranque en frio no se notifica nada (seria el historico entero de golpe),
  // asi que se manda un unico aviso de puesta en marcha: sirve para comprobar que la
  // cadena Actions -> FCM -> movil funciona de verdad.
  const marcaFrio = join(DIR_FEED, 'arranque.json');
  const frio = await leerJson(marcaFrio, null);
  // `enviado` marca que ya se mando: sin esta comprobacion el saludo se repetiria
  // en cada ciclo, porque el objeto de "ya enviado" tambien es truthy.
  if (frio && !frio.enviado) {
    const token0 = await conseguirToken(cuenta);
    await enviar(token0, cuenta.project_id, {
      topic: 'resumen',
      notification: {
        title: 'Vigilancia en marcha',
        body: `${frio.eventos} avisos cargados. A partir de ahora solo lo nuevo.`,
      },
      data: { tipo: 'arranque', total: String(frio.eventos) },
      android: { priority: 'normal', notification: { channel_id: 'resumen_v2' } },
    });
    await writeFile(marcaFrio, JSON.stringify({ enviado: new Date().toISOString() }));
    console.log('aviso de puesta en marcha enviado');
    return;
  }
  // los bloqueos regionales se consultan en la app, no interrumpen nunca
  const pendientes = eventos.filter((e) => !yaEnviados.has(e.id) && !SOLO_FEED.has(e.tipo));

  if (pendientes.length === 0) {
    console.log('nada nuevo que notificar');
    return;
  }
  console.log(`${pendientes.length} eventos pendientes de notificar`);

  const token = await conseguirToken(cuenta);
  const proyecto = cuenta.project_id;

  // Tope de notificaciones individuales por ciclo. Sin esto, una tanda del curador
  // (que puede traer 20 avisos de golpe) vacia la bateria y entrena al usuario a
  // ignorar la app, que es justo lo contrario de lo que queremos.
  // Un aviso de retirada nunca debe quedar sepultado en el resumen: a veces adelantan
  // el borrado respecto a la fecha anunciada, asi que lo que importa es enterarse ya.
  const MAX_INDIVIDUALES = Number(process.env.MAX_INDIVIDUALES ?? 10);

  const prioridad = (e) =>
    (e.fuente === 'ultima_llamada' ? 0 : e.tipo === 'gratis_activo' ? 1 : e.vence ? 2 : 3);

  const urgentesTodos = pendientes.filter(esUrgente).sort((a, b) => prioridad(a) - prioridad(b));
  const urgentes = urgentesTodos.slice(0, MAX_INDIVIDUALES);
  const resto = [...urgentesTodos.slice(MAX_INDIVIDUALES), ...pendientes.filter((e) => !esUrgente(e))];

  // Los urgentes interrumpen: uno a uno y con sus enlaces de accion.
  for (const ev of urgentes) {
    await enviar(token, proyecto, {
      topic: topicDe(ev),
      notification: { title: TITULOS[ev.tipo] ?? ev.tipo, body: cuerpoDe(ev) },
      data: {
        id: ev.id,
        tipo: ev.tipo,
        appid: String(ev.appid),
        nombre: ev.nombre ?? '',
        app_type: ev.app_type,
        vence: ev.vence ?? '',
        steam: ev.enlaces.steam ?? '',
        steamdb: ev.enlaces.steamdb ?? '',
        allkeyshop: ev.enlaces.allkeyshop ?? '',
        anuncio: ev.enlaces.anuncio ?? '',
      },
      // el sufijo de generacion tiene que coincidir con Canales.GEN de la app:
      // Android no deja reconfigurar un canal existente, asi que se estrenan ids
      android: { priority: 'high', notification: { channel_id: `${ev.tipo}_v2`, tag: ev.id } },
    });
    console.log(`  -> ${topicDe(ev)}: ${ev.tipo} ${ev.appid} ${ev.nombre}`);
  }

  // El resto va agrupado: con DLC, bandas sonoras y demos incluidos, notificar uno a
  // uno seria un bombardeo diario.
  //
  // Y va agrupado POR TIPO DE CONTENIDO, a un topic por tipo. Antes era un unico
  // resumen al topic `resumen`, que contaba TODO: con los DLC silenciados en la app
  // seguia llegando "38 avisos mas", y al abrirla no habia nada porque la lista si los
  // filtraba. Un aviso que lleva a una pantalla vacia es peor que no avisar.
  const porTipo = new Map();
  for (const ev of resto) {
    if (!porTipo.has(ev.app_type)) porTipo.set(ev.app_type, []);
    porTipo.get(ev.app_type).push(ev);
  }

  for (const [appType, lote] of porTipo) {
    const avisos = lote.filter((e) => e.tipo === 'retirada_anunciada').length;
    const desglose = avisos > 0
      ? `${avisos} con retirada anunciada` + (lote.length > avisos ? `, ${lote.length - avisos} ya retirados` : '')
      : `${lote.length} ${ETIQUETAS_CONTENIDO[appType] ?? appType}`;
    await enviar(token, proyecto, {
      topic: `resumen_${appType}`,
      notification: { title: `${lote.length} avisos mas`, body: desglose },
      // FCM corta en 4 KB: con 490 eventos la lista completa de ids son ~8 KB y la
      // peticion entera falla. Van solo unos pocos; el resto se ve en el feed.
      data: { tipo: 'resumen', app_type: appType, total: String(lote.length), ids: lote.slice(0, 20).map((e) => e.id).join(',') },
      android: { priority: 'normal', notification: { channel_id: 'resumen_v2', tag: `resumen_${appType}` } },
    });
    console.log(`  -> resumen_${appType}: ${lote.length} eventos (${desglose})`);
  }

  const recordar = [...pendientes.map((e) => e.id), ...yaEnviados].slice(0, MAX_RECORDADOS);
  await writeFile(RUTA_NOTIFICADOS, JSON.stringify(recordar));
  console.log(`notificados ${pendientes.length} eventos`);
}

principal().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
