import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { minimizeShellOutput } from "../extensions/output-policy.ts";

const CONFIG_ID = "@vanillagreen/pi-output-policy";

function withConfig(config: Record<string, unknown>, run: (cwd: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-output-policy-test-"));
	try {
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({
			vstack: { extensionManager: { config: { [CONFIG_ID]: config } } },
		}, null, 2));
		run(dir);
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
}

describe("shell minimizer", () => {
	test("minimizes noisy successful cargo output by default", () => {
		withConfig({}, (cwd) => {
			const noisy = Array.from({ length: 180 }, (_, i) => `   Compiling crate_${i} v0.1.0`).join("\n");
			const text = `${noisy}\n    Finished test profile [unoptimized] target(s) in 4.72s\ntest result: ok. 41 passed; 0 failed`;
			const result = minimizeShellOutput(text, "cargo test", cwd);
			expect(result.dropped).toBeGreaterThan(0);
			expect(result.text).toContain("repetitive/noisy line(s) minimized");
			expect(result.text).toContain("Finished test profile");
			expect(result.text).toContain("test result: ok");
		});
	});

	test("respects shellMinimizer.enabled=false", () => {
		withConfig({ "shellMinimizer.enabled": false }, (cwd) => {
			const text = Array.from({ length: 130 }, (_, i) => `line ${i}`).join("\n");
			const result = minimizeShellOutput(text, "cargo test", cwd);
			expect(result.dropped).toBe(0);
			expect(result.text).toBe(text);
		});
	});
});
