# Reviewer-verdict JSON schema

Defined by issue #128. This is the input format `tools/review-runner.ps1` consumes:
one JSON file per reviewer, dropped into the run directory (`-RunDir`) before the
runner is invoked. It is NOT the same shape as the `rev1` evidence file
`tools/persist-review.ps1` writes — that is the runner's _output_, written only
after every verdict in this format has been validated and aggregated.

## Fields

| Field        | Type   | Required | Notes                                                                                                   |
| ------------ | ------ | -------- | ------------------------------------------------------------------------------------------------------- |
| `reviewerId` | string | yes      | Distinct id for the reviewer, e.g. `reviewer-pr-1`. Passed through to `persist-review.ps1 -ReviewerId`. |
| `verdict`    | string | yes      | Allowed values: `PASS`, `FAIL`. Any other value is malformed input.                                     |
| `defects`    | array  | no       | Defaults to `[]` (no defects) if omitted.                                                               |

## `defects[]` entry fields

| Field      | Type   | Required | Notes                                                                                                                           |
| ---------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `severity` | string | yes      | Allowed values: `blocker`, `major`, `minor`, `nit`. Expected of a well-formed verdict; the runner does not validate this field. |
| `text`     | string | yes      | Free-text description of the defect. Expected of a well-formed verdict; the runner does not validate this field.                |
| `file`     | string | no       | Path to the cited file, relative to the repo root. Omit for a defect with no file citation (e.g. a process finding).            |
| `line`     | number | no       | 1-based line number in `file`. Only meaningful when `file` is present.                                                          |

A defect that omits `file` is never citation-validated — there is nothing to check.
A defect that includes `file` but omits `line` is treated as citing the whole file;
the runner still requires the file to exist under the repo root.
A `line` of `0` (or any value outside `1..count`) is `out-of-range` — `line` is 1-based.

The runner validates two things only: each verdict file's top-level `verdict`
value (`PASS`/`FAIL`, anything else is `malformed`), and every defect's
`file`/`line` citation per the rules above. It does NOT validate `severity`
or `text` — a defect with a bogus `severity` or empty `text` still passes
citation validation as long as its `file`/`line` (if present) are valid.

## Example

```json
{
  "reviewerId": "reviewer-pr-1",
  "verdict": "PASS",
  "defects": []
}
```

```json
{
  "reviewerId": "reviewer-pr-2",
  "verdict": "FAIL",
  "defects": [
    { "severity": "blocker", "text": "unhandled null deref", "file": "src/db.js", "line": 42 },
    { "severity": "nit", "text": "naming style" }
  ]
}
```

## Consumers

- `tools/review-runner.ps1` reads every `*.json` file in `-RunDir` against this
  shape, citation-validates each `defects[].file`/`line` pair (fail-closed: a
  file that does not exist under the repo root is `file-not-found`; a `line`
  greater than the file's line count is `out-of-range`), then aggregates
  `verdict` across all reviewer files by `-Mode`.
- On a clean, fully-passing aggregate only, the runner calls the existing
  `tools/persist-review.ps1` once per reviewer (writing the `rev1` evidence
  schema) and `tools/review_verdict.ps1` to bind the tree-level PASS. This
  schema is never written to disk itself — it exists only as the runner's
  input contract.
