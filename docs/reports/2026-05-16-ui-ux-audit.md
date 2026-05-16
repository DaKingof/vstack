# Flightdeck UI/UX audit + adhoc/Linear end-to-end validation (2026-05-16)

Companion to `2026-05-16-vstack-full-sweep-final.md`. Records the dedicated UI/UX audit pass and the additional simulated-environment validation, plus the 6 new issues discovered + fixed during that pass.

## Outcome

- **3 additional PRs merged**: #86 (UI polish: #80–84), #87 (#85 adhoc-shell + teardown-force).
- **6 issues discovered + closed**: #80, #81, #82, #83, #84, #85.
- **End-to-end validation**: real Linear lifecycle + real GitHub `pr-view` events rendered correctly in the dashboard Activity tab.

## Audit method

Used `flightdeck-dashboard tui --demo <name> --theme <theme>` across all compiled-in demos (mixed, empty, paused, terminated, observer, conversations, decisions, no-issue) and all 4 themes (moon, dawn, pantera, system). For each combination, captured the Overview tab + all 7 tabs (Activity, Conversations, Conflicts & merges, Decisions, Costs, Daemon) + all popups (theme picker, filter, detail, prune confirm, focus confirm, help). 25+ tmux pane captures + raw ANSI inspection for color rendering.

Plus real-world simulation:
- `flightdeck-session start --harness shell --kind adhoc` to spawn a real adhoc shell pane through the canonical flightdeck-session script and observe lifecycle.
- Real Linear API: created CC-514–518 (now archived), exercised the full create → update → cancel lifecycle through the `linear.sh` wrappers.
- Real GitHub API: `pr-view 81 --json statusCheckRollup` against a real merged hyprtrade PR.
- Real activity sidecar + dashboard rendering combining BOTH Linear and GitHub events in one stream.

## Issues discovered during the audit (all closed)

### #80 — Sessions table + Costs tab column truncation/collision

Overview sessions table truncated Title/Decision/PR-worktree mid-word ("Fix dashboard", "Build Rust das", "bash-permission-promp", "PR #44 · vst-1"). Costs tab Session column collided with Harness column when name was too long ("dashboard-rustcodex"). **Fix:** ellipsis truncation across all narrow columns; fixed Session column width.

### #81 — Header truncates chip text instead of dropping chips

`terminated` demo showed `1 cost source unhealthy` cut to `1 cost` at 140 cols. **Fix:** drop chips in reverse priority order on overflow; cost chip has verbose/compact/drop fallback so it coexists with terminated/stale badges.

### #82 — Activity tab Status icon inconsistency

`!` prefix appeared on both `ok` and `warn` rows in the Activity tab — color was the only differentiator. **Fix:** distinct ASCII tokens per severity; success/info `·`, warning `!`, error `✗`.

### #83 — Tab/panel label cleanups

Decisions panel border included `Enter opens answer detail` (redundant with footer). Tabs row had `Conflicts & merges (issue mode)` parenthetical. Right rail had a "Click any decision for full text" hint mixed with data rows. **Fix:** all three cleaned up.

### #84 — Cost chip `T` ambiguity

Header showed `$0.00/0T` where `T` was unclear (turns vs tokens). **Fix:** lowercase `t` matches Costs tab convention.

### #85 — Adhoc shell sessions stuck + teardown --force refused

Two related bugs surfaced when spawning a real adhoc shell pane:

1. After the shell pane process exits, the registry entry stays in `state=waiting` forever — no terminal-state classifier for `harness=shell` (W5 G1 only covered `harness=pi`).
2. `pane-registry teardown-entry --force` refuses to clean up a stale entry when state is `waiting` and pane is gone — the `--force` flag should override.

**Fix:** new `src/daemon/shell-adhoc-wake.ts` for pane-gone → `complete` transition; `teardown --force` now drops the stale entry when pane is verifiably gone and emits `entry.cancelled` / `entry.dead`.

**Round-2 review caught a HIGH severity:** the initial fix made `livePanesAndWindows()` return an empty set on tmux probe failure, which would mass-transition every adhoc-shell entry to `complete` AND mass-drop other entries as `dead` on any transient tmux hiccup. Fix landed as `0a0c708e`: tagged Result + early-exit on probe failure across all destructive callers. Plus an LOW finding (F2): teardown --force respects `window_id` fallback when `pane_id` is empty but window is still live.

## End-to-end validation

```
CC-518 created → linear.issue_created (info)
CC-518 → In Progress → linear.issue_updated (info)
gh pr view 81 → pr.checks_passed (success)
CC-518 → Canceled → linear.issue_cancelled (warning)
```

All 4 events landed in one activity JSONL with correct `source` field (`linear` vs `github`), severity, and refs. Dashboard Activity tab rendered all 4 rows newest-first with correct status icons (post-#82-fix: `·`, `·`, `·`, `!` for severity-appropriate icons).

Live transition memory verified: re-running `pr-view 81 --json statusCheckRollup` did NOT duplicate the emit (`flock`-wrapped read-compare-write from W5 PR #75 works under load).

## Stats — this round

- **3 PRs merged** (#86, #87 + this report PR).
- **2 reviewer rounds** on #87 (round 1 caught a HIGH that would have mass-transitioned every entry; round 2 approved).
- **6 issues closed**.
- **Total new tests**: ~12 for the UI snapshots + 11 for #85 (+ 4 regression tests in round 2 for F1/F2 scenarios).

## Critical lessons

1. **Audit with compiled-in demos AND with real spawning.** The compiled-in `mixed` demo never showed the adhoc-shell terminal-state bug because demo fixtures bypass the live reconcile loop. Only spawning a real `flightdeck-session start --harness shell` surfaced it.

2. **Reviewer-error round-1 on a 2-bug-fix commit caught the HIGH severity third-party effect.** The original #85 fix correctly addressed the two named issues but introduced a NEW failure mode: tmux probe failure → mass mutation. The mass-mutation risk was nowhere in the original issue description — it was a side effect of the chosen fix shape. Without round-1 review, this would have shipped.

3. **Snapshot-based tests catch structure but not behavior shifts.** The UX cleanups (#80–84) all passed snapshot tests after `cargo insta accept`. The behavioral fixes (#85) needed parity tests that exercise the daemon reconcile path with stubbed tmux failures — those tests now exist.

## Worktrees (all merged and safe to remove)

- `/mnt/Tertiary/dev/vstack/trees/vstack-ux-fixes` — #80–84 (merged via #86)
- `/mnt/Tertiary/dev/vstack/trees/vstack-issue-85` — #85 (merged via #87)

## Final state (since last report)

- **0 open issues** on `vanillagreencom/vstack`.
- **Rust agent reverted** to `openai-codex/gpt-5.5:xhigh`.
