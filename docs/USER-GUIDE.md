# Artifact vault: user guide

Version 1.0. For people who publish a lot of Claude artifacts and want them kept, sorted and findable.

## What you get

A git repo that holds a saved copy of every artifact, one branch per app and kind, and a small command-line tool to search it and to compare it against what you are doing now.

```
dev                       the table of contents (README.md, index.json)
luminova/guides           user guides for the app called luminova
luminova/screenshots      screenshot pages, plus pictures pulled out of other pages
luminova/slides           decks
solar-vd/features         status reports, plans, changelogs
images                    generated test pictures, in <app>/<what the test was>/
```

Kinds: `features`, `guides`, `screenshots`, `slides`, `docs`. Only kinds an app has get a branch.

## What you need

- Claude Code (or any harness that reads `SKILL.md`) with the Artifact tool.
- Node 18 or newer, and git.
- A folder for the vault, and a **private** remote if you want it backed up.

## Install

Claude Code plugin (all Violet skills):

```
/plugin marketplace add Violinet-tech/violet-skills
/plugin install violet-skills@violet-skills
```

Or this skill alone:

```bash
git clone https://github.com/Violinet-tech/artifact-vault ~/.claude/skills/artifact-vault
```

## First run: save everything

Ask Claude: **"Save all my artifacts into a vault at `~/artifact-vault`."**

Claude will:

1. create the vault (`init`);
2. list your artifacts and download each into a scratch folder;
3. ask you which app each belongs to, only where it cannot tell;
4. run `ingest --dry-run`, show you the branches it would make, then `ingest`;
5. run `scan` and tell you if a key was found and replaced.

If a key was found, **rotate it**. It was readable in a published page. The vault keeps only `REDACTED_<KIND>` in its place.

Add a remote and push when you are ready:

```bash
git -C ~/artifact-vault remote add origin <your private repo>
node scripts/vault.mjs push ~/artifact-vault
```

Pushes are never forced.

## Keeping it current

After a working session, ask: **"Save the new and changed artifacts."** Claude lists your artifacts, uses `unsaved` to find links that are not saved or are newer than the saved copy, and ingests only those. Unchanged artifacts make no commit, so running it often is free.

## Finding things

Run these yourself, or ask Claude in plain words.

```bash
node scripts/vault.mjs search ~/artifact-vault slides                    # every deck
node scripts/vault.mjs search ~/artifact-vault guides --app luminova      # one app's guides
node scripts/vault.mjs search ~/artifact-vault features stripe payout     # words in title or page text
node scripts/vault.mjs search ~/artifact-vault images restore             # generated pictures and screenshots
node scripts/vault.mjs search ~/artifact-vault images --generated         # generated pictures only
node scripts/vault.mjs list ~/artifact-vault --limit 10                   # newest ten
node scripts/vault.mjs show ~/artifact-vault luminova-user-guide          # one artifact's details
node scripts/vault.mjs get ~/artifact-vault luminova-user-guide --out ./guide
```

To read something in place, check its branch out: `git switch luminova/guides`.

## Comparing

These match words, not meaning. "Covered" means the vault has a page that talks about the thing. Open it before you tell anyone it is documented.

**Against a requested feature list.** Before building or promising something, see what is already written down:

```bash
node scripts/vault.mjs compare ~/artifact-vault --features "login with Google; batch export; dark mode"
```

Each line comes back `COVERED`, `PARTIAL` or `MISSING`, with the closest artifacts. Use `--features-file wanted.txt` for a long list and `--app <app>` to look at one app.

**Against the current session.** At the end of a session, write down what was done, one statement per line, and compare:

```bash
node scripts/vault.mjs compare ~/artifact-vault --session summary.txt
```

You get the statements nothing in the vault touches (work with no write-up yet) and any artifact links in your notes that are not saved.

**Against an upload.** Got a page, deck or note from somewhere else?

```bash
node scripts/vault.mjs compare ~/artifact-vault --upload deck.html
```

The verdict is one of: identical to a saved artifact, near-duplicate (probably a newer version), related, or new. It also lists headings the closest artifact does not have.

## Other useful commands

| Command | Use it to |
|---|---|
| `stats` | see counts per app and kind, and how many pictures there are |
| `gaps` | find apps with no guide, screenshots or slides (`--want guides,slides` to choose) |
| `dupes` | find identical or near-identical artifacts |
| `scan` | look for keys and tokens in every saved copy (kinds only, never values) |
| `unsaved --list list.txt` | find live artifacts not saved, or changed since saved |
| `index` | rebuild the table of contents on `dev` |

Every read command takes `--json`.

## Sorting rules

`ingest` uses the `category` you give it. Without one it decides from the title: slides, deck or pitch means `slides`; guide, how-to, setup, runbook, checklist or walkthrough means `guides`; screenshots, gallery, or before and after means `screenshots`; anything else is `features`. If it guessed wrong, change `category` in the manifest and ingest again. The old copy moves, because ingest replaces the artifact's folder on its branch.

Pictures an artifact embeds are saved as files under `<artifact>/screenshots/`. To send test pictures that a model generated to the `images` branch instead, give that artifact a `generated` rule in the manifest (see `SKILL.md`).

## What is not saved

- Slides, Docs, Dashboard and Design artifacts keep their own content, not the platform runtime around it.
- Docs text lives in the Docs store and is not exported, so a Docs artifact keeps only its page shell.
- Pictures and videos served from `/_blob/` inside decks and designs are not exported.

## Keep it private

A vault can hold work notes, local paths and screenshots of unreleased apps. Keep the remote private, and check each generated picture's model licence before showing it anywhere.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `not a git repository` | Run `init` first, or point at the vault folder, not a parent. |
| `no saved folder at ...` | Each artifact must be saved in `<root>/<id>/`. Use `--root`, or put `dir` in the manifest entry. |
| An artifact landed in `features` that is a guide | Add `"category": "guides"` to its manifest entry and ingest again. |
| `push` says not pushed | There is no `origin`, or the remote refused it. Pushes are never forced; fix the remote and run it again. |
| `search` finds nothing with several words | Every word must appear. Drop a word, or use `--titles` to skip page text. |
| Output looks odd on Windows | Use Git Bash or PowerShell with Node 18+; paths with spaces need quotes. |

## License

MIT.
