# Dapp Builder — Agent Context

> Local-first, peer-to-peer dapp builder. React 19 + TypeScript + Yjs (CRDT) + shadcn/ui (Base UI) + Tailwind v4.
> Code Apps are the only creation path.

**`CLAUDE.md` is the maintained description of this repository** — architecture, the auth and
sync model, the invariants that must not be broken, and where things live. Read it first; this
file only keeps the short version and the few rules that are written down nowhere else.
Building a Code App (not the platform)? The contract for that is
`docs/code-apps/AGENT-INSTRUCTIONS.md`.

## Commands

- `npm run dev` — Vite dev server plus the signaling broker (`server/signaling.mjs`, the same one production runs)
- `npm run build` — `tsc` + Vite production build
- `npm run typecheck`, `npm run lint` (zero warnings allowed), `npm test` (Vitest, run once)
- `npm run headless` — the always-on keeper node (Node ≥ 23.6); `npm run smoke:keeper` boots it against a temp directory
- CI runs typecheck, lint, tests and the build on Node 22 and 25 — match that before pushing

## Rules that live only here

- **CSS:** element-level defaults (`a`, `button`, …) must sit inside `@layer base` in `src/index.css`.
  An unlayered rule beats every Tailwind utility regardless of specificity — an unlayered
  `a { color }` once made sidebar active states impossible to style.
- **i18n:** user-visible strings go through `t()` from `@/i18n`. Keys are the English source
  strings; German lives in `src/i18n/de.ts`. A missing entry falls back to English.
- **Protocol core:** record signing, canonicalization, tombstones and member writes come from
  `src/services/store/protocolCore.ts`. Never reimplement them elsewhere — drift breaks
  peer-to-peer validation silently.
- **Git:** `main` is deployed. Work on a branch and merge; new files need `git add`
  (`git commit -a` skips them — that broke `main` once).
