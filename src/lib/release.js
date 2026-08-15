// El estado (~200k apps) vive como asset de una Release fija, no en el repo.
//
// Si se commiteara cada 15 minutos, el historial crecería en megas cada día. Un
// asset de Release se sustituye in situ y no versiona nada.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const API = 'https://api.github.com';
const TAG = 'data-state';

const repo = () => process.env.GITHUB_REPOSITORY ?? 'mparmol/Removed_Steam_Games';
const token = () => {
  const t = process.env.GITHUB_TOKEN;
  if (!t) throw new Error('falta GITHUB_TOKEN');
  return t;
};

const cabeceras = (extra = {}) => ({
  Authorization: `Bearer ${token()}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'removed-steam-games',
  ...extra,
});

/** Devuelve la Release del estado, creandola si aun no existe. */
async function obtenerRelease() {
  const r = await fetch(`${API}/repos/${repo()}/releases/tags/${TAG}`, { headers: cabeceras() });
  if (r.status === 200) return await r.json();
  if (r.status !== 404) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);

  const c = await fetch(`${API}/repos/${repo()}/releases`, {
    method: 'POST',
    headers: cabeceras({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      tag_name: TAG,
      name: 'Estado del detector',
      body: 'Asset generado automaticamente. No editar a mano.',
      prerelease: true,
    }),
  });
  if (!c.ok) throw new Error(`no se pudo crear la release: ${c.status} ${(await c.text()).slice(0, 200)}`);
  return await c.json();
}

/** Descarga el asset a `ruta`. Devuelve false si aun no hay estado publicado. */
export async function descargarEstado(ruta, nombre = 'state.json.gz') {
  const release = await obtenerRelease();
  const asset = release.assets?.find((a) => a.name === nombre);
  if (!asset) return false;

  const r = await fetch(asset.url, { headers: cabeceras({ Accept: 'application/octet-stream' }), redirect: 'follow' });
  if (!r.ok) throw new Error(`descarga fallida: ${r.status}`);

  await mkdir(dirname(ruta), { recursive: true });
  await writeFile(ruta, Buffer.from(await r.arrayBuffer()));
  return true;
}

/** Sube (sustituyendo) el asset del estado. */
export async function subirEstado(ruta, nombre = 'state.json.gz') {
  const release = await obtenerRelease();

  const previo = release.assets?.find((a) => a.name === nombre);
  if (previo) {
    const d = await fetch(`${API}/repos/${repo()}/releases/assets/${previo.id}`, { method: 'DELETE', headers: cabeceras() });
    if (!d.ok && d.status !== 404) throw new Error(`no se pudo borrar el asset previo: ${d.status}`);
  }

  const cuerpo = await readFile(ruta);
  const subida = release.upload_url.replace(/\{.*$/, '');
  const s = await fetch(`${subida}?name=${encodeURIComponent(nombre)}`, {
    method: 'POST',
    headers: cabeceras({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(cuerpo.length) }),
    body: cuerpo,
  });
  if (!s.ok) throw new Error(`subida fallida: ${s.status} ${(await s.text()).slice(0, 200)}`);

  return cuerpo.length;
}
