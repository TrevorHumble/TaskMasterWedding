# Live log

The live per-increment ledger for timed autonomous runs. The orchestrator appends one line here at
the end of every increment of a timed run (`agents/orchestrator.md` § "Autonomous timed run
(never-stop loop)"); a compacted instance verifies the loop is live by reading the last line here.
This file holds only the ledger — for where the work stands otherwise, see the issue board and the
newest entry in `BUILDLOG.md` on `main`.

Per-increment ledger lines written by the orchestrator during autonomous timed runs. One line per increment, form:

```
[HH:MM] elapsed=Xm/budget=Ym | selector→{DO <item> | CASCADE | WRAP} | next=<item>
```

The `elapsed` value must be derived from a real system-clock read at that moment — never estimated or carried forward. A compacted instance verifies the loop is live by reading the last ledger line here.
