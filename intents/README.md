# intents/ — the WHY channel

Git diffs carry WHAT changed. This folder carries WHY — so that every
Claude instance (Wolgan's and Monika's) always knows the direction and
meaning of work done on the other side, not just its text.

## The rules (Claude instances: these are binding)

1. **When you create a branch, create `intents/<branch-name>.md`**
   (replace `/` in the branch name with `--`, e.g. branch
   `monika/slow-bass` → `intents/monika--slow-bass.md`). Start it with a
   header (`author:`, `started:`), then: the goal in one sentence, the
   idea behind it, what it should feel like when it works.
2. **Update it with every commit** — a line or two: what you just did
   and any change of direction. It is a lab notebook, not a report;
   write it as the work happens, not after.
3. **When you pull or merge someone's branch, read their intent file
   FIRST**, before reading their diff.
4. **On merging a PR to `main`**: fold what became true into `SPEC.md`
   (the objective current state), then `git mv` the intent file to
   `intents/merged/`. Never delete intent files — the archive is the
   project's history of ideas, including its dead ends.
5. Merge conflicts between branches must never happen in this folder:
   every branch writes ONLY its own file (and SPEC.md only at merge
   time).

CI enforces the habit gently: a PR that changes code without touching
its intent file or SPEC.md fails with a reminder.

The archive is also the **provenance layer for the humans** (see
"Provenance duty" in CLAUDE.md): Claudes cross-reference git blame with
these files to warn before overwriting the other person's intentional
choices, to explain surprising behavior with its reason, and to brief
each human on what the other studio merged and why.
