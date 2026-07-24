# AGENTS.md

`CLAUDE.md` is the single authoritative operating contract for every agent working in
this repo — Claude, Gemini, Antigravity, or any other tool that reads this file by
convention. Read it before doing anything, and follow it exactly.

Everything an agent needs lives there or in the files it points to:

- Operating rules, the pipeline, and the governance freeze — `CLAUDE.md`.
- Model-tier equivalents, including Gemini / Antigravity — `CLAUDE.md` § "Model policy".
- Checkable standards (issues, reviews, agents, skills, docs) — `standards/`.
- Agent definitions — `agents/`.

This file is deliberately a pointer, not a copy: duplicating `CLAUDE.md` here would let the
two drift. There is one operating contract, and it is `CLAUDE.md`.
