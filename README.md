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

Needs `ffmpeg` and `ffprobe` on PATH. Transcription and auto-reframe additionally want
a local Whisper install and OpenCV; both degrade gracefully when missing.

API keys go in `.env.local` (not committed).

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
