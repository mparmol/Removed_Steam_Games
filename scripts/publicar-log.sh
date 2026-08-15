#!/usr/bin/env bash
# Publica un log en la rama `data` bajo logs/.
#
# Los logs de Actions requieren autenticacion incluso en repos publicos (403), asi
# que para poder diagnosticar fallos de compilacion desde fuera se copian aqui, que
# es contenido publico servido por Pages y raw.githubusercontent.
set -euo pipefail

FICHERO="$1"
NOMBRE="${2:-build}"
REMOTO="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"

rm -rf logrepo
git clone -q --depth 1 --branch data "$REMOTO" logrepo
mkdir -p logrepo/logs

# solo la cola: los logs de Gradle son enormes y lo util esta al final
tail -c 200000 "$FICHERO" > "logrepo/logs/${NOMBRE}.log"

cd logrepo
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
git commit -q -m "log: ${NOMBRE} $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push -q origin HEAD:data

echo "log publicado en logs/${NOMBRE}.log"
