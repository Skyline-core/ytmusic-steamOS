# Propuesta: carátulas offline (solo descargas)

Estado: **aparado** (2026-07-14).  
Código revertido a `f8af427` tras notar lentitud. No reaplicar el enfoque amplio sin las restricciones de abajo.

## Problema

Con canciones Premium descargadas y sin internet, la portada se rompe:

- El audio vive en IndexedDB `yt-player-local-media` (cifrado).
- La portada **no** es un blob en ese store: YTM la deja en la **caché HTTP de Chromium** al descargar (aunque no se haya reproducido).
- Decky / MPRIS / overlays Deck piden URLs CDN (`ggpht` / `ytimg`); fuera del WebEngine o con URL upscaled → miss offline.

## Qué se intentó (y se revirtió)

- `ytmusic_decky/art_cache.py` + `GET/PUT /api/v1/art/{videoId}` + `GET/POST /api/v1/downloads`
- Bridge: detectar descargas por IDB, exportar JPEG al companion, reescribir `albumArt` local, rescate de `<img>` offline
- Pruebas OK en API (`/art/yPFZu_-PbyM`, `/song` con URL local), pero la app se sintió lenta

## Causas probables de lentitud

1. **`getAll()` del object store `media`** — chunks cifrados grandes; no hace falta para saber `videoId`.
2. Sync frecuente (arranque, online/offline, visibility, ~cada poll×8).
3. Hasta 12 uploads de arte por sync (`force-cache` / canvas / `PUT`).
4. `patchVisibleOfflineThumbs` reescribiendo imgs en el poll.
5. Listener global `error` (capture) + `confirmCompanionArt` en cada `setHeroArt`.

## Enfoque recomendado al retomar: A + B

### A — Detección ligera

- Solo leer store **`index`** de `yt-player-local-media*` (nunca `media`).
- Sync: 1× al arrancar si `!navigator.onLine`, al abrir `FEmusic_offline`, o al completar una descarga — **no** en el poll caliente.
- Sembrar IDs desde companion `GET /downloads` (lista en disco) sin barrer IDB completo.

### B — Export lazy

- Subir portada al companion **solo** para la pista actual (o la visible) cuando:
  - es descarga, y
  - falla CDN / `naturalWidth === 0`, o estamos offline.
- Obtener bytes con `fetch(url, { cache: 'force-cache' })` o canvas desde `<img>` ya pintada (misma origen/caché que YTM).
- No hacer upscale de URL offline (cambia la clave de caché HTTP).

### Companion (Decky / MPRIS)

- Mantener almacén en disco `session/covers/{videoId}.*` **solo** para descargas.
- `rewrite_song` / cola: URL local **solo si** existe fichero.
- `GET /art/{id}`: servir fichero; **no** descargar del CDN en Python de forma indiscriminada.
- Opcional: `GET /downloads` para seed offline rápido.

### Evitar

- `getAll('media')`
- Reescribir todas las thumbs de la UI en cada tick
- Prefetch/upload masivo de toda la biblioteca descargada en background agresivo

## Alternativas

| | Idea |
|---|---|
| C | Index/listado en `requestIdleCallback` o Worker |
| D | Sin proxy companion: solo rescate in-page desde caché HTTP; Decky solo bajo demanda |

## Checklist al reimplementar

- [ ] Nunca leer store `media` para listar descargas
- [ ] Sync acotado (eventos, no poll de 3.5s)
- [ ] Export solo lazy / pista actual
- [ ] Probar: custom download → offline cold start → hero + barra + `GET /song` albumArt local
- [ ] Probar: canción **no** descargada no genera `/art` ni rewrite
- [ ] Medir: scroll library / abrir player sin regresión vs `f8af427`

## Refs útiles

- Browse descargas YTM: `https://music.youtube.com/browse/FEmusic_offline`
- IDB: `yt-player-local-media:<channelId>||…` stores `index`, `media`, `captions`
- Commit estable post-revert volumen: `f8af427`
