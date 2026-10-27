# Changelog

## 1.0.0

First release.

- `ingest` sorts saved artifacts into `<app>/<kind>` branches (features, guides, screenshots, slides, docs) and an `images` branch for generated pictures, using git plumbing with no checkout. Re-running is idempotent; a changed kind or name moves the folder.
- Embedded pictures are extracted to `<artifact>/screenshots/`; pictures marked as generated go to `images`.
- Keys and tokens are replaced with `REDACTED_<KIND>` and reported by kind only. `scan` checks every branch.
- `search` over images, slides, features, guides, screenshots and docs; `list`, `show`, `get`, `stats`, `gaps`, `dupes`.
- `compare` against a feature list, a session summary or an uploaded file; `unsaved` against the live artifact list.
- `init`, `index` and `push` (never forced). Self-test in `scripts/selftest.mjs`.
