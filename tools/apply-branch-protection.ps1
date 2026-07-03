# apply-branch-protection.ps1 -- require main to be up to date before merge.
#
# WHAT: PUTs GitHub branch protection onto `main` requiring a pull request,
# five named status checks, and required_status_checks.strict = true (GitHub's
# "require branches to be up to date before merging").
#
# WHY: two PRs can each go green against an older `main`, then both merge close
# together. The second merge lands without ever running CI against the tree
# that includes the first merge's changes -- `main` ends up in a state CI never
# actually checked. `strict = true` closes that: a branch that has fallen
# behind `main` must update and re-run CI before GitHub will allow the merge,
# serializing concurrent merges through CI instead of racing them.
#
# The five required checks are the real, observed check-run names on `main`
# (confirmed via `gh api repos/<slug>/commits/main/check-runs`), not job names
# guessed from the workflow YAML -- CodeQL's job is literally named
# `Analyze (javascript)`, not `CodeQL`, and a required context that never
# matches an actual check-run name would permanently block every merge.
#
# required_approving_review_count stays 0: the repo owner is a solo maintainer
# and GitHub does not let an author approve their own PR, so requiring >= 1
# would lock the owner out of merging their own work. The owner's manual
# merge click is the review gate here, not a second approver.
#
# Idempotent by construction: this always PUTs the same fixed payload, so
# running it twice produces the same protection state both times.
#
# Windows PowerShell 5.1-compatible: no ternary, no ??, no &&, no ||.
param(
  [string]$Branch = 'main'
)

$gh = 'C:\Program Files\GitHub CLI\gh.exe'

# `gh repo view` fails clearly when run outside a resolvable repo, so this empty
# -slug guard is also the "not in a repo" guard -- no separate git-repo check needed.
$slug = "$(& $gh repo view --json nameWithOwner -q .nameWithOwner 2>$null)".Trim()
if (-not $slug) { [Console]::Error.WriteLine('apply-branch-protection: could not resolve repo slug via gh repo view'); exit 1 }

# The five confirmed-real check-run names observed on main. Not derived from
# workflow job names -- CodeQL's produced check-run name differs from its
# workflow/job label, so this list must match `check-runs`, not `ci.yml`.
$requiredChecks = @(
  'commit-gate-integrity',
  'lint',
  'test',
  'merge-association',
  'Analyze (javascript)'
)

# restrictions must be present and explicitly null in the payload -- GitHub's
# branch protection PUT replaces the whole object, and omitting a key is not
# the same as sending it as null. [ordered] preserves key order for readability;
# it has no effect on the JSON GitHub receives.
$payload = [ordered]@{
  required_status_checks = [ordered]@{
    strict   = $true
    contexts = $requiredChecks
  }
  enforce_admins          = $true
  required_pull_request_reviews = [ordered]@{
    required_approving_review_count = 0
  }
  restrictions            = $null
}

$json = $payload | ConvertTo-Json -Depth 6
# ConvertTo-Json emits a null-valued key as `"restrictions": null` (it does not
# drop it), which is what the PUT needs -- confirmed by inspecting $json below
# rather than assumed.
if ($json -notmatch '"restrictions"\s*:\s*null') {
  [Console]::Error.WriteLine('apply-branch-protection: built payload is missing "restrictions": null -- refusing to send a payload that would not explicitly clear push restrictions')
  exit 1
}

$json | & $gh api --method PUT "repos/$slug/branches/$Branch/protection" --input - | Out-Null
if ($LASTEXITCODE -ne 0) {
  [Console]::Error.WriteLine("apply-branch-protection: PUT failed (exit $LASTEXITCODE). See gh's message above.")
  exit 1
}

# Field-name asymmetry is expected, not a bug: GitHub accepts the required checks
# written under the `contexts` key but returns them on read as `.checks[].context`.
$readBack = & $gh api "repos/$slug/branches/$Branch/protection" --jq '{strict: .required_status_checks.strict, contexts: (.required_status_checks.checks | map(.context) | sort), approving_reviews: .required_pull_request_reviews.required_approving_review_count, enforce_admins: .enforce_admins.enabled}' 2>$null
if ($LASTEXITCODE -ne 0) {
  [Console]::Error.WriteLine("apply-branch-protection: applied protection but read-back failed (exit $LASTEXITCODE)")
  exit 1
}

Write-Output "branch protection applied to '$Branch' ($slug):"
Write-Output $readBack
