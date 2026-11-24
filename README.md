# mend

`mend` is a command-line tool that applies an edit an AI model wrote to a tree of text files. Models write edits
in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and
text-editor tool calls as JSON. mend reads each format as `SPEC.md` says, finds the lines an edit names at the
first of three matching tiers (exact, trailing-whitespace-insensitive, fully whitespace-insensitive), and changes
every file or nothing.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `main.ts` — the CLI. Node 22, standard library alone. It follows SPEC.md section by section: the command line
  and exit codes (§1–2), files, lines and safe paths (§3), format detection (§4), three-tier line matching (§5),
  the unified, SEARCH/REPLACE, V4A and JSON readers (§6–9), and the all-or-nothing write (§10).
- `runner.ts` — the kit's trial runner, kept as it is: when `MAKEFUN_ENV_URL` is set, `main.ts` hands the trial
  over to it.
- `check.ts` — runs the kit's public practice set against `main.ts` on your own machine:

      node check.ts ../program/generator/practice.json

- `SPEC.md` — the specification mend is built to.
- `LICENSE` — MIT.

Exit codes: 0 when every edit applied (with one `A`/`D`/`M`/`R` line per changed path and an `ok:` summary),
1 when some edits failed (one `error: <code> <path>` line each and a `failed:` summary, nothing written), and 2
for a usage error, an unreadable patch file, an undetectable format, or a parse fault.
