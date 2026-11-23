# hidden-spec-cli-01-run-20261122-entry

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Olumidegohard/hidden-spec-cli-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Olumidegohard/hidden-spec-cli-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` — one patch tool for every AI edit format. It applies an edit that an AI model wrote to a tree of text files, in any of the four formats models actually write: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. It finds the lines an edit names even when the model drifted their whitespace or indentation, and it changes every file or none: a failed edit changes nothing, the edits after it still run, and when any edit failed no file is written at all.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of the tree). With no `PATCH`, or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto` (the default) detects it.
- `--check` does everything but write: the same output and exit code, and no file is created, changed or deleted.
- `--strict` matches lines exactly, with no whitespace-drift tolerance.
- Options and `PATCH` may come in any order. `--` ends the options.

Exit 0 lists the changed files (`A`/`D`/`M`, `R old -> new` for a move) and `ok: <n> files`. Exit 1 lists one `error: <code> <path>` line per failed edit and `failed: <k> of <n> edits`. Exit 2 is a usage, missing-patch, format or parse error, with exactly one line on stdout. Standard error is never part of the result.

Node 22 and the standard library alone; no dependencies, no network.

---

<sub>Entered on [make.fun](https://make.fun/?ref=cpd3w3zk&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
