# video-tool

A local tool for making short branded videos. You describe a scene, an AI writes it
as a [Remotion](https://remotion.dev) composition, and you preview, edit and export it
without leaving the app. Uploaded footage can be transcribed, trimmed and recut on a
timeline; a library of branded scenes can be dropped in as blocks.

Everything runs on your own machine — projects, media and renders all live in `data/`.

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

Needs `ffmpeg` and `ffprobe` on PATH, plus `ttyd` for terminal projects. Transcription
and auto-reframe additionally want a local Whisper install and OpenCV; both degrade
gracefully when missing.

API keys go in `.env.local` (not committed).

### Terminal renders run real commands

A terminal project is recorded, not simulated. VHS starts `ttyd` running a real
`bash` on the loopback interface, drives it from a headless browser and films the
result, so every `Type "..."` followed by `Enter` in a tape actually executes on the
machine doing the render. A tape that types `npm install` installs; one that types
`rm -rf` deletes.

Tapes are written by the AI, and the render route accepts whatever tape the request
carries, so treat a tape as code rather than as a script prop. `next dev` also binds
every interface by default, which puts that endpoint in reach of the local network;
bind it to `127.0.0.1` on a network you do not trust.

### VHS is pinned to 0.11.0

Terminal renders shell out to [VHS](https://github.com/charmbracelet/vhs). Homebrew
ships 0.12.0, which runs the whole tape, prints `Creating out.mp4...`, then skips the
ffmpeg encode and exits 0 without writing a file
([charmbracelet/vhs#787](https://github.com/charmbracelet/vhs/issues/787)).

So `npm install` runs `scripts/install-vhs.mjs`, which downloads the 0.11.0 build for
your platform into `.tools/` (gitignored, 22 MB, platform specific). Any Homebrew `vhs`
on PATH is left alone. The render route picks `VHS_BIN`, then `.tools/vhs`, then PATH.

```bash
node scripts/install-vhs.mjs --force   # re-download
SKIP_VHS_INSTALL=1 npm install         # skip it
```

A failed download only warns, it never fails the install. Once upstream fixes the
regression, drop the postinstall hook and the `.tools` lookup in the route.

## Tests

```bash
npm test             # document model, AI tool layer, timeline emitter (~2,100 assertions)
npm run test:render  # slow: real Remotion bundle + renderStill gate
```

`npm test` is the one to run before committing. `test:render` boots a real bundle and
takes tens of seconds, so it is a gate rather than something to run on every change.

## Other commands

```bash
npm run build        # production build (also the type-check gate)
npm run lint
npm run studio       # Remotion Studio on the registered compositions
```

## Layout

| Path | What lives there |
|---|---|
| `app/` | Next routes — `/` (project picker) and `/project/[id]` (the editor), plus the API |
| `components/` | UI. `ui/` holds the shared primitives |
| `lib/` | The real logic: document model, timeline parsing/editing, prompts, render queue |
| `remotion/` | Compositions and the scene runtime |
| `scripts/` | Test suites and one-off build/export scripts |
| `data/` | Project data — generated scenes, media, renders. Not source; excluded from type-checking |

`data/**/scene.tsx` files are written by the AI and evaluated at runtime, so they are
deliberately outside the TypeScript program — see the notes in `tsconfig.json`.
