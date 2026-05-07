---
description: Cut a new vstack GitHub feature release with CLI version/tag sync
argument-hint: "<patch|minor|major> [release notes hint]"
---
Cut a new vstack GitHub feature release. Requested bump / notes hint: `$ARGUMENTS`.

## Intent
Review all repository changes since the latest GitHub release, ensure docs/tests are current, bump the CLI version, create a matching GitHub release/tag, and leave the local repo clean and pushed.

## Hard rules
- Never release with dirty or untracked local files. Stop and ask if `git status --short` is non-empty.
- Never release from a branch that is behind or diverged from `origin/main`.
- Keep CLI package version and GitHub release tag exactly in sync:
  - `cli/Cargo.toml` `[package].version = X.Y.Z`
  - Git tag/release `vX.Y.Z`
- Do not bump npm Pi extension package versions as part of this template unless explicitly requested; use `/npm-deploy` for Pi extension npm publishing.
- Do not move an existing release pointer for a new feature release. Create a new version/tag/release.
- Stage only intended version/release-note/doc files.

## Preflight: clean and current
1. Inspect branch and status:
   ```bash
   git status --short --branch
   git fetch origin --tags
   git rev-parse --abbrev-ref HEAD
   git rev-list --left-right --count HEAD...origin/main
   ```
2. Require:
   - branch is `main`,
   - no dirty/untracked files,
   - no ahead/behind/diverged commits unless they are intentionally pushed before release.
3. If local commits are ahead, push them before continuing. If behind/diverged, stop and reconcile.
4. Confirm latest release:
   ```bash
   gh release list --limit 10
   git tag --sort=-v:refname | head
   ```

## Audit changes since latest release
1. Identify latest GitHub CLI release tag (normally latest `vX.Y.Z` from `gh release list`, not Pi package tags).
2. Inspect changes:
   ```bash
   git log --oneline <latest-release-tag>..HEAD
   git diff --stat <latest-release-tag>..HEAD
   git diff --name-only <latest-release-tag>..HEAD
   ```
3. Classify semver:
   - patch: bug fixes, docs, internal cleanup, non-breaking behavior fixes.
   - minor: additive CLI commands/options/features, new packages/extensions/agents/skills surfaced to users.
   - major: breaking CLI behavior, lock/config format break, removed/renamed commands/options, incompatible install behavior.
4. If the user supplied an explicit bump in `$1`, verify it is not lower than the change classification. Ask before using a lower bump.

## Documentation freshness check
Compare code changes to docs before bumping:
- Read affected docs/README files and changed source.
- Check CLI docs/help examples, AGENTS.md repo layout/rules, README feature lists, Pi extension docs if included, command flags, config keys, release/install commands, and examples.
- Ensure new commands/options/config fields/user-visible behavior are documented.
- Ensure removed/renamed/dead behavior is not still documented.
- Grep for stale old names/versions/config keys if renames happened.
- If docs are stale, update docs and commit those docs before the version bump, then restart preflight cleanliness/currentness.

## Validation before version bump
Run required validation for the changed areas:
- Always run CLI tests:
  ```bash
  cd cli && cargo test
  ```
- If CLI behavior/install paths changed, run an integration smoke in a temp dir, e.g.:
  ```bash
  tmp=$(mktemp -d)
  (cd "$tmp" && cargo run --manifest-path /mnt/Tertiary/dev/vstack/main/cli/Cargo.toml -- add /mnt/Tertiary/dev/vstack/main --all --copy -y)
  ```
  Read the printed scope summary and verify it is project-scoped in the temp dir.
- If Pi extensions changed in the release range, run each affected package's validation (`npm run check`, or available typecheck/test/build scripts) and consider `/npm-deploy` separately.
- If docs/examples changed only, run enough checks to confirm examples are still true.
- Do not release on failing validation unless the user explicitly accepts the risk.

## Bump CLI version
1. Compute next `X.Y.Z` from latest release and semver classification.
2. Update `cli/Cargo.toml` `[package].version` to `X.Y.Z`.
3. If `Cargo.lock` contains the `vstack` package version, update it by running appropriate cargo metadata/build/test command from `cli/`.
4. Re-run `cd cli && cargo test` after the version bump.
5. Confirm:
   ```bash
   grep '^version = ' cli/Cargo.toml
   git diff -- cli/Cargo.toml Cargo.lock
   ```
6. Commit only intended version files:
   ```bash
   git add cli/Cargo.toml Cargo.lock
   git commit -m "vstack: release vX.Y.Z"
   ```

## Create and push release
1. Ensure clean status after commit:
   `git status --short --branch`.
2. Push main:
   `git push origin main`.
3. Create annotated or lightweight tag matching CLI version exactly:
   `git tag vX.Y.Z`.
4. Push tag:
   `git push origin vX.Y.Z`.
5. Create GitHub release as latest:
   ```bash
   gh release create vX.Y.Z --title "vstack X.Y.Z" --generate-notes --latest
   ```
   If generated notes omit important highlights, edit the release notes with a concise summary from the audit.

## Final post-release checks
1. Verify GitHub release/tag:
   ```bash
   gh release view vX.Y.Z
   git ls-remote --tags origin vX.Y.Z
   ```
2. Confirm version/tag sync:
   - `cli/Cargo.toml` version is `X.Y.Z`.
   - Git tag and release are `vX.Y.Z`.
3. Confirm clean/current:
   ```bash
   git status --short --branch
   git rev-list --left-right --count HEAD...origin/main
   ```

## Final report
Report:
- latest previous release tag,
- semver classification and chosen new version,
- docs freshness findings/changes,
- validation commands/results,
- release commit and tag,
- GitHub release URL,
- final clean/current git status.
