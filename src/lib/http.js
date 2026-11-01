// Cliente HTTP con limitador de ritmo y reintentos.
//
// El limite de Steam medido en el spike es de ~120 peticiones por ventana de ~5 min
// y POR IP, con independencia de la velocidad a la que se lancen: en local saltó el
// 429 a las 123 peticiones (37 s) y desde un runner de GitHub a las 117 (13 s).
// Por eso el limitador cuenta peticiones en una ventana deslizante, no peticiones/segundo.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export class Limitador {
  /**
   * @param {number} maxPeticiones  cupo por ventana (100 = margen sobre las ~120 reales)
   * @param {number} ventanaMs      duracion de la ventana deslizante
   */
  constructor(maxPeticiones = 100, ventanaMs = 5 * 60 * 1000) {
    this.max = maxPeticiones;
    this.ventana = ventanaMs;
    this.sellos = [];
  }

  async esperarTurno() {
    for (;;) {
      const ahora = Date.now();
      this.sellos = this.sellos.filter((t) => ahora - t < this.ventana);
      if (this.sellos.length < this.max) {
        this.sellos.push(ahora);
        return;
      }
      // esperamos a que caduque el sello mas antiguo (+250 ms de colchon)
      const espera = this.ventana - (ahora - this.sellos[0]) + 250;
      await dormir(espera);
    }
  }
}

export const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Tope por intento, cabeceras y cuerpo incluidos. Sin el, `fetch` espera lo que dicte
 * undici, que son 5 min para las cabeceras y otros 5 para el cuerpo: con 4 intentos
 * y ~130 peticiones por pasada, una red atascada convertia una pasada de 5 min en
 * horas. El 30 de octubre la 790 se paso del limite del job (200 min) sin dejar log.
 * Lo mas lento que se pide son los lotes de 200 apps de GetItems: segundos, no minutos.
 */
const TIMEOUT_MS = 60000;

/**
 * GET con reintentos. Trata 429, 5xx y los timeouts como recuperables con backoff
 * exponencial.
 * @param {string} url
 * @param {{limitador?: Limitador, intentos?: number, headers?: object, comoTexto?: boolean, timeoutMs?: number}} opciones
 */
export async function pedir(url, opciones = {}) {
  const { limitador, intentos = 4, headers = {}, comoTexto = false, timeoutMs = TIMEOUT_MS } = opciones;

  let ultimoError = null;
  for (let intento = 0; intento < intentos; intento++) {
    if (limitador) await limitador.esperarTurno();

    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 200) {
        // el cuerpo tambien va bajo la misma senal: dentro del try para que un
        // cuerpo atascado se reintente igual que una conexion atascada
        return comoTexto ? await res.text() : await res.json();
      }
    } catch (e) {
      ultimoError = e;
      await dormir(1000 * 2 ** intento);
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      ultimoError = new Error(`HTTP ${res.status} en ${url.slice(0, 120)}`);
      // ante un 429 el cupo esta agotado: agotamos tambien el limitador local
      // para no seguir gastando intentos a ciegas contra la misma ventana
      if (res.status === 429 && limitador) {
        limitador.sellos = new Array(limitador.max).fill(Date.now() - limitador.ventana * 0.5);
      }
      await dormir(res.status === 429 ? 30000 : 1000 * 2 ** intento);
      continue;
    }

    // 4xx distinto de 429: no se arregla reintentando
    throw new Error(`HTTP ${res.status} en ${url.slice(0, 120)}`);
  }
  throw ultimoError ?? new Error(`fallo tras ${intentos} intentos: ${url.slice(0, 120)}`);
}
