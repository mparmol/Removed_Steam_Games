#!/usr/bin/env bash
# Trae el feed publicado a ./feedrepo para poder anadirle los eventos de este ciclo.
# Si la rama `data` aun no existe, la crea vacia.
set -euo pipefail

REMOTO="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"

rm -rf feedrepo
mkdir -p feedrepo
cd feedrepo
git init -q
git remote add origin "$REMOTO"

if git fetch --depth 1 origin data 2>/dev/null; then
  git checkout -q FETCH_HEAD -- . 2>/dev/null || true
  echo "feed previo recuperado de la rama data"
else
  echo "la rama data aun no existe: se creara"
fi

mkdir -p feed
