// flightdeck-daemon CLI behavior — no-daemon paths + tmux gating.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "../../../../scripts/flightdeck-daemon");

if (!process.env.TMUX) {
	test.skip("flightdeck-daemon tests require tmux", () => undefined);
}

function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	const r = spawnSync(SCRIPT, args, { encoding: "utf8", env });
	return { status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

const SESSION = process.env.TMUX_PARITY_SESSION ?? sessionName();

function sessionName(): string {
	const r = spawnSync("tmux", ["display-message", "-p", "#S"], { encoding: "utf8" });
	return (r.stdout ?? "").trim();
}

describe("flightdeck-daemon (no-daemon paths)", () => {
	test("status: no daemon → exit 1", () => {
		const r = run(["status", "--session", "NO-SUCH-SESSION"]);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("no daemon");
	});

	test("find-window: unresolved session → exit 1", () => {
		const r = run(["find-window", "--session", "NO-SUCH-SESSION"]);
		expect(r.status).toBe(1);
	});

	test("health: no daemon → exit 1", () => {
		const r = run(["health", "--session", "NO-SUCH-SESSION"]);
		expect(r.status).toBe(1);
	});

	test("stop: no daemon → exit 1", () => {
		const r = run(["stop", "--session", "NO-SUCH-SESSION"]);
		expect(r.status).toBe(1);
	});

	test("missing --session → exit 2", () => {
		const r = run(["status"]);
		expect(r.status).toBe(2);
	});

	test("unknown action → exit 2", () => {
		const r = run(["bogus", "--session", SESSION]);
		expect(r.status).toBe(2);
	});

	test("ack --session s999999 → no-daemon path without tmux preflight", () => {
		// Session-key form (sN) doesn't need tmux. Should return cleanly.
		const r = run(["ack", "--session", "s999999"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});
});

describe("flightdeck-daemon preflight (tmux gating)", () => {
	function sandboxPathWithout(exclude: string[]): string {
		const { mkdtempSync, mkdirSync, symlinkSync, readdirSync } = require("node:fs") as typeof import("node:fs");
		const { tmpdir } = require("node:os") as typeof import("node:os");
		const { join } = require("node:path") as typeof import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "fd-preflight-"));
		const binDir = join(dir, "bin");
		mkdirSync(binDir);
		for (const pathDir of (process.env.PATH ?? "").split(":")) {
			if (!pathDir) continue;
			let entries: string[];
			try { entries = readdirSync(pathDir); } catch { continue; }
			for (const entry of entries) {
				if (exclude.includes(entry)) continue;
				const dst = join(binDir, entry);
				try { symlinkSync(join(pathDir, entry), dst); } catch { /* skip dupes */ }
			}
		}
		return binDir;
	}

	test("status --session <name> with tmux missing → exit 2", () => {
		const path = sandboxPathWithout(["tmux"]);
		const env = { ...(process.env as Record<string, string>), PATH: path } as Record<string, string>;
		delete (env as Record<string, string | undefined>).TMUX;
		const r = spawnSync(SCRIPT, ["status", "--session", "some-name"], { encoding: "utf8", env });
		expect(r.status).toBe(2);
	});

	test("ack --session s999999 with tmux missing → not gated on tmux", () => {
		// Session-key form (sN) means we don't need tmux. Preflight
		// should pass and the ack should succeed (empty output, exit 0).
		const path = sandboxPathWithout(["tmux"]);
		const env = { ...(process.env as Record<string, string>), PATH: path } as Record<string, string>;
		delete (env as Record<string, string | undefined>).TMUX;
		const r = spawnSync(SCRIPT, ["ack", "--session", "s999999"], { encoding: "utf8", env });
		expect(r.status).not.toBe(2);
	});
});
