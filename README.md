# deskofjim.com

static site, no framework, no build step. hand-written html/css/js served from
the repo root by github pages (`master`, custom domain via `CNAME`).

## layout

- `index.html` — the whole homepage: a name, four links, and the flock
- `blog/` — writing index, reads `blog/posts.json` at runtime
- `puzzle/` — nine dots
- `js/` — three.js r98, GPUComputationRenderer, WebGL detect, vendored. pinned
  at r98 on purpose; the shaders target that API
- `fonts-web/` — newsreader, latin subset, self-hosted
- `404.html`

## the birds

up to 4096 boids, all state on the gpu. two fragment shaders ping-pong between
float textures: one integrates velocity (separation, alignment, cohesion,
predator), the other integrates position from it. js uploads a cursor uniform
and nothing else — zero per-bird work on the cpu. count is `WIDTH²`; `?birds=N`
overrides it (8–64), and the sim drops a tier if the first four seconds average
under 38fps. shading is a directional sheen dotted against velocity plus a fade
to black with depth, so the flock has no edges.

## substack sync

`scripts/fetch-substack.mjs` (node 20, zero deps) pulls the feed, merges into
`blog/posts.json` by url, sorts desc. the workflow runs it daily at 09:17 utc
and commits only when the file changes. by hand:

    node scripts/fetch-substack.mjs

## local

any static server from the repo root — `python -m http.server 8000`. the
absolute paths (`/blog/`, `/fonts-web/…`) need a root, not `file://`.

the nine dots in the corner go somewhere.
