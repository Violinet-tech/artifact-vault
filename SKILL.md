---
name: artifact-vault
description: Save every Claude artifact into one private git repo, sorted into a branch per app and kind (features, guides, screenshots, slides, docs, plus an images branch for generated test pictures), then search it and compare it against the current session, a requested feature list or an uploaded file. Use when the user says save, back up, archive or organise artifacts, asks to find an old slide deck, guide, screenshot or generated image, wants to know whether something is already documented, or wants to check what a session built against what the vault holds.
version: 1.0.0
---

# Artifact vault

Claude artifacts live on claude.ai, one link each, with no folders and no search. This skill copies them into a git repo you own, organised the same way every time, and gives you commands to search and compare that repo. It never changes the artifacts themselves.

`scripts/vault.mjs` does the repo work (Node 18+ and git, no other dependencies). Claude does the parts that need the Artifact tool and judgement: listing and downloading artifacts, deciding which app each belongs to, and reading the results.

## The layout

```
<vault>/                      a normal git repo
  dev                         branch: README.md + index.json, the table of contents
  <app>/features              branch: status reports, plans, changelogs, explainers, site pages
  <app>/guides                branch: user guides, setup guides, runbooks, checklists
  <app>/screenshots           branch: pages that are mostly screenshots, plus pictures pulled out of other pages
  <app>/slides                branch: decks
  <app>/docs                  branch: Docs artifacts
  images                      branch: generated test pictures, <app>/<what the test was>/<name>
```

Only the kinds an app actually has get a branch. Each artifact is a folder `<title-slug>-<id4>/` holding `index.html`, the files it needs, `ARTIFACT.json` (title, link, last update, app, kind) and, when the page embedded pictures, `screenshots/NN-<label>.<ext>`. Artifacts with no app go under `misc`.

The branch names cannot clash: `<app>` is never a branch on its own, and `dev` and `images` are reserved app names.

## Saving artifacts (Claude's part)

1. **List them.** `Artifact` with `action: "list"`, `scope: "mine"`, `limit: 200`. Note each title, link and updated date.
2. **Download each one.** `Artifact` with `action: "read"`, `url`, `path: "index.html"` and `out_dir: <saved>/<id>`, where `<id>` is the last part of the link. For a page with more files, `action: "list"`, `scope: "files"` on its `url`, then `read` with `paths: [...]` and the same `out_dir`. Small text files also come back inline, which costs context; for a big batch, do it in a subagent or in chunks.
3. **Work out the app.** From the title and content. If it is not clear, ask once with the whole list, rather than guessing per artifact. Do not invent app names; reuse the ones the vault already has (`vault.mjs stats`). `--apps apps.json` can map title words to apps for a repeat run.
4. **Write `manifest.json`**: a list of `{ "id", "title", "updated", "app", "category"? }`. `category` is optional (`features|guides|screenshots|slides|docs`); without it the script decides from the title and files, and anything unclear becomes `features`. Say so in your report and offer to correct it.
   To send some pictures to the `images` branch instead of `screenshots`, add `"generated": [{ "match": "text in the picture's alt", "what": "restore-test", "name": "optional-file-name" }]` to that artifact. Only do this for pictures a model generated as an app test; UI screenshots stay screenshots.
5. **Dry run, then ingest.**
   ```bash
   node scripts/vault.mjs ingest <vault> manifest.json --root <saved> --dry-run
   node scripts/vault.mjs ingest <vault> manifest.json --root <saved>
   ```
   Re-running is safe: unchanged artifacts make no new commit, changed ones replace their folder.
6. **Scan, then push.** `node scripts/vault.mjs scan <vault>` must report nothing. `--push` (or `vault.mjs push`) never forces. Push only to a private remote, and only if the user has said where.

What cannot be saved, and what to tell the user: Slides, Docs, Dashboard and Design artifacts carry a platform runtime (`artifact-type/`) that is left out; Docs text lives in the Docs store and is not exported, so a Docs artifact keeps only its page shell; pictures and videos served from `/_blob/` inside decks are not exported.

## Keys and tokens

`ingest` replaces keys it recognises (Google, Anthropic, OpenAI, GitHub, Hugging Face, Slack, AWS, Stripe live, private key blocks) with `REDACTED_<KIND>` in the saved copy and reports the kind and count, never the value. **Tell the user to rotate any key that was found**: it was readable in a published artifact. `scan` repeats the check over every branch. Never print a found value.

## Searching

```bash
node scripts/vault.mjs search <vault> <kind> [words...] [--app a] [--since 2026-10-01] [--titles] [--limit N] [--json]
```

`kind` is `all`, `images`, `features`, `guides`, `screenshots`, `slides` or `docs`. Words must all appear in the title, app, folder name or page text (`--titles` skips the page text).

- `search <vault> slides` lists every deck. `search <vault> guides --app luminova` finds one app's guides.
- `search <vault> images restore` finds generated pictures (from the `images` branch) and screenshots extracted from pages. `--generated` or `--screens` narrows it.
- `list`, `show <id|word>`, `get <id> --out <dir>`, `stats`, `gaps` (apps missing guides, screenshots or slides) and `dupes` round it out.

To open what you found, `get` copies it out, or `git switch <app>/<kind>` checks the branch out.

## Comparing

Each compare command scores text overlap, not meaning. Treat `covered` as "the vault has a page that talks about this", and read the page before saying it is documented.

- **Against the current session.** Write a plain summary of what the session did (one statement per line or bullet) to a file, then `compare <vault> --session summary.txt` (`-` reads standard input). It lists the statements nothing in the vault touches, and any claude.ai artifact links in the text that are not saved yet.
- **Against requested features.** `compare <vault> --features "login with Google; batch export; dark mode"` or `--features-file wanted.txt`. Each feature comes back `covered`, `partial` or `missing`, with the closest artifacts and their kind. Add `--app <app>` to look at one app.
- **Against an upload.** `compare <vault> --upload file.html` (or `.md`, `.txt`) says whether the file is identical to a saved artifact, a near-duplicate (probably a newer version), related, or new, and lists the headings the closest artifact lacks.
- **Against what is live.** `unsaved <vault> --list list.txt` takes pasted `Artifact list` output and reports links that are not saved or whose date is newer than the saved copy.

## Commands

| Command | What it does |
|---|---|
| `init <vault> [--remote url]` | create the vault and its `dev` index |
| `ingest <vault> <manifest> [--root dir] [--apps file] [--author "Name <email>"] [--dry-run] [--push]` | sort saved artifacts into branches |
| `index <vault>` | rebuild `README.md` and `index.json` |
| `push <vault>` | push every branch, never forced |
| `search`, `list`, `show`, `get`, `stats`, `gaps`, `dupes`, `scan` | look at what is saved |
| `compare`, `unsaved` | check it against a session, a feature list, an upload or the live list |

Read commands take `--json`. `node scripts/vault.mjs help` prints all of it.

## Rules

- The vault is private. Saved artifacts can hold work notes, local paths and screenshots of unreleased apps. Never push it to a public repo, and check each picture's model licence and the workflow data inside it before the `images` branch goes anywhere else.
- Never edit an artifact's saved copy by hand to "fix" it; re-save from the live link.
- Do not invent a layout, app name or category the user did not ask for. When the vault already has a convention, follow it.
- Be plain about what a compare cannot tell: it matches words, not truth, and says nothing about whether a feature works.
