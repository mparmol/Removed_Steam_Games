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
# Hay un tope deliberado: el trabajo se corta antes del barrido nocturno, que
# comparte grupo de concurrencia y se quedaria esperando.
set -euo pipefail

DURACION_MIN="${DURACION_MIN:-180}"
INTERVALO_MIN="${INTERVALO_MIN:-15}"
# Hora UTC a la que hay que haber terminado para no bloquear el barrido de las 04:00
CORTE_UTC="${CORTE_UTC:-03:30}"

ahora=$(date -u +%s)
fin=$(( ahora + DURACION_MIN * 60 ))

# el corte de esta noche: si ya paso, el de manana
corte=$(date -u -d "today ${CORTE_UTC}" +%s)
[ "$corte" -le "$ahora" ] && corte=$(date -u -d "tomorrow ${CORTE_UTC}" +%s)
[ "$corte" -lt "$fin" ] && fin=$corte

echo "== vigilancia hasta $(date -u -d "@${fin}" '+%H:%M:%S UTC') (pasadas cada ${INTERVALO_MIN} min) =="

pasada=0
while :; do
  pasada=$(( pasada + 1 ))
  inicio=$(date -u +%s)
  echo ""
  echo "---- pasada ${pasada}  $(date -u '+%H:%M:%S UTC') ----"

  # Se vuelve a traer el feed en CADA pasada. Ademas de partir siempre de lo
  # publicado, deja `feedrepo` recien clonado: `feed-publicar.sh` crea una rama
  # huerfana `publicacion` y en la segunda pasada chocaria con la de la primera.
  bash scripts/feed-preparar.sh

  node src/cli.js watch --remoto

  # El notificador va ANTES de publicar el feed: deja constancia de lo enviado en
  # notificados.json, y publicando primero esa anotacion se perderia.
  if [ -n "${FCM_SERVICE_ACCOUNT:-}" ]; then
    set -o pipefail
    node src/notificar.js 2>&1 | tee -a notificar.log
  fi

  bash scripts/feed-publicar.sh

  # ¿cabe otra pasada entera antes del corte?
  siguiente=$(( inicio + INTERVALO_MIN * 60 ))
  if [ "$siguiente" -ge "$fin" ]; then
    echo ""
    echo "== fin: ${pasada} pasadas =="
    break
  fi

  espera=$(( siguiente - $(date -u +%s) ))
  if [ "$espera" -gt 0 ]; then
    echo "esperando ${espera}s hasta la siguiente pasada"
    sleep "$espera"
  fi
done
