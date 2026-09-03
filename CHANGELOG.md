# Changelog

## 0.1.1 — 2026-08-29

Documentation and discovery only — no behaviour changes; existing
baselines remain fully comparable (matrix unchanged, `core@1`).

- README: live browser demo linked above the fold; new "When CI goes red"
  section describing the accept workflow; figures re-verified on the
  current runtime (probe timing corrected to ~300 ms; the Chrome-vs-Node
  count now carries its measurement date); blink-dev incident thread
  linked.
- package.json: added `internationalization`, `formatting`,
  `snapshot-testing` keywords for npm search.

## 0.1.0 — 2026-08-05

First release.

`intl-drift` detects silent changes in `Intl` formatting output — the kind
that arrive inside Node upgrades and browser updates because locale data
(CLDR) and its implementation (ICU) ship inside the runtime, not inside
your code.

- **`probe`** snapshots ~12,000 formatting outputs across 27 locales
  (dates, numbers, currencies, plurals, relative time, display names,
  lists, casing, `resolvedOptions()`) into a canonical, byte-deterministic
  JSON file: pure ASCII, sorted keys, LF endings, no timestamps.
- **`init` / `check` / `accept`** — commit a baseline once; CI fails the
  moment this runtime's formatting drifts from it; re-baseline
  intentionally with an honest count of what was accepted.
- **`diff`** compares any two snapshots: uniform changes collapse into
  substitution rules (one line for a 197-entry invisible-space change),
  resolution drift prints before the output drift it explains, invisible
  characters are escaped everywhere, and meaningless comparisons
  (small-icu vs full-icu, mismatched matrices) are refused with distinct
  exit codes.
- **`--json`** machine output with a stable `schemaVersion`; full exit-code
  contract (0/1/2/3/4/5/64).
- **Zero dependencies.** The probe is a single ES5 file that runs on
  Node 7+ and in a browser `<script>` tag — `demo/index.html` diffs the
  reader's own browser against a Node snapshot, client-side.
- Reference snapshots for current Node LTS lines in `refs/`, regenerated
  monthly by CI.
- Validated by reproducing five documented production incidents; in three
  of them the original bug report named a different version than the one
  where the change actually landed.
