# goal-gate: a forcing hook (not a suggestion). Fires on PreToolUse for the
# AskUserQuestion tool and DENIES it, so the model cannot reflexively ask the
# user a question it should answer from the goals. The deny reason is fed back
# to the model. This is the enforcement layer for the "decide from the goals;
# don't punt" rule -- markdown is advisory, this is mechanical.
Write-Output '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"goal-gate (forced, not optional): you tried to ask the user a question. Do NOT. First derive the answer from the goals and constraints (the North Star in CLAUDE.md, and any explicit instruction). If they settle it, or it is a technical/implementation tradeoff, or it asks permission for already-authorized work, DECIDE IT AND ACT -- do not ask. The ONLY thing you may surface is a genuinely irreversible, owner-exclusive decision the goals do not settle (entering credentials/payment, publishing outward, deleting the owner data, moving money) -- and even then, raise it in prose, never via this tool. Re-derive from the goals now and continue."}}'
