# Design Philosophy Standard

**Scope:** every implementation artifact in this repo — skills, agents, standards docs, code.
**Consumer:** `reviewer-design-philosophy`, implementation agents, and the orchestrator.

Source: Ousterhout, _A Philosophy of Software Design_.

---

## Principles

**Deep modules** — a module's interface is small relative to its implementation. The complexity is inside, not exposed.

**Information hiding** — each module conceals its internal decisions. Callers do not need to know how it works, only what it promises.

**Pull complexity downward** — when complexity must live somewhere, it belongs in the implementation, not pushed up to callers.

**Define errors out of existence** — design the interface so the error case cannot arise, rather than handling it after the fact.

**Different layers, different abstractions** — each layer of a system should introduce a distinct vocabulary. A layer that merely re-names what the layer below it does adds no value.

**Design it twice** — before committing to an interface, sketch at least two designs and compare them. The first design is rarely the best.

**Consistency** — similar things look similar; different things look different. Deviations from established patterns must be justified.

**Obvious code** — a reader should understand what a piece of code does without consulting external context. If you need a comment to explain what it does (not why), redesign it.

---

## Review questions

Apply these when judging any artifact:

1. Is the module's interface smaller than its implementation, or is the interface exposing internal decisions?
2. Does each layer introduce a new abstraction, or is it passing the layer below straight through?
3. Was this designed twice, or is this the only design considered?
4. Are similar constructs named and structured consistently?
5. Can a reader understand what each piece does without reading the surrounding context?
6. Are there error conditions that could be eliminated by reframing the interface?

---

## Red flags

The following patterns are defects, not style preferences. A finding that matches any named red flag is at least major and must be fixed before PASS (never dismissed as style).

| Pattern                  | What it signals                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shallow module`         | The interface is nearly as complex as the implementation — depth is missing.                                                                                       |
| `information leakage`    | An internal decision is visible or duplicated across the interface.                                                                                                |
| `temporal decomposition` | Structure follows the order of operations rather than the information being hidden.                                                                                |
| `pass-through`           | A module that does nothing but forward arguments to the layer below — no abstraction added.                                                                        |
| `vague name`             | A name that does not communicate what the thing is or does — e.g., `tmp`, a variable name so generic it forces the reader to trace the data flow to understand it. |

An artifact that exhibits any of these patterns fails this standard. The reviewer cites the pattern name and quotes the evidence.

One worked Flag/Clean example pair per red flag, each with an over-flag guard (`Not a finding:`), lives in `standards/design-philosophy-examples.md` — consult it before classifying any red-flag finding.
