# vstack GitHub issues sweep — 2026-05-15

Report on the W5 autonomous sweep of all 14 open issues against `vanillagreencom/vstack` at session start (2026-05-15). Output: PR #73 (`fix(vstack): address 11 open issues from 2026-05-15 sweep`) plus annotations on 3 upstream issues.

## Summary

| Metric | Value |
|---|---|
| Open issues at sweep start | 14 |
| Issues closed by this PR | 11 |
| Upstream pi-coding-agent issues (annotated, not coded) | 3 |
| Total commits on `vstack-issue-sweep` branch | 12 |
| New unit tests | ~129 |
| Reviewer rounds (combined) | 1 (all approved with minor findings) |
| PR opened | https://github.com/vanillagreencom/vstack/pull/73 |
| Pane agent used | `rust` agent reconfigured to `claude-bridge/claude-opus-4-7:xhigh` for the W5 run |

## Triage decisions

The 14 issues split cleanly into 7 in-vstack groups plus a 3-issue upstream-defer bucket:

| Group | Issues | Decision | Where the code lives |
|---|---|---|---|
| G1 daemon adhoc lifecycle | #57, #59, #61 | Fix | `skills/flightdeck/lib/flightdeck-core/src/{classifier,daemon}/` |
| G2 subscriber cleanup | #58 | Fix | `skills/flightdeck/lib/flightdeck-core/src/daemon/subscribers/` |
| G3 steer_subagent bug | #62 | Fix | `pi-extensions/pi-agents-tmux/extensions/subagent/` |
| G4 abandonment watchdog | #66 | Fix | `pi-extensions/pi-agents-tmux/extensions/subagent/` |
| G5 daemon wake noise | #68, #69 | Fix | `skills/flightdeck/lib/flightdeck-core/src/daemon/` |
| G6 daemon UX | #70, #72 | Fix | `skills/flightdeck/lib/flightdeck-core/src/daemon/` |
| G7 vstack install | #71 | Fix | `cli/src/commands/` |
| upstream-defer | #60, #63, #67 | Annotate | pi-coding-agent (pi-core) — outside vstack |

## Execution order (lowest-risk first)

