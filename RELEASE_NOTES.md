# v0.1.0 — first release

**Bug reports about formatting changes routinely name the wrong version.**
Of the five documented production incidents this tool reproduces, three
were reported against versions where the change did not land — because
people report where they *noticed*, and without snapshots there is no way
to know where it *changed*. The en-GB date comma blamed on Chromium's
ICU 77 upgrade actually landed at ICU 76, between two Node 22 LTS *patch*
releases. The de-CH separator flip reported against Node 24.13.0→24.13.1
actually happened years earlier, between ICU 68 and 72. The ru-USD change
blamed on an ICU data update was really the small-icu *fallback locale*
changing underneath everyone.

Snapshots replace anecdotes. That is the whole tool.

## What it does

`intl-drift` snapshots ~12,000 `Intl` formatting outputs across 27 locales
into a canonical, byte-deterministic JSON file, and diffs snapshots across
Node versions and runtimes:

```console
$ npx intl-drift init     # once: snapshot this runtime, commit the file
$ npx intl-drift check    # in CI: exit 1 the moment formatting drifts
$ npx intl-drift accept   # after an intentional upgrade: re-baseline
```

## Highlights

- **Readable drift reports** — a Node 14→18 upgrade changes 913 outputs;
  uniform changes collapse into substitution rules (the ICU 72
  invisible-space change is one line: `"U+0020" -> "U+202F"`, 197 entries,
  18 locales), and `resolvedOptions()` drift prints before the output
  changes it explains.
- **Invisible characters escaped everywhere** — NNBSP, NBSP, THIN SPACE,
  bidi marks: the changes diff viewers cannot show are the ones that
  break string comparisons.
- **Refuses meaningless comparisons** — small-icu vs full-icu builds and
  mismatched probe matrices exit with distinct codes instead of producing
  phantom diffs. Full CI exit-code contract: 0/1/2/3/4/5/64, plus `--json`
  with a stable `schemaVersion`.
- **Zero dependencies** — the probe is one ES5 file that runs on Node 7+
  and in a browser `<script>` tag. The
  [live demo](https://jay123anta.github.io/intl-drift/demo/) diffs *your
  own browser* against a Node snapshot, client-side, in ~30 seconds.
- **Reference snapshots** for current Node LTS lines in `refs/`,
  regenerated monthly by CI — preview an upgrade without installing it:
  `npx intl-drift diff refs/node-18.json refs/node-22.json`
- **GitHub Action** —
  [intl-drift check](https://github.com/marketplace/actions/intl-drift-check)
  fails the build with the readable report when a base-image or Node bump
  changes your formatting.

Tested: 97 assertions across ubuntu/windows × Node 18–26, including
incident-reproduction regressions against frozen snapshots and a
byte-determinism selftest on every supported runtime.
