#!/usr/bin/env bash
# Varias pasadas de vigilancia dentro de UNA sola ejecucion de Actions.
#
# El cron de Actions no es puntual ni de lejos. Medido el 26 de agosto sobre 13
# ejecuciones seguidas de un cron '*/15': huecos de 40, 47, 47, 44, 31, 34, 63, 64,
# 49, 83, 53, 133 y 177 minutos. La mediana fue de 49 min y el peor hueco de casi
# tres horas, y ahi dentro cayo la retirada de Astrobuilder: el ciclo la detecto en
# 60 segundos, pero ese ciclo tardo dos horas en arrancar.
#
# La forma de no depender de la puntualidad del cron es que cada ejecucion CUBRA
# varias horas por su cuenta. Asi el cron solo tiene que acertar una vez cada
# DURACION, no cada 15 minutos, y el grupo de concurrencia encadena la siguiente.
#
# NO hay corte por hora. Lo hubo, para no hacer esperar al barrido de las 04:00 que
# comparte grupo de concurrencia, y salio mal: el 27 de agosto una ejecucion arranco
# a las 03:18 UTC, vio doce minutos hasta el corte, hizo UNA pasada y termino. Despues
# el cron no volvio a disparar en 3 h 22 min y nos quedamos ciegos, que es justo lo
# que las pasadas venian a evitar. Retrasar unas horas un barrido diario es inofensivo;
# perder tres horas de vigilancia no. El barrido espera su turno en la cola.
set -euo pipefail

DURACION_MIN="${DURACION_MIN:-180}"
INTERVALO_MIN="${INTERVALO_MIN:-15}"
# Tope DURO por pasada. Medido sobre 204 pasadas (17 ejecuciones, 25 oct - 1 nov):
# entre 5,2 y 5,5 min todas. El 30 de octubre la 790 se paso de los 200 min del job:
# alguna pasada se quedo colgada mas de media hora y Actions mato el job entero, sin
# log (un job cancelado no dispara `if: failure()`) y con PICS perdiendo la ventana
# en el hueco. Una pasada colgada debe costar una pasada, no la ejecucion.
# Con la ultima pasada arrancando como tarde en DURACION - INTERVALO, el job acaba
# como mucho en DURACION - INTERVALO + TOPE = 177 min: por debajo de los 200.
TOPE_PASADA_MIN="${TOPE_PASADA_MIN:-12}"

# Una pasada en su propio proceso, para poder cortarla con `timeout`. Ademas arregla
# un fallo silencioso: el `set -e` que habia dentro de `if ( ... )` NO hacia nada,
# porque bash ignora errexit en todo lo que forma parte de la condicion de un `if`.
# Si `cli.js watch` fallaba, se notificaba y publicaba igual y contaba como buena.
pasada_unica() {
  set -euo pipefail
  # Se vuelve a traer el feed en CADA pasada. Ademas de partir siempre de lo
  # publicado, deja `feedrepo` recien clonado: `feed-publicar.sh` crea una rama
  # huerfana y en la segunda pasada chocaria con la de la primera.
  bash scripts/feed-preparar.sh

  node src/cli.js watch --remoto

  # El notificador va ANTES de publicar el feed: deja constancia de lo enviado en
  # notificados.json, y publicando primero esa anotacion se perderia.
  if [ -n "${FCM_SERVICE_ACCOUNT:-}" ]; then
    node src/notificar.js 2>&1 | tee -a notificar.log
  fi

  bash scripts/feed-publicar.sh
}
export -f pasada_unica

ahora=$(date -u +%s)
fin=$(( ahora + DURACION_MIN * 60 ))

# La marca la deja `cli.js` cuando PICS pierde la ventana. Se borra al empezar para
# no arrastrar la de la ejecucion anterior.
rm -f .ventana-perdida

echo "== vigilancia hasta $(date -u -d "@${fin}" '+%H:%M:%S UTC') (pasadas cada ${INTERVALO_MIN} min) =="

pasada=0
ok=0
fallos=0
while :; do
  pasada=$(( pasada + 1 ))
  inicio=$(date -u +%s)
  echo ""
  echo "---- pasada ${pasada}  $(date -u '+%H:%M:%S UTC') ----"

  # UNA pasada que falla NO puede llevarse por delante la ejecucion entera. El 13 de
  # septiembre la 526 murio a los 141 minutos y, como el cron no volvio a disparar, el
  # sistema se quedo parado hora y media: en ese hueco se anuncio la retirada de Sun
  # Ultimate War y no se entero nadie. Perder una pasada cuesta 15 minutos; perder la
  # ejecucion cuesta lo que tarde el cron en acordarse, que hoy son horas.
  # `timeout` mata el grupo de procesos entero (node, git), no solo el bash hijo.
  if timeout --kill-after=30 "${TOPE_PASADA_MIN}m" bash -c pasada_unica; then
    ok=$(( ok + 1 ))
  else
    rc=$?
    fallos=$(( fallos + 1 ))
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
      motivo="cortada tras ${TOPE_PASADA_MIN} min sin terminar"
    else
      motivo="ha fallado (exit ${rc})"
    fi
    echo "AVISO: la pasada ${pasada} ${motivo}; se continua con la siguiente" | tee -a publicar.log
    # anotacion visible en el resumen del run aunque el job acabe en verde
    echo "::warning::pasada ${pasada} ${motivo}"
  fi

  # ¿cabe otra pasada entera antes del corte?
  siguiente=$(( inicio + INTERVALO_MIN * 60 ))
  if [ "$siguiente" -ge "$fin" ]; then
    echo ""
    echo "== fin: ${pasada} pasadas (${ok} bien, ${fallos} con fallo) =="
    break
  fi

  espera=$(( siguiente - $(date -u +%s) ))
  if [ "$espera" -gt 0 ]; then
    echo "esperando ${espera}s hasta la siguiente pasada"
    sleep "$espera"
  fi
done

# Si CUALQUIER pasada perdio la ventana de PICS hay que barrer, aunque las siguientes
# fueran bien: lo que se perdio en ese hueco no vuelve a aparecer por PICS.
if [ -f .ventana-perdida ] && [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "ventana_perdida=true" >> "$GITHUB_OUTPUT"
  echo "AVISO: alguna pasada perdio la ventana de PICS -> se encadena barrido"
fi

# El job solo se marca en rojo si NINGUNA pasada salio adelante. Con alguna buena, el
# feed esta publicado y al dia: avisar de un fallo transitorio solo entrena a ignorar
# los correos.
if [ "$ok" -eq 0 ]; then
  echo "ERROR: las ${pasada} pasadas han fallado" >&2
  exit 1
fi
if [ "$fallos" -gt 0 ]; then
  echo "hubo ${fallos} pasadas con fallo de ${pasada}, pero ${ok} salieron adelante"
fi
