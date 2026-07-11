# Dependency reconciliation

As the host running `npm ci`/`npm test` on the machine that will serve (or stage) the real event, I need to know what to do when `tools/check-deps-parity.ps1` reports installed-vs-locked drift, so the version I run matches the version CI already tested.

## When the parity check flags drift

`tools/check-deps-parity.ps1` prints a `PARITY MISMATCH` line per affected package and exits 1 when something under `node_modules/` does not match what `package-lock.json` resolved for it (see `README.md` Quickstart and `skills/session-brief.md` for where this check runs). The fix is always the same, regardless of which package or which direction the drift runs:

```powershell
npm ci
```

`npm ci` deletes `node_modules/` and reinstalls exactly what `package-lock.json` resolves — no version resolution, no surprise transitive bumps. Re-run `tools/check-deps-parity.ps1` afterward to confirm it now prints the all-clear line.

## Verify after reconciling

For a wedding-critical native dependency (`sharp`, `better-sqlite3` — see the list in `CLAUDE.md` § Dependency updates), confirm the reinstalled binary actually loads before trusting the checkout:

```powershell
node -e "require('sharp')"
```

Exit code 0 means the binary loaded. Then confirm it produces real output, not just an import:

```powershell
node -e "require('sharp')({create:{width:10,height:10,channels:3,background:{r:255,g:200,b:200}}}).resize({width:4}).jpeg().toBuffer().then(b=>console.log('thumbnail generated,', b.length, 'bytes'))"
```

## Why this is a plain reinstall, not a rollback

`DESIGN.md` § "sharp 0.35.2 SAC block was a reputation-lag, now cleared (#304)" is the record this procedure follows: the `ERR_DLOPEN_FAILED` failure that once blocked a freshly-installed sharp binary on this host was Windows Smart App Control withholding trust from a new, unhashed binary — not a permanent signing gap. Re-tested with SAC still in Enforce mode, a fresh `npm ci` installs the locked sharp version, `node -e "require('sharp')"` exits 0, and `npm test` is green. Nothing about the parity check changes that finding: a mismatch it reports is reconciled by installing the locked (newer) version, never by pinning back to an older one. There is no "blocked-upgrade" case to special-case here.
