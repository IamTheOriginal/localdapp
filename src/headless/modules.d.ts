// fake-indexeddb ships types for its 'auto' entry, but its package.json
// "exports" map doesn't expose them to bundler-mode resolution. The import is
// side-effect-only (installs indexedDB globals), so an untyped declaration is
// exact.
declare module 'fake-indexeddb/auto';
