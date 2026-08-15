# Steam Removal Watch

Get a notification when a Steam game is **about to be pulled**, when it **has just been pulled**,
or when something becomes **free to keep**.

No server: detection runs on GitHub Actions, the feed is served by GitHub Pages, and notifications go
through Firebase Cloud Messaging. The Android app just reads a public JSON file — no accounts, no login,
no personal data anywhere.

## The point: advance warning

Knowing that a game *was* removed is archaeology. Knowing it *will be* removed is what lets you buy it in
time, so most of the effort goes into warning sources:

| Source | What it adds | Cost per cycle |
|---|---|---|
| [Games at risk of removal](https://store.steampowered.com/curator/31857481-Games-at-risk-of-removal/) curator | Exact removal date and current price | 1 request |
| [RemGC thread](https://steamcommunity.com/groups/RemGC/discussions/9/1736595131052961774/) | Human curation, catches what others miss | 2 requests |
| [delistedgames.com](https://delistedgames.com/) | Second aggregator, days of lead time | 1 request |
| Developer announcements | The primary source, but there is no global feed | ~120 apps, rotating |

Warnings fire **the moment they are spotted** — publishers sometimes bring a removal forward, so waiting is
not an option. A second *last call* notification fires when fewer than 72 hours remain.

**There is no global feed of Steam developer announcements.** The event calendar returns 14 events in 12
hours without a session (it is personalised), and the store news feed is just Valve's own blog. So
announcements are polled app by app, on a budget, with a priority queue: whatever a human source just
flagged, then whatever just changed in PICS, then a rotating sweep of the rest.

## Removal detection

| What | How | Latency |
|---|---|---|
| Just removed | PICS flags candidates → `IStoreBrowseService/GetItems` confirms | 15-40 min |
| Free right now | Store search with `specials=1&maxprice=free` | 15-40 min |
| Free soon | PICS packages with `billingtype 12` and a time window | days ahead |

### Four things that are not obvious

**`visible` is relative to the country.** Querying only from Spain, 4 of 7 removal candidates turned out to
be region blocks: Earth:Revival and カラオケJOYSOUND are alive in JP, Snowbreak and BSide in CN. A 57% false
positive rate. Even the store page 302 redirect is region-dependent. Candidates are now confirmed against
ES, US, JP and CN, and only count as removed if invisible in all of them. Region blocks get their own feed
entry and never trigger a push.

**Price has to be captured before removal.** Once a game is gone, Steam returns no price through any
endpoint. The last known price is stored per app so alerts can say what it used to cost.

**PICS fails silently.** Its history window is ~7,200 changenumbers (~9.5 h), and stepping outside it does
not raise an error: it returns `{appChanges: [], packageChanges: []}`, indistinguishable from "nothing
changed". The gap is checked against a threshold before the result is trusted, and a full sweep is chained
if it is exceeded.

**The catalogue can be enumerated after all.** `ISteamApps/GetAppList` is dead (404 on every version) and
`IStoreService/GetAppList` demands an API key, but `IStoreQueryService/Query` works without one: 1,000 ids
per request over ~304,000 records. That is ~305 requests instead of brute-forcing 5.2M appids.

## Steam rate limits

Measured: **~120 requests per ~5 min window, per IP**, regardless of how fast they are sent. A full pass over
the catalogue costs ~1 h from a single IP. Since every Actions job gets a fresh IP, sweeps are sharded and
drop to minutes.

## Usage

```bash
npm ci
npm test                      # 12 tests, no network
npm run test:integracion      # 8 tests against Steam

node src/cli.js watch --dry-run    # full cycle, writes nothing
node src/cli.js estado             # what is currently stored
```

Commands: `watch`, `sweep --shard N --of M`, `bootstrap --shard N --of M`, `fusionar --entradas dir`,
`estado`. With `--remoto`, state is read from and written to the `data-state` release instead of `.data/`.

## Setup

1. Run **Bootstrap del catalogo** once, by hand. Without a prior snapshot there is nothing to compare
   against, so removals cannot be detected. Warning sources work without it.
2. Settings → Pages → serve from the `data` branch, root folder.
3. Secret `FCM_SERVICE_ACCOUNT` with the Firebase service account JSON. Until it exists everything works
   except sending notifications, which skips itself.
4. The APK is an artifact of the **Compilar APK** workflow.

## Layout

```
src/steam/      pics, store (GetItems), promos
src/sources/    curator, remgc, delisted, anuncios
src/core/       estado, eventos, feed, ciclo
src/notificar.js  FCM delivery by topic
android/        Kotlin + Compose app
spike/          throwaway scripts from the feasibility research
```

State (~200k apps) lives as a release asset rather than in the repo: committing it every 15 minutes would
add megabytes of history daily. The feed goes to the orphan `data` branch, rewritten as a single commit on
every publish.

## Notification design

Topics, not devices: unsubscribing from a category stops the traffic at the source. Urgent events
(free-to-keep, announced removals, removed games) arrive individually, capped at 10 per cycle and ordered
last-call first; everything else is grouped into one digest. A cold start publishes to the feed but sends
nothing, since it would otherwise deliver the entire backlog at once.
