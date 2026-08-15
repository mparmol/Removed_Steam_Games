#!/usr/bin/env bash
# Publica ./feedrepo en la rama `data` como UN SOLO commit.
#
# Se reescribe la rama en cada publicacion a proposito: con 96 ejecuciones al dia,
# conservar historial haria crecer el repo sin aportar nada (el historial util son
# los propios ficheros mensuales del feed).
set -euo pipefail

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

git checkout -q --orphan publicacion
git add -A
git commit -q -m "feed: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push -q -f origin publicacion:data

echo "feed publicado en la rama data"
