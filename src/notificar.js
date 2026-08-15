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

const TITULOS = {
  retirado: 'Retirado de Steam',
  retirada_anunciada: 'Van a retirarlo de Steam',
  gratis_activo: 'Gratis para siempre',
  gratis_proximo: 'Pronto gratis',
  finde_gratis: 'Fin de semana gratis',
  revivido: 'Ha vuelto a Steam',
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
  const MAX_INDIVIDUALES = Number(process.env.MAX_INDIVIDUALES ?? 5);

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
      android: { priority: 'high', notification: { channel_id: ev.tipo, tag: ev.id } },
    });
    console.log(`  -> ${topicDe(ev)}: ${ev.tipo} ${ev.appid} ${ev.nombre}`);
  }

  // El resto va agrupado: con DLC, bandas sonoras y demos incluidos, notificar uno a
  // uno seria un bombardeo diario.
  if (resto.length > 0) {
    const avisos = resto.filter((e) => e.tipo === 'retirada_anunciada').length;
    const desglose = avisos > 0
      ? `${avisos} con retirada anunciada` + (resto.length > avisos ? `, ${resto.length - avisos} ya retirados` : '')
      : Object.entries(resto.reduce((a, e) => { a[e.app_type] = (a[e.app_type] ?? 0) + 1; return a; }, {}))
          .map(([t, n]) => `${n} ${t}`).join(', ');
    await enviar(token, proyecto, {
      topic: 'resumen',
      notification: { title: `${resto.length} avisos mas`, body: desglose },
      data: { tipo: 'resumen', total: String(resto.length), ids: resto.map((e) => e.id).join(',') },
      android: { priority: 'normal', notification: { channel_id: 'resumen', tag: 'resumen' } },
    });
    console.log(`  -> resumen: ${resto.length} eventos (${desglose})`);
  }

  const recordar = [...pendientes.map((e) => e.id), ...yaEnviados].slice(0, MAX_RECORDADOS);
  await writeFile(RUTA_NOTIFICADOS, JSON.stringify(recordar));
  console.log(`notificados ${pendientes.length} eventos`);
}

principal().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
