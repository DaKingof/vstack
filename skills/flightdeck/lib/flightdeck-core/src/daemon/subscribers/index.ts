// Per-harness subscriber spawn helpers. First-pass design (per dispatch
// option (a)): the subscriber LOOP BODY is the original bash body,
// spawned as a separate process so the TS daemon doesn't need to
// re-implement four long-running cooperative async streams.
//
// Each spawn function:
//   1. Checks the existing pid-file; if it points at a live pid, log
//      'reattaching' and return without spawning.
//   2. Spawns `bash -c <body>` with the relevant args as positional
//      params and env vars exported (FD_STATE_DIR, SESSION_LOCK,
//      WAKE_EVENTS_LOG, LOG, CLASSIFIER, OC_POLL_SEC, OC_BACKOFF_MAX_SEC).
//   3. Detaches the child so it survives the parent's exit
//      (`spawn(...).unref()` + `setsid`).
//   4. Records the child pid into the pid file.
//
// The subscriber body is sourced from scripts/lib/subscribers.bash via
// `bash -c "source subscribers.bash; <harness>_subscriber_loop ..."`,
// so this file only owns the spawn + detach + pidfile contract.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface SpawnSubResult { pid: number; reattached: boolean }

function pidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

// Common entry: read existing pid file, return non-null when an alive
// subscriber is present (caller should not spawn).
export function readExistingPid(pidFile: string): number | null {
	if (!existsSync(pidFile)) return null;
	try {
		const txt = readFileSync(pidFile, "utf8").trim();
		if (!/^[1-9][0-9]*$/.test(txt)) return null;
		const pid = Number.parseInt(txt, 10);
		if (pidAlive(pid)) return pid;
		return null;
	} catch { return null; }
}

// Spawn a subscriber body as `bash -c <body>` with positional args and
// inherited env. Returns the child pid. Detached + unref so the parent
// can exit without reaping.
export interface SpawnBodyOpts {
	body: string;
	args: string[];
	pidFile: string;
	env: NodeJS.ProcessEnv;
}

export function spawnSubscriberBody(opts: SpawnBodyOpts): number {
	const child = spawn("bash", ["-c", opts.body, "_", ...opts.args], {
		env: opts.env,
		stdio: ["ignore", "ignore", "ignore"],
		detached: true,
	});
	if (typeof child.pid !== "number") {
		throw new Error("spawn failed: no pid");
	}
	writeFileSync(opts.pidFile, `${child.pid}\n`);
	child.unref();
	return child.pid;
}
