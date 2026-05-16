#!/usr/bin/env bun
// CLI for prompt classification.
// Reads buffer from --buffer-file or stdin; prints tag on stdout.
// --dry-run additionally prints the matched-line annotation when present.
//
// Bridge-state mode (vstack#57): pass --bridge-state-file <path> together
// with --entry-kind / --entry-harness to classify a Pi bridge-state JSON
// blob (isIdle + hasPendingMessages) instead of a tmux buffer. Adhoc Pi
// entries with isIdle=true && hasPendingMessages=false return
// terminal-state-reached so session-watch advances waiting -> complete.

import { readFileSync } from "node:fs";
import { classifyBuffer } from "../classifier/classify.ts";
import { classifyPiBridgeState, type PiBridgeStateLike } from "../classifier/pi-bridge-state.ts";

function usage(): never {
	process.stderr.write("Usage: prompt-classify [--buffer-file <path>] [--dry-run] [--no-footer-gate] [--entry-kind <kind>|--entry-kind-unknown] [--entry-harness <harness>] [--bridge-state-file <path>]\n");
	process.exit(2);
}

let bufferFile = "";
let bridgeStateFile = "";
let dryRun = false;
let noFooterGate = false;
let entryKind = "";
let entryHarness = "";
let entryKindProvided = false;
let entryKindUnknown = false;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
	const a = args[i]!;
	if (a === "--buffer-file") { bufferFile = args[++i] ?? ""; continue; }
	if (a.startsWith("--buffer-file=")) { bufferFile = a.slice("--buffer-file=".length); continue; }
	if (a === "--bridge-state-file") { bridgeStateFile = args[++i] ?? ""; continue; }
	if (a.startsWith("--bridge-state-file=")) { bridgeStateFile = a.slice("--bridge-state-file=".length); continue; }
	if (a === "--dry-run") { dryRun = true; continue; }
	if (a === "--no-footer-gate") { noFooterGate = true; continue; }
	if (a === "--entry-kind" || a === "--kind") { entryKind = args[++i] ?? ""; entryKindProvided = true; entryKindUnknown = false; continue; }
	if (a.startsWith("--entry-kind=") || a.startsWith("--kind=")) { entryKind = a.slice(a.indexOf("=") + 1); entryKindProvided = true; entryKindUnknown = false; continue; }
	if (a === "--entry-kind-unknown") { entryKind = "unknown"; entryKindProvided = true; entryKindUnknown = true; continue; }
	if (a === "--entry-harness" || a === "--harness") { entryHarness = args[++i] ?? ""; continue; }
	if (a.startsWith("--entry-harness=") || a.startsWith("--harness=")) { entryHarness = a.slice(a.indexOf("=") + 1); continue; }
	process.stderr.write(`Unknown flag: ${a}\n`);
	process.exit(2);
}

if (bridgeStateFile) {
	let raw: string;
	try {
		raw = readFileSync(bridgeStateFile, "utf8");
	} catch (err) {
		process.stderr.write(`Error: cannot read --bridge-state-file ${bridgeStateFile}: ${(err as Error).message}\n`);
		process.exit(2);
	}
	let parsed: PiBridgeStateLike | null = null;
	try {
		parsed = JSON.parse(raw) as PiBridgeStateLike;
	} catch (err) {
		process.stderr.write(`Error: --bridge-state-file is not valid JSON (${(err as Error).message}); routing as rendering.\n`);
	}
	const bridgeResult = classifyPiBridgeState(parsed, { entryKind, entryHarness });
	if (dryRun && bridgeResult.matched) process.stdout.write(`${bridgeResult.tag}\t${bridgeResult.matched}\n`);
	else process.stdout.write(`${bridgeResult.tag}\n`);
	usage; // silence unused
	process.exit(0);
}

let buf: string;
if (bufferFile) {
	buf = readFileSync(bufferFile, "utf8");
} else {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	buf = Buffer.concat(chunks).toString("utf8");
}

// Run the classifier twice: once permissively (entryKind: "issue") to know
// what tag the buffer would have produced absent any domain guard, and
// once with the caller's actual kind to apply the guard. The diff drives
// the stderr warning about issue-only tags hitting non-issue entries.
const unguarded = classifyBuffer(buf, { entryKind: "issue", noFooterGate });
const result = classifyBuffer(buf, { entryKind, entryKindUnknown, noFooterGate });
if (!entryKindProvided && result.tag === "domain-mismatch" && unguarded.tag !== result.tag) {
	process.stderr.write(`Warning: issue-only prompt tag ${unguarded.tag} classified without --entry-kind; routing as domain-mismatch. Pass --entry-kind issue for issue entries.\n`);
} else if (result.tag === "domain-mismatch" && unguarded.tag !== result.tag) {
	process.stderr.write(`Warning: issue-only prompt tag ${unguarded.tag} appeared on ${entryKind || "unknown"} entry; routing as domain-mismatch.\n`);
}
if (dryRun && result.matched) {
	process.stdout.write(`${result.tag}\t${result.matched}\n`);
} else {
	process.stdout.write(`${result.tag}\n`);
}
usage; // silence unused
