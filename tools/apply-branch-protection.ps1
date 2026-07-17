# apply-branch-protection.ps1 -- require main to be up to date before merge.
#
# WHAT: PUTs GitHub branch protection onto `main` requiring a pull request,
# four named status checks, and required_status_checks.strict = true
# (GitHub's "require branches to be up to date before merging").
#
# WHY: two PRs can each go green against an older `main`, then both merge close
# together. The second merge lands without ever running CI against the tree
# that includes the first merge's changes -- `main` ends up in a state CI never
# actually checked. `strict = true` closes that: a branch that has fallen
# behind `main` must update and re-run CI before GitHub will allow the merge,
# serializing concurrent merges through CI instead of racing them.
#
# The four required checks are the real, observed check-run names on `main`
# (confirmed via `gh api repos/<slug>/commits/main/check-runs`), not job names
# guessed from the workflow YAML -- CodeQL's job is literally named
# `Analyze (javascript)`, not `CodeQL`, and a required context that never
# matches an actual check-run name would permanently block every merge.
# The proof-layer checks that used to appear in this set are gone -- the jobs
# that produced them were retired (see CLAUDE.md § "Governance freeze" and
# DESIGN.md's teardown ADR for what was removed and why).
#
# required_approving_review_count stays 0: the repo owner is a solo maintainer
# and GitHub does not let an author approve their own PR, so requiring >= 1
# would lock the owner out of merging their own work. CI plus review practice
# is the review gate here, not a human approval click -- see DESIGN.md
# "Branch protection on main".
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [string]$Branch = 'main',
  [switch]$EmitPayload
)

$gh = 'C:\Program Files\GitHub CLI\gh.exe'

# Slug resolution is deferred to the network path (just before the PUT) so that
# -EmitPayload never needs a resolvable repo or an authenticated `gh` -- the
# slug is only used to build the PUT/read-back URLs below, never to build the
# emitted $json itself.

# The four confirmed-real check-run names required on main.
$requiredChecks = @(
  'lint',
  'test',
  'smoke',
  'Analyze (javascript)'
)

# restrictions must be present and explicitly null in the payload -- GitHub's
# branch protection PUT replaces the whole object, and omitting a key is not
# the same as sending it as null. [ordered] preserves key order for readability;
# it has no effect on the JSON GitHub receives.
#
# checks (not contexts): GitHub's "Update branch protection" API marks
# required_status_checks.contexts as closing down in favor of `checks`, an
# array of {context, app_id} objects. app_id = -1 means "allow any app to set
# the status" -- the behavior-preserving equivalent of the old name-only
# contexts matching (omitting app_id would instead auto-select one specific
# app and could narrow which run satisfies the check).
$payload = [ordered]@{
  required_status_checks = [ordered]@{
    # strict=false: the owner turned up-to-date-before-merge off on 2026-07-17
    # (see DESIGN.md teardown ADR); re-running this tool must not re-enable it.
    strict = $false
    checks = @($requiredChecks | ForEach-Object { [ordered]@{ context = $_; app_id = -1 } })
  }
  enforce_admins          = $true
  required_pull_request_reviews = [ordered]@{
    required_approving_review_count = 0
  }
  restrictions            = $null
}

$json = $payload | ConvertTo-Json -Depth 8
# ConvertTo-Json emits a null-valued key as `"restrictions": null` (it does not
# drop it), which is what the PUT needs -- confirmed by inspecting $json below
# rather than assumed.
if ($json -notmatch '"restrictions"\s*:\s*null') {
  [Console]::Error.WriteLine('apply-branch-protection: built payload is missing "restrictions": null -- refusing to send a payload that would not explicitly clear push restrictions')
  exit 1
}

# -EmitPayload is the offline-testable seam: print the exact PUT body and exit
# before any network call, so CI can regression-guard the payload shape
# without live GitHub credentials.
if ($EmitPayload) {
  Write-Output $json
  exit 0
}

# `gh repo view` fails clearly when run outside a resolvable repo, so this empty
# -slug guard is also the "not in a repo" guard -- no separate git-repo check needed.
# Resolved only here, on the network path, so -EmitPayload above never needs it.
$slug = "$(& $gh repo view --json nameWithOwner -q .nameWithOwner 2>$null)".Trim()
if (-not $slug) { [Console]::Error.WriteLine('apply-branch-protection: could not resolve repo slug via gh repo view'); exit 1 }

$json | & $gh api --method PUT "repos/$slug/branches/$Branch/protection" --input - | Out-Null
if ($LASTEXITCODE -ne 0) {
  [Console]::Error.WriteLine("apply-branch-protection: PUT failed (exit $LASTEXITCODE). See gh's message above.")
  exit 1
}

# The tool now both sends and reads required checks under `checks`: the PUT
# body above writes required_status_checks.checks, and GitHub echoes that
# same key back on read, so this --jq expression needs no field-name mapping.
$readBack = & $gh api "repos/$slug/branches/$Branch/protection" --jq '{strict: .required_status_checks.strict, contexts: (.required_status_checks.checks | map(.context) | sort), approving_reviews: .required_pull_request_reviews.required_approving_review_count, enforce_admins: .enforce_admins.enabled}' 2>$null
if ($LASTEXITCODE -ne 0) {
  [Console]::Error.WriteLine("apply-branch-protection: applied protection but read-back failed (exit $LASTEXITCODE)")
  exit 1
}

Write-Output "branch protection applied to '$Branch' ($slug):"
Write-Output $readBack
