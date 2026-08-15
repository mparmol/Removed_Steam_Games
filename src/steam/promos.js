// Deteccion de promociones gratuitas.
//
// Dos fuentes con papeles DISTINTOS, y esto no es opcional:
//
//  1. La busqueda de la tienda es la verdad de "gratis ahora mismo".
//  2. PICS es solo el PREAVISO de promos futuras.
//
// El motivo lo dio Deponia (214340): estaba gratis en vivo y su paquete NO aparecia
// en la ventana de PICS. Los starttime/expirytime se fijan cuando la promo se
// CONFIGURA (dias antes), y es entonces cuando el paquete cambia. Un detector que
// solo mirase PICS se pierde toda promo preconfigurada.

/** Paquetes con este billingtype son "free on demand" (gratis bajo demanda). */
const BILLINGTYPE_GRATIS = 12;

/**
 * Timestamps centinela que Steam reutiliza como plantilla en paquetes de demo.
 * En el spike salieron 7 paquetes con este mismo rango exacto, todos falsos positivos.
 */
const CENTINELA_INICIO = Date.UTC(2020, 5, 16, 16, 30) / 1000;

const aNumero = (v) => (v == null ? null : Number(v));
const aIso = (t) => (t ? new Date(Number(t) * 1000).toISOString() : null);

/**
 * Filtra los paquetes de PICS quedandose con promociones creibles.
 * @param {object[]} paquetes  packageinfo crudos
 * @returns {{packageid:number, tipo:'free_to_keep'|'finde_gratis', inicio:string|null, fin:string|null, apps:number[]}[]}
 */
export function promosDePaquetes(paquetes) {
  const salida = [];
  for (const p of paquetes) {
    if (p?.billingtype !== BILLINGTYPE_GRATIS) continue;

    const ext = p.extended ?? {};
    const inicio = aNumero(ext.starttime);
    const fin = aNumero(ext.expirytime);
    if (!inicio && !fin) continue;

    // Paquetes de demo desactivada: no son promociones.
    if (ext.deactivated_demo) continue;
    // Plantilla centinela reutilizada por Steam.
    if (inicio === CENTINELA_INICIO) continue;
    // Promocion ya terminada: no interesa.
    if (fin && fin * 1000 < Date.now()) continue;

    const esFinde = String(ext.freeweekend) === 'true' || ext.freeweekend === true;
    salida.push({
      packageid: Number(p.packageid),
      tipo: esFinde ? 'finde_gratis' : 'free_to_keep',
      inicio: aIso(inicio),
      fin: aIso(fin),
      apps: (p.appids ?? []).map(Number),
    });
  }
  return salida;
}

/**
 * Decide que promos guardadas deben avisarse ahora.
 *
 * Se llama en cada ciclo sobre el estado persistido, no solo sobre lo que PICS acaba
 * de decir: asi una promo vista hace tres dias dispara su aviso cuando toca.
 *
 * @param {object} promosGuardadas  mapa packageid -> promo con {avisado_proximo, avisado_inicio}
 * @param {number} ahoraMs
 */
export function promosQueTocanAvisar(promosGuardadas, ahoraMs = Date.now()) {
  const proximas = [];
  const empiezan = [];

  for (const promo of Object.values(promosGuardadas)) {
    const inicioMs = promo.inicio ? Date.parse(promo.inicio) : null;
    const finMs = promo.fin ? Date.parse(promo.fin) : null;

    if (finMs && finMs < ahoraMs) continue; // caducada

    // Preaviso: la conocemos y aun no ha empezado.
    if (inicioMs && inicioMs > ahoraMs && !promo.avisado_proximo) {
      proximas.push(promo);
    }
    // Arranque: ya ha empezado y no habiamos avisado.
    if (inicioMs && inicioMs <= ahoraMs && !promo.avisado_inicio) {
      empiezan.push(promo);
    }
  }
  return { proximas, empiezan };
}
