#!/usr/bin/env bash
# Publica ./feedrepo en la rama `data` como UN SOLO commit.
#
# Se reescribe la rama en cada publicacion a proposito: con casi 100 publicaciones al
# dia, conservar historial haria crecer el repo sin aportar nada (el historial util
# son los propios ficheros mensuales del feed).
#
# El push se reintenta. El 13 de septiembre este paso fallo con exit 1 y sin dejar
# rastro: el paso que publica el log estaba ANTES en el workflow, asi que no llego a
# dispararse, y las anotaciones de Actions solo decian "Process completed with exit
# code 1". Se perdio lo que el barrido habia encontrado ese dia, y encima `notificar`
# corre antes que esto: los avisos salieron al movil pero nunca llegaron al feed.
set -euo pipefail

INTENTOS="${INTENTOS_PUSH:-3}"
LOG="${LOG_PUBLICAR:-publicar.log}"

cd feedrepo

# .nojekyll evita que Pages ignore ficheros que empiecen por guion bajo
touch .nojekyll

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

git add -A
if git diff --cached --quiet; then
  echo "sin cambios en el feed: no se publica"
  exit 0
fi

# nombre nuevo en cada intento: `--orphan` falla si la rama ya existe
rama="publicacion-$(date -u +%s)-$$"
git checkout -q --orphan "$rama"
git add -A
git commit -q -m "feed: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

for intento in $(seq 1 "$INTENTOS"); do
  if salida=$(git push -f origin "${rama}:data" 2>&1); then
    echo "feed publicado en la rama data (intento ${intento})"
    exit 0
  fi
  echo "intento ${intento}/${INTENTOS} fallido:" | tee -a "../${LOG}"
  echo "$salida" | tee -a "../${LOG}"
  sleep $(( intento * 5 ))
done

# Ultimo recurso para dejar rastro: si lo que falla es empujar a `data`, el log
# tampoco se va a poder publicar ahi. El resumen del job no depende de git.
{
  echo "## Fallo al publicar el feed"
  echo ''
  echo '```'
  echo "$salida"
  echo '```'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

echo "ERROR: no se pudo publicar el feed tras ${INTENTOS} intentos" >&2
exit 1
