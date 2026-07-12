# gate-core.sh: shared gate logic sourced by .githooks/pre-commit and
# .githooks/commit-msg. Not a hook itself and not executable on its own.
#
# Exists because of event mode (#220): pre-commit cannot read the commit
# message, so while a valid unexpired governance/event-mode.json is present the
# evidence gate has to run inside commit-msg instead (the hook that CAN read
# the message and scope the bypass to 'hotfix: ' subjects). Both hooks need
# the same two pieces -- the event-mode state probe and the full evidence
# gate -- so both live here, once.

# event_mode_state <root>: prints ACTIVE when governance/event-mode.json is a
# valid em1 flag whose expiry is in the future, INACTIVE otherwise (absent,
# malformed, wrong schema, expired, or no powershell to parse it). INACTIVE
# means "this state enables no bypass" -- an invalid or expired flag must
# enable nothing, so all failure modes collapse to INACTIVE. NOTE: the two
# hooks each evaluate this independently and the answer can change between
# them (expiry crossing mid-commit), so commit-msg keys its gate on flag-FILE
# presence, not on this state -- see the comment there. The file-existence
# fast path keeps the no-flag case (every normal day) free of a powershell
# spawn.
event_mode_state() {
  _emroot="$1"
  if [ ! -f "$_emroot/governance/event-mode.json" ]; then
    echo "INACTIVE"
    return 0
  fi
  _emps="$(command -v powershell 2>/dev/null)" || _emps=""
  if [ -z "$_emps" ]; then
    echo "INACTIVE"
    return 0
  fi
  _emstate="$(powershell -NoProfile -ExecutionPolicy Bypass -Command ". '$_emroot/tools/event-mode-core.ps1'; Get-EventModeState -FlagPath '$_emroot/governance/event-mode.json'" 2>/dev/null)" || _emstate=""
  _emstate="$(printf '%s' "$_emstate" | tr -d '[:space:]')"
  if [ "$_emstate" = "ACTIVE" ]; then
    echo "ACTIVE"
  else
    echo "INACTIVE"
  fi
}

# classifier_says_trivial <root>: prints "true" when the STAGED tree
# classifies 'trivial' under tools/classify-trivial-commit.ps1 (#448) --
# a manifest-only dependency bump whose changed deps all classify 'auto'
# under the shared tools/classify-dep-pr-core.ps1 tier rules. Prints "false"
# on any other classification, AND on any failure to run the classifier at
# all (missing powershell, missing script, non-zero exit, unexpected output)
# -- fail CLOSED, mirroring event_mode_state's collapse-to-INACTIVE posture.
# The commit-subject "chore(deps): " prefix is NOT checked here (this probe
# only recomputes the staged-tree half of eligibility); the hooks below check
# the prefix themselves once they can read the commit message.
classifier_says_trivial() {
  _tcroot="$1"
  _tcps="$(command -v powershell 2>/dev/null)" || _tcps=""
  if [ -z "$_tcps" ]; then
    echo "false"
    return 0
  fi
  _tcscript="$_tcroot/tools/classify-trivial-commit.ps1"
  if [ ! -f "$_tcscript" ]; then
    echo "false"
    return 0
  fi
  _tcresult="$(powershell -NoProfile -ExecutionPolicy Bypass -File "$_tcscript" 2>/dev/null)" || _tcresult=""
  _tcresult="$(printf '%s' "$_tcresult" | tr -d '[:space:]')"
  if [ "$_tcresult" = "trivial" ]; then
    echo "true"
  else
    echo "false"
  fi
}

# evidence_gate <root>: the commit gate formerly inlined in .githooks/pre-commit.
# Blocks (exits the calling hook non-zero) unless a review verdict bound to the
# EXACT to-be-committed tree says PASS and validate-verdict.ps1 confirms the
# evidence files. Fails CLOSED. See .githooks/pre-commit for the guarantee and
# its honest scope.
evidence_gate() {
  _egroot="$1"
  _egvf="$_egroot/.review_state/verdict.json"

  # Fail CLOSED if we cannot compute the tree (e.g. unmerged index): never let an
  # empty tree_now collide with an empty/corrupt verdict tree and fall through.
  _egtree_now="$(git write-tree)" || _egtree_now=""
  if [ -z "$_egtree_now" ]; then
    echo "commit-gate (BLOCKED): git write-tree failed (unmerged index?). Failing closed." >&2
    exit 1
  fi

  if [ ! -f "$_egvf" ]; then
    echo "commit-gate (BLOCKED): no review verdict exists for this commit." >&2
    echo "  Spawn the adversarial review; on PASS record it, then commit:" >&2
    echo "    powershell -File tools/review_verdict.ps1 -Verdict PASS -Reviewers \"reviewer-pr,reviewer-design-philosophy\"" >&2
    exit 1
  fi

  # verdict.json MUST stay single-line compressed JSON (review_verdict.ps1 writes it
  # that way); this parses it with sed, not a JSON parser. Keys are read by name, so
  # order is irrelevant; any failure to extract leaves the var empty -> fail closed.
  _egverdict="$(sed -n 's/.*"verdict"[ ]*:[ ]*"\([A-Z]*\)".*/\1/p' "$_egvf")"
  _egvtree="$(sed -n 's/.*"tree_oid"[ ]*:[ ]*"\([0-9a-f]*\)".*/\1/p' "$_egvf")"

  if [ -z "$_egvtree" ]; then
    echo "commit-gate (BLOCKED): verdict file has no valid tree_oid (corrupt or edited?). Failing closed." >&2
    exit 1
  fi

  if [ "$_egverdict" != "PASS" ]; then
    echo "commit-gate (BLOCKED): recorded verdict is '${_egverdict:-none}', not PASS." >&2
    echo "  A FAIL is fixed, never overridden. Fix the findings and re-review." >&2
    exit 1
  fi

  if [ "$_egvtree" != "$_egtree_now" ]; then
    echo "commit-gate (BLOCKED): the staged tree does not match what was reviewed." >&2
    echo "  reviewed=$_egvtree  now=$_egtree_now" >&2
    echo "  The verdict authorizes only the exact reviewed content (this also catches" >&2
    echo "  'git commit -a' and late-staged changes). Re-review the staged tree, then re-record." >&2
    exit 1
  fi

  # Evidence check: validate-verdict.ps1 must exit 0 (has review evidence files
  # bound to the exact tree). Fail CLOSED if powershell is not available.
  _egps="$(command -v powershell 2>/dev/null)" || _egps=""
  if [ -z "$_egps" ]; then
    echo "commit-gate (BLOCKED): 'powershell' not found on PATH. Cannot verify review evidence. Failing closed." >&2
    exit 1
  fi
  if ! powershell -ExecutionPolicy Bypass -NoProfile -File "$_egroot/tools/validate-verdict.ps1" >&2; then
    exit 1
  fi

  return 0
}
