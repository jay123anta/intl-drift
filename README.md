# intl-drift

> **Your code didn't change. Your dates and currencies did.**

`Intl` formatting is powered by locale data (CLDR) and an implementation
(ICU) that ship *inside* every Node.js release and every browser — and get
swapped out from under you on every upgrade. When that happens, prices,
dates, and plurals change silently: no changelog entry names your locale, no
test fails until it's too late, and the diff is often an invisible Unicode
character.

`intl-drift` snapshots what your runtime actually formats — ~12,000 outputs
across 27 locales, in about 250 ms — and tells you exactly what changed, the
moment it changes.

```console
$ npx intl-drift init     # once: snapshot this runtime, commit the file
$ npx intl-drift check    # in CI: exit 1 the moment formatting drifts
$ npx intl-drift accept   # after an intentional upgrade: re-baseline
```

## These are real incidents (all reproduced by this tool)

| What users saw | Trigger | Where it actually changed |
|---|---|---|
| fr-CA currency `123,45 $` → `123,45 $ CA` | Node 14.16 → 14.17 — a **minor** release ([nodejs#38897](https://github.com/nodejs/node/issues/38897)) | ICU 67 → 68 |
| ru USD `$9` → `US$ 9` | Node 7 → 8 ([nodejs#15223](https://github.com/nodejs/node/issues/15223)) | not Russian data at all — the small-icu *fallback locale* changed |
| uk-UA hryvnia: `₴` on your server, `грн` in your users' Chrome | live **today** ([nodejs#58870](https://github.com/nodejs/node/issues/58870)) | vendor divergence — upstream CLDR still says `₴` |
| en-GB/AU/IN full dates gained a comma | Chromium's ICU 77 upgrade (blink-dev) | actually ICU 75 → 76 — two Node 22 **LTS patch releases** apart |
| de-CH `12.2021` → `12/2021`, broke Next.js SSR hydration | reported as Node 24.13.0 → 24.13.1 ([nodejs#61861](https://github.com/nodejs/node/issues/61861)) | actually ICU 68 → 72 |

Notice the last column. In three of five incidents, **the bug report names the
wrong version** — because people report where they *noticed*, and without
snapshots there is no way to know where it *changed*. In every one of these
threads, an engineer burned days rediscovering the problem from scratch; in
the Chromium case, one found the blast radius by manually testing locales one
at a time.

Snapshots replace anecdotes. That is the whole tool.

## What a drift report looks like

Node 14 → Node 18 changes 913 outputs. You don't read 913 lines — uniform
changes collapse into rules:

```
  ENVIRONMENT
    icu       68.2  ->  72.1
    cldr      38.1  ->  42.0
    tz        2020d ->  2022f

  DRIFT    913 changes in 27 of 27 locales

  DateTimeFormat ........................ 623 changes
    * uniform substitution: "U+0020" -> "U+202F"
      197 entries · cy-GB de-CH de-DE en-AU en-GB en-IN en-US es-ES ...
        en-US  medShort.winterPM
          - Jan 15, 2024, 1:45 PM
          + Jan 15, 2024, 1:45<U+202F>PM

    * uniform substitution: "1." -> "01/"
      4 entries · de-CH de-DE
        de-CH  ym.epoch
          - 1.1970
          + 01/1970

  PluralRules ........................... 7 changes
    es-ES  cardinal.1000000
      - other
      + many
```

Three things to notice:

- That first rule is ICU 72 swapping the space before AM/PM for U+202F
  (NARROW NO-BREAK SPACE): **visually identical, breaks every string
  comparison, invisible in most diff tools.** Every invisible character is
  escaped in both the snapshot and the report — this class of change is the
  reason the tool exists.
- The second rule is the de-CH incident from the table above — caught as
  4 entries with the exact before/after.
- The third is Spanish *gaining a plural category* at one million (French
  did the same two ICU versions earlier). If you use `PluralRules` to pick
  message strings, that's a wrong sentence in production, and nothing else
  in your stack will ever mention it.

## Your server vs your users' browsers

The probe is a single zero-dependency ES5 file. It runs unmodified on
Node 7+, Deno (experimental), and in a plain `<script>` tag. So
[`demo/index.html`](demo/index.html) probes **the reader's own browser** and
diffs it against a Node snapshot entirely client-side — no server, nothing
uploaded.

Chrome vs Node 22, today: **467 outputs differ.** Among them: the hryvnia
symbol, `12 million` vs `1.2 crore` for en-IN compact numbers, and an entire
locale — Welsh — that Chrome silently serves in English while Node renders it
fully.

## Even identical data versions drift

Node 20.20 and Node 22.23 ship the **same ICU 78.2 and CLDR 48** — and still
differ in 90 outputs, because the engine layer moved: `hour12: true` resolves
to `hourCycle: "h12"` on Node 22 but `"h11"` on Node 20 (which changes how
midnight renders), and newer ECMA-402 fields appeared in `resolvedOptions()`.

This is why the tool probes the runtime you deploy instead of diffing CLDR
data files: **a data diff cannot see implementation drift, and three of the
five incidents above were implementation drift.**

## How it works

1. **`probe`** runs a fixed matrix — 27 locales × (DateTimeFormat,
   NumberFormat, PluralRules, RelativeTimeFormat, ListFormat, DisplayNames,
   locale-aware casing, a collation canary, and `resolvedOptions()` for every
   formatter) × curated sample values — and writes a canonical snapshot:
   plain JSON, pure ASCII (every non-ASCII character escaped), sorted keys,
   LF endings, no timestamps. Same runtime → byte-identical file, every time
   (`intl-drift selftest` proves it).
2. **`diff`** compares two snapshots: reports every changed output with the
   correlated ICU/CLDR/tz delta, collapses uniform changes into rules,
   separates *resolution* drift (the cause) from *output* drift (the
   symptoms), counts availability changes instead of enumerating them, and
   refuses meaningless comparisons (different matrix versions, or a
   small-icu build against a full-icu one).
3. **`check`** = probe this runtime + diff against your committed baseline.
   One command, CI-shaped exit codes.

The locale set is not "top N by population" — it is chosen to maximize
drift-surface coverage: every documented incident's locale, plus structurally
extreme ones (6-category Welsh plurals, Thai's Buddhist calendar, Persian
calendar + arabext digits, RTL with both digit systems, U+2212 minus locales,
Indian grouping, four CJK variants).

## CLI

```
intl-drift init    [--baseline FILE] [--force]     create the committed baseline
intl-drift check   [--baseline FILE] [--json] [--locales a,b] [--verbose]
intl-drift accept  [--baseline FILE] [--force]     intentional update (prints what it accepted)
intl-drift probe   [--out FILE]                    emit a snapshot
intl-drift diff    A.json B.json [--json] [--locales a,b] [--allow-env-mismatch] [--verbose]
intl-drift selftest                                determinism proof for this runtime
```

| Exit | Meaning |
|---|---|
| 0 | no drift |
| 1 | drift found (`check` prints the `accept` hint) |
| 2 | baseline missing or unreadable |
| 3 | environment mismatch refused (small-icu vs full-icu) |
| 4 | matrix mismatch refused (snapshots from different tool matrices) |
| 5 | probe/tool failure |
| 64 | usage error |

`--json` emits a canonically-serialized machine document (`schemaVersion: 1`,
status `clean | drift | env-mismatch | matrix-mismatch | error`) with the
same exit codes — every change carries a `kind` and a `group` back-reference,
so CI can filter grouped noise from targeted breakage.

## CI

```yaml
# .github/workflows/intl-drift.yml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npx intl-drift check --locales de-DE,fr-FR,en-US
```

Commit `.intl-drift/baseline.json` once. From then on, any base-image bump,
`setup-node` version change, or Node upgrade that alters your formatting
fails the build with the readable report above — *before* your users see it.

Pre-generated reference snapshots for Node 18/20/22/24 live in
[`refs/`](refs/), so you can preview an upgrade without installing either
version:

```console
$ npx intl-drift diff refs/node-18.json refs/node-22.json
```

## Programmatic API

```js
const intlDrift = require('intl-drift');

const snap = intlDrift.probe();               // snapshot object for THIS runtime
const text = intlDrift.serialize(snap);       // canonical JSON text
const res  = intlDrift.diff(base, snap, {});  // prints report, returns { code, totalDrift, ... }
```

## Honest limitations

- **A clean check means "no drift in the probed matrix" — never "no
  drift."** The matrix samples ~12,000 outputs; the full Intl surface is
  effectively unbounded. Pass `--locales` with your app's locale list and
  the report will name exactly which of your locales the matrix does not
  cover, rather than letting silence imply safety.
- **The tool reports correlated version deltas, not causes.** It will show
  you `icu 75.1 -> 76.1` next to the change; it will not claim which CLDR
  ticket did it.
- **Snapshots from different matrix versions refuse to compare** (exit 4)
  instead of producing a misleading partial diff. `accept` is the migration
  path after upgrading the tool.
- Node 7-era runtimes can *run the probe* (that's how the incidents above
  were reproduced), but the CLI itself needs Node ≥ 14.14.

## FAQ

**Why not just pin the ICU version?**
You can't. Node bundles ICU per release and browsers update themselves.
Swapping ICU data files across major versions is not supported (binary
coupling; the packager was abandoned at ICU 65). Drift is unavoidable —
being surprised by it is optional.

**Why not diff CLDR's published JSON between versions?**
Because runtimes don't ship what CLDR publishes — Node patches ICU, V8 adds
its own layer, Chrome cherry-picks, and small-icu builds ship a fraction of
the data. Three of the five incidents above had **no CLDR data change
behind them at all.** The only ground truth is what your runtime outputs.

**Won't this be noisy?**
A `check` against your own baseline is silent until your runtime's data
actually changes — which is exactly when you want noise. Uniform changes
collapse to one line; availability changes are counted, not enumerated; and
tz-only changes are attributed in the header rather than blamed on locales.

**What about `formatToParts`, `Intl.Segmenter`, `DurationFormat`?**
Deliberately out of v1, tracked for v1.1. `formatToParts` drift (token
boundaries changing while the concatenated string stays identical) is real
but roughly doubles snapshot size for a failure mode that only affects
part-consuming code; `Segmenter` output is boundary offsets, which rarely
surface as visible breakage; `DurationFormat` is too new to exist in the
historical runtimes upgrade comparisons need.

## License

MIT · Built by reproducing five production incidents from scratch, so you
don't have to rediscover the sixth.