1. **G3 (#62)** — smallest, validated the Opus 4.7 dispatch path. Root cause: `dashboardStatusFor` was destructured by `registerPaneSupportTools` but never passed in by `subagent/index.ts`. Fix: thread through + try/catch guard. Commit `67f349d`.
2. **G4 (#66)** — agent-end watchdog. New module `agent-end-watchdog.ts` writes a synthetic `needs_completion` outbox after `VSTACK_AGENT_END_WATCHDOG_GRACE_SEC` (10s default) when child `agent_end` fires without `complete_subagent`. O_EXCL race-safe; gated on `isIdle: true`. Commit `79832fd`.
3. **G1 (#57, #59, #61)** — three related daemon fixes for adhoc Pi lifecycle:
   - Classifier recognizes adhoc Pi idle as `terminal-state-reached` (`4956f41`).
   - Daemon reconciles tracked entries every 5s, spawning/reaping as needed (`5465d40`).
   - Pi subscriber emits wake for adhoc panes on idle transition (`0c737c9`).
4. **G2 (#58)** — pi-subscriber reaping on `pane-gone`. Verified G1's reconcile reap only covered registry-removal, not tmux-pane-destruction. Added shared `subscribers/reap.ts` with canonical SIGTERM → grace → SIGKILL. Commit `4ef5176`.
5. **G5 (#68, #69)** — wake noise reduction:
   - Bell wakes for non-canonical tags dropped entirely; canonical bells rate-limited per pane via `FD_BELL_WAKE_INTERVAL_SEC` (60s default). `ea88541`.
   - bg-task exit wakes respect `notifyOnExit` / `notifyMode` from pi-background-tasks payload. `b3f9ddc`.
6. **G6 (#70, #72)** — daemon UX:
   - Master-gone exit writes structured recovery hint at `$FD_STATE_DIR/fd-daemon-recovery-<session>.json`. `9a9dbce`.
   - Heartbeat optionally probes owner cgroup `memory.current`/`memory.peak` for v2; disable via `FD_HEARTBEAT_OWNER_CGROUP=0`. `64def81`.
7. **G7 (#71)** — `vstack add` now auto-includes skills referenced by selected agents (mapping + transitive deps), opt-out via `--no-auto-skills`. `vstack check` exits non-zero with per-skill warning when references are missing. `b589b79`.
8. **Cleanup** — addressed 7 minor reviewer findings as one commit (`dc67366`).

## Upstream issues — annotation only

These three are pi-coding-agent (pi-core) bugs that vstack cannot fix directly. Each issue now has a comment from this sweep documenting context + any vstack-side mitigation.

- **#60** — pi-bridge subagent panes share parent's session id. Vstack-side workaround: use `--socket` as canonical identifier. In-tree code already keys on tmux `pane_id` (%ID), so internal behavior is robust; external orchestrators must adapt.
- **#63** — subagent stalls after compaction. Partial mitigation via G4's agent-end watchdog (synthetic needs_completion). Root cause requires upstream resume-turn fix.
- **#67** — post-compaction edit-validation loop. Survival mitigations: G4 (watchdog catches the eventual give-up) + G5 (bell noise reduction limits parent flood). Root cause requires upstream force-re-read of edited files into post-compaction context.

## Review chain

One combined review round across all 11 sweep commits — arch + error + structure in parallel.

| Reviewer | Verdict | Findings |
|---|---|---|
| reviewer-arch | approve | 3 minors (parity hash divergence note, bell rate-limit comment, CLAUDE.md docs) |
| reviewer-error | approve | 2 minors (isPaneIdle throw default, EEXIST warn-log conflation) |
| reviewer-structure | approve | 2 minors (pi-adhoc-wake header comment, loop.ts follow-up extraction) |
| reviewer-doc | not invoked | docs-only nits folded into cleanup commit |

All 7 minors addressed in cleanup commit `dc67366`. No blockers, no majors.

## Reviewer findings not addressed (intentional)

- **loop.ts extraction** (reviewer-structure) — `daemon/loop.ts` grew 581 → 828 lines from reconcile + reap helpers. Reviewer suggested follow-up extraction into `daemon/pane-registry.ts`. Deferred as a non-behavioral refactor; not blocking.
- **TS/bash adhoc-pi hash parity** (reviewer-arch) — `decidePiAdhocWake` (TS) and bash mirror compute different dedup hashes. TS uses `paneId|tag|ts.slice(0,19)`, bash uses `paneId|tag|<assistant-text-hash>`. Runtime emit path is bash; TS is parity reference only. Deferred — only relevant once bash siblings retire (per the SKILL.md flightdeck-core parity rule).

## Validation gates at HEAD

```bash
cd skills/flightdeck/lib/flightdeck-core && bun test && bun run typecheck   # 398/398 pass, typecheck clean
cd pi-extensions/pi-agents-tmux && bun test                                 # 81 pass; 2 pre-existing session-lanes failures unrelated
cd cli && cargo fmt --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test --bin vstack   # 198/198 pass
```

## Pane-agent telemetry

W5 used the Opus 4.7 xhigh pane agent as requested. Backup of the GPT-5.5 config saved at `/tmp/rust-agent-w4-backup.md`. Agent model will be reverted post-session.

Tasks dispatched: 8 (one engineer per group + cleanup). All completed successfully. Average per-group time: ~3-5 min.

Failure modes observed during W5:
- Pre-existing 2 `pi-agents-tmux` `session-lanes` test failures (gpg signing in `tempGitRepo`). Reproduce on `main` HEAD; unrelated to any sweep change.
- No compaction stalls. No silent abandonments. No steer failures (the dispatched fixes for #62 and #66 may have helped, though the Opus 4.7 model may also be more reliable on long context than the gpt-5.5 used in W4).

## Followup work

- Land PR #73 against `main`.
- After merge, run `vstack refresh -g` in projects that consume vstack to pick up the daemon fixes.
- Pursue the upstream pi-coding-agent issues #60, #63, #67 separately.
- Optional structural follow-up: extract `loop.ts` pane-registry helpers per reviewer-structure's deferred minor.

## Related PRs

- **PR #64** — `flightdeck-dashboard-rust` → `main`. Rust dashboard with cost engine, themes, and confirmed write actions. Independent of this sweep.
- **PR #65** — `flightdeck-rich-activity` → `flightdeck-dashboard-rust`. Activity stream across all five harnesses. Independent of this sweep but expected to land after #64.
- **PR #73** — this sweep. Targets `main` directly.

All three PRs are mergeable independently of each other.

## Process notes

- One worktree (`vstack-issue-sweep`) used for the whole sweep; per-group engineer dispatches landed sequentially on the same branch. This kept review surface coherent and PR scope manageable.
- Per-issue micro-reviews skipped in favor of one combined review at the end. Worked well for fixes with focused scope; would not scale to larger refactors.
- Tracking via `tmp/triage.md` in the worktree; engineer briefs per group at `tmp/g*-engineer-brief.md`.
- All 11 commit bodies reference `Closes #N` for the issues they address.
