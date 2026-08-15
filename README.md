# Juegos retirados de Steam

Avisa por notificación cuando un juego **va a desaparecer** de Steam, cuando **acaba de desaparecer**,
o cuando algo se pone **gratis para siempre**.

Sin servidor: la detección corre en GitHub Actions, el feed lo sirve GitHub Pages y las notificaciones
van por Firebase Cloud Messaging. La app Android solo lee un JSON público — no hay cuentas, ni login,
ni datos personales en ninguna parte.

## Cómo detecta

| Qué | Cómo | Latencia |
|---|---|---|
| Retirada anunciada | Hilo [RemGC](https://steamcommunity.com/groups/RemGC/discussions/9/1736595131052961774/) del grupo Removed Games Collectors | 15-40 min desde que se publica |
| Retirada consumada | PICS marca candidatos → `IStoreBrowseService/GetItems` confirma `visible: false` | 15-40 min |
| Gratis ahora | Búsqueda de la tienda con `specials=1&maxprice=free` | 15-40 min |
| Gratis próximamente | Paquetes de PICS con `billingtype 12` y ventana temporal | días de antelación |

### Tres cosas que no son obvias

**PICS no ve las promociones gratuitas preconfiguradas.** Los `starttime`/`expirytime` de un paquete se
fijan cuando la promo se *configura*, que puede ser días antes de empezar, y es entonces cuando el paquete
cambia. Se comprobó con Deponia: estaba gratis en vivo y no aparecía en la ventana de PICS. Por eso la
fuente de verdad de "gratis ahora" es la búsqueda de la tienda, y PICS solo sirve de preaviso.

**PICS falla en silencio.** Su ventana de histórico es de ~7.200 changenumbers (~9,5 h), y al salirte de
ella no da error: devuelve `{appChanges: [], packageChanges: []}`, indistinguible de "no ha cambiado nada".
Por eso se compara el hueco contra un umbral antes de fiarse del resultado, y si se pasa se encadena un
barrido completo.

**El catálogo ya no se puede enumerar gratis.** `ISteamApps/GetAppList` da 404 en todas sus versiones e
`IStoreService/GetAppList` exige API key. El universo se construye por fuerza bruta sobre el espacio de
appids (solo ~4% está visible: unas 200.000 apps de 5,2M).

## Límites de Steam

Medido: **~120 peticiones por ventana de ~5 min y por IP**, con independencia de la velocidad. Una vuelta
completa al catálogo cuesta ~1 h desde una sola IP. Como cada job de Actions estrena IP, el barrido se
reparte en shards y baja a minutos.

## Uso

```bash
npm ci
npm test                      # 12 pruebas, sin red
npm run test:integracion      # 6 pruebas contra Steam

node src/cli.js watch --dry-run    # ciclo completo sin escribir nada
node src/cli.js estado             # qué hay guardado
```

Comandos: `watch`, `sweep --shard N --of M`, `bootstrap --shard N --of M`, `fusionar --entradas dir`,
`estado`. Con `--remoto` el estado se lee y se escribe en la Release `data-state` en vez de en `.data/`.

## Puesta en marcha

1. Fusionar a `main` (los crons solo se ejecutan desde la rama por defecto).
2. Lanzar **Bootstrap del catálogo** a mano. Sin catálogo previo, `watch` no tiene con qué comparar.
3. Settings → Pages → servir desde la rama `data`, carpeta raíz.
4. Secret `FCM_SERVICE_ACCOUNT` con el JSON de la cuenta de servicio de Firebase. Mientras no exista,
   todo funciona salvo el envío de notificaciones, que se salta solo.
5. El APK sale como artefacto del workflow **Compilar APK**.

## Estructura

```
src/steam/      pics, store (GetItems), promos
src/sources/    remgc
src/core/       estado, eventos, feed, ciclo
src/notificar.js  envío a FCM por topics
android/        app Kotlin + Compose
spike/          scripts desechables de la investigación previa
```

El estado (~200k apps) vive como asset de una Release, no en el repo: commitearlo cada 15 minutos
añadiría megas al historial cada día. El feed va a la rama huérfana `data`, reescrita como un único
commit en cada publicación.
