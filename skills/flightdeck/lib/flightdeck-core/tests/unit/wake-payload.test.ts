// Unit test: wakePayloadForHarness matches the bash daemon's wake
// payload selector byte-for-byte.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import { wakePayloadForHarness } from "../../src/daemon/wake-payload.ts";

function bashWakePayload(harness: string): string {
	// Pure-function port of the bash daemon's wake_payload_for_harness
	// (vstack#13: pi-session-bridge now expands /skill:<name>
	// client-side before sendUserMessage, so pi uses the canonical
	// flightdeck skill command again).
	const script = [
		"wake_payload_for_harness() {",
		"  case \"${1:-}\" in",
		"    codex) printf '%s' '$flightdeck watch --from-daemon' ;;",
		"    pi)    printf '%s' '/skill:flightdeck watch --from-daemon' ;;",
		"    *)     printf '%s' '/flightdeck watch --from-daemon' ;;",
		"  esac",
		"}",
		"wake_payload_for_harness \"$1\"",
	].join("\n");
	const r = spawnSync("bash", ["-c", script, "_", harness], { encoding: "utf8" });
	return r.stdout ?? "";
}

describe("wakePayloadForHarness parity", () => {
	for (const h of ["codex", "pi", "claude", "opencode", "", "unknown"]) {
		test(`harness=${h || "(empty)"}`, () => {
			expect(wakePayloadForHarness(h)).toBe(bashWakePayload(h));
		});
	}

	test("case-insensitive", () => {
		expect(wakePayloadForHarness("CODEX")).toBe("$flightdeck watch --from-daemon");
		expect(wakePayloadForHarness("Pi")).toBe("/skill:flightdeck watch --from-daemon");
	});

	test("pi payload uses canonical /skill:flightdeck command (vstack#13)", () => {
		expect(wakePayloadForHarness("pi")).toBe("/skill:flightdeck watch --from-daemon");
		expect(wakePayloadForHarness("pi")).toContain("/skill:");
	});
});
