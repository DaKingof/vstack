#!/usr/bin/env node
// Vendored helper. Identical copy ships in every Pi extension package that
// declares `pi.appendSystem`. Keeping it self-contained avoids a runtime
// dependency between packages — npm runs it during `postinstall` and
// `preuninstall`, and vstack's Rust CLI implements the same upsert/remove
// logic in pi_extension.rs.
//
// Usage: node scripts/append-system.mjs <install|remove>
//
// Resolves the scope-appropriate APPEND_SYSTEM.md by:
//
// 1. Walking up from the package dir until it finds a `packages/` segment;
//    the parent of that segment is the Pi scope root (`~/.pi/agent` for
//    global, `<project>/.pi` for project). This handles vstack-driven
//    installs where the package is copied under `<scope>/packages/<name>`.
//
// 2. If no `packages/` segment is found (e.g. `pi install npm:` runs
//    `npm install -g`, which puts the package in npm's global prefix), we
//    fall back to the conventional Pi global dir from `PI_CODING_AGENT_DIR`
//    (or `~/.pi/agent`). We only act when that dir already exists — npm
//    installing one of these packages on a machine without Pi must not
//    create stray files.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const action = process.argv[2];
if (action !== "install" && action !== "remove") {
	console.error(`append-system.mjs: expected "install" or "remove", got "${action}"`);
	process.exit(1);
}

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let pkg;
try {
	pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
} catch {
	process.exit(0);
}

const name = typeof pkg?.name === "string" ? pkg.name : undefined;
const rel = pkg?.pi?.appendSystem;
if (!name || typeof rel !== "string") process.exit(0);

const scopeRoot = findScopeRoot(pkgDir);
if (!scopeRoot) process.exit(0);

const target = join(scopeRoot, "APPEND_SYSTEM.md");
const begin = `<!-- vstack:append-system ${name} begin -->`;
const end = `<!-- vstack:append-system ${name} end -->`;

try {
	if (action === "install") {
		const sourcePath = resolve(pkgDir, rel);
		if (!existsSync(sourcePath)) process.exit(0);
		const content = readFileSync(sourcePath, "utf8").trim();
		if (!content) process.exit(0);
		upsertBlock(target, begin, end, content);
	} else {
		removeBlock(target, begin, end);
	}
} catch (err) {
	// Never fail the npm install/uninstall over an APPEND_SYSTEM.md write.
	console.error(`append-system.mjs (${action}) for ${name}: ${err?.message ?? err}`);
	process.exit(0);
}

function findScopeRoot(start) {
	let dir = start;
	while (true) {
		const parent = dirname(dir);
		if (parent === dir) break;
		if (basename(parent) === "packages") return dirname(parent);
		dir = parent;
	}
	// Fallback: the conventional Pi global dir, but only when it already
	// exists. This catches `pi install npm:` (which uses `npm install -g`,
	// placing the package outside any `<scope>/packages/` tree) without
	// mutating arbitrary user state on machines without Pi installed.
	const configured = process.env.PI_CODING_AGENT_DIR;
	const piDir = configured ? resolve(configured.replace(/^~(?=\/|$)/, homedir())) : join(homedir(), ".pi", "agent");
	return existsSync(piDir) ? piDir : undefined;
}

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function strippedExisting(target, begin, end) {
	if (!existsSync(target)) return "";
	// Splice the begin..end span out without touching surrounding newlines,
	// then collapse 3+ consecutive newlines so a removed sandwiched block
	// doesn't leave a gap. trim leading/trailing newlines last.
	const re = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}`, "g");
	return readFileSync(target, "utf8")
		.replace(re, "")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\n+/, "")
		.replace(/\n+$/, "");
}

function upsertBlock(target, begin, end, content) {
	mkdirSync(dirname(target), { recursive: true });
	const stripped = strippedExisting(target, begin, end);
	const block = `${begin}\n${content}\n${end}`;
	const next = stripped ? `${stripped}\n\n${block}\n` : `${block}\n`;
	writeFileSync(target, next);
}

function removeBlock(target, begin, end) {
	if (!existsSync(target)) return;
	const stripped = strippedExisting(target, begin, end);
	if (stripped) {
		writeFileSync(target, `${stripped}\n`);
	} else {
		try {
			unlinkSync(target);
		} catch (err) {
			if (err?.code !== "ENOENT") throw err;
		}
	}
}
