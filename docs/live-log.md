# Live log

This is the live per-increment ledger of autonomous runs, written by the orchestrator during
autonomous timed runs. Relocated verbatim from `docs/RESUME-STATE.md` § "Live log" by #470. A
compacted instance verifies the loop is live by reading the last ledger line here.

One line per increment, form:

```
[HH:MM] elapsed=Xm/budget=Ym | selector→{DO <item> | CASCADE | WRAP} | next=<item>
```

The `elapsed` value must be derived from a real system-clock read at that moment — never estimated or carried forward.
