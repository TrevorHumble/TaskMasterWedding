# Edge-Case Checklist

**As the implementation agent (and the PR reviewer checking the same change), I need one canonical input-type → edge-case table both roles share, so that "handle the edges" resolves to the same concrete list on both sides of the handoff.**

An edge is **meaningful when the changed code branches on it** — when the edge input takes a different path than the representative input. Cover meaningful edges; list-checking the rest is noise.

**When NOT to invent an edge:** if the input domain has no nontrivial edge — a closed enum the code exhausts, or an input the acceptance criteria explicitly exclude — do not manufacture one. (Same rule as `agents/implementation-agent.md` build rule 6.)

| Input type       | Canonical edges                                                                                           | Example from this stack                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| string           | empty `""`; whitespace-only; very long; leading/trailing spaces; unexpected case; non-ASCII/emoji         | guest display name of `"  "` on signup                        |
| number           | `0`; negative; non-integer where integer expected; `NaN`; string-typed digits (`"5"`); max boundary       | badge threshold compare at exactly the threshold value        |
| array/collection | empty `[]`; single element; duplicates; order dependence; very large                                      | leaderboard with zero submissions on day one                  |
| object/record    | missing key; `null` value vs absent key; extra unexpected keys; wrong nested shape                        | an old row where a later migration's column is `NULL`         |
| file path        | nonexistent; wrong separator (`/` vs `\`); relative vs absolute; spaces in path; traversal (`..`)         | export path built from a guest-supplied filename              |
| file upload      | zero-byte; wrong mimetype; mimetype/extension mismatch; oversize; same file twice                         | HEIC posted to the photo intake (the #188 class)              |
| date/time        | timezone shift across midnight; DST boundary; epoch 0 / far future; string date not ISO                   | feed sort by `created_at` when two submissions share a second |
| HTTP request     | missing/expired auth; malformed body; wrong content-type; repeated submit (double-tap); method mismatch   | double-tap on the task-complete button posting twice          |
| SQL/DB row       | no row found; more rows than expected; concurrent write between read and update; migrated NULL in old row | guest lookup by a `/j/:token` link already consumed           |

Usage:

- **Implementer** (`agents/implementation-agent.md`): pick the rows matching your changed function's inputs; handle each meaningful edge or state in the handoff why it cannot occur.
- **PR reviewer** (`agents/reviewer-pr.md`): pick one edge from the matching row that the diff does NOT obviously cover and trace it; a meaningful uncovered edge is a finding.
