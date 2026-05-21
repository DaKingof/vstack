import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Per-process cache. Project root + .env load are CLI-startup hot paths
// and were re-running git rev-parse + parsing on every helper call.
const projectRootCache = new Map<string, string>();
const envLoadedFor = new Set<string>();

// Resolve the canonical project root, walking out of a worktree to the
// main repo root so flightdeck state files always land in one canonical
// place. Mirrors the bash resolution in scripts/flightdeck-state.
export function resolveProjectRoot(cwd: string = process.cwd()): string {
	const cached = projectRootCache.get(cwd);
	if (cached) return cached;
	const top = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
	if (top.status !== 0 || !top.stdout.trim()) {
		process.stderr.write("Error: not inside a git repository\n");
		process.exit(2);
	}
	const root = top.stdout.trim();
	const common = spawnSync("git", ["-C", root, "rev-parse", "--git-common-dir"], { encoding: "utf8" });
	const gitCommonDir = common.stdout.trim();
	let resolved = root;
	if (gitCommonDir && gitCommonDir !== ".git") {
		// Worktree case — parent of `--git-common-dir` is the main repo root.
		resolved = resolve(dirname(resolve(root, gitCommonDir)));
	}
	projectRootCache.set(cwd, resolved);
	return resolved;
}

// Detect whether a .env file uses any shell feature that requires a
// real bash source (variable substitution, command substitution,
// arithmetic, control flow, line continuations, multi-line values).
// When it doesn't, we can parse natively and skip the bash subprocess.
//
// Conservative: any sign of shell syntax pushes to the bash path. The
// fast path only kicks in for the common case of `KEY=VALUE` and
// `KEY="VALUE"` lines with no expansion.
// Conservatively decide whether a .env line needs the real bash
// shell. Any sign of shell metacharacters, multi-assignment, inline
// trailing comments, escape sequences, or non-KEY=VALUE shape routes
// to the bash subprocess. The native path only handles the simple
// case where each non-comment line is exactly one bare assignment
// of plain or quoted text.
function usesShellFeatures(text: string): boolean {
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		// Any unquoted dollar, backtick, command sep, or substitution.
		if (/[$`;|&<>(){}]/.test(line)) return true;
		// Continuation lines or multi-line strings.
		if (line.endsWith("\\")) return true;
		// Escape sequences inside values — bash unescapes \n, \t, etc.
		// in $'...' and " \\ ..." forms; native can't replicate.
		if (line.includes("\\")) return true;
		// Anything that isn't a plain KEY=VALUE (or `export KEY=VALUE`)
		// must go through the bash path so commands like `false`,
		// `if`/`for`/`while`, function defs, and source/dot operate
		// against the real shell. A `=` after the (optional) `export `
		// prefix is required.
		const stripped = line.replace(/^export\s+/, "");
		if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(stripped)) return true;
		// Trailing inline comment after the value (e.g. KEY=foo # note)
		// is a bash feature — bash strips ` # ...` after an unquoted
		// value; native would include it as part of the value. Detect
		// by looking for a hash preceded by whitespace AFTER an opening
		// value that doesn't appear to be fully quoted.
		const eq = stripped.indexOf("=");
		const rhs = stripped.slice(eq + 1).trim();
		const fullyQuoted = (rhs.startsWith('"') && rhs.endsWith('"') && rhs.length >= 2) ||
			(rhs.startsWith("'") && rhs.endsWith("'") && rhs.length >= 2);
		if (!fullyQuoted && /\s#/.test(rhs)) return true;
		// Whitespace inside an unquoted RHS hints at multi-key export
		// or other shell behavior native can't replicate (e.g. `export
		// FD_A=1 FD_B=2`). Route to bash.
		if (!fullyQuoted && /\s/.test(rhs)) return true;
	}
	return false;
}

// Native fast-path parser for plain KEY=VALUE files. Mirrors bash
// `source` semantics for the subset of inputs that don't need shell
// expansion: assignments overwrite inherited env, single/double quoted
// values are unquoted, comments and blank lines are skipped, `export`
// prefix is honored.
function loadDotEnvNative(text: string): void {
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const stripped = line.replace(/^export\s+/, "");
		const eq = stripped.indexOf("=");
		if (eq <= 0) continue;
		const key = stripped.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		let value = stripped.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		// Match bash precedence: .env overwrites inherited env.
		(process.env as Record<string, string>)[key] = value;
	}
}

// Source the .env file via `bash` so we match bash's shell-expansion
// semantics — `$XDG_RUNTIME_DIR`, `${VAR:-fallback}`, comments, line
// continuations, etc. The previous TS-native parser diverged from bash
// on every project that used shell substitution in its .env.
//
// For .env files that don't use any shell features (the common case),
// a native fast-path parser skips the bash subprocess entirely. The
// subprocess fallback handles files with $VAR / ${VAR:-default} / `…`
// and other shell syntax; cost is ~5ms but only once per process
// thanks to envLoadedFor.
export function loadDotEnvIntoProcess(projectRoot: string): void {
	if (envLoadedFor.has(projectRoot)) return;
	envLoadedFor.add(projectRoot);
	const envLocal = join(projectRoot, ".env.local");
	const envBase = join(projectRoot, ".env");
	let target = "";
	if (existsSync(envLocal)) target = envLocal;
	else if (existsSync(envBase)) target = envBase;
	if (!target) return;
	// Native fast-path for the common case: read the file once, parse
	// natively. The bash subprocess only fires when shell syntax is
	// actually present.
	let text: string;
	try { text = readFileSync(target, "utf8"); }
	catch (e) {
		process.stderr.write(`Error: .env read failed: ${(e as Error).message}\n`);
		process.exit(2);
	}
	if (!usesShellFeatures(text)) {
		loadDotEnvNative(text);
		return;
	}
	// Source under `set -euo pipefail` so the load mirrors bash
	// originals exactly: assignments auto-export (-a), any failing
	// command aborts (-e), unbound variable references fail loud (-u),
	// and broken pipelines fail rather than silently masking errors
	// (pipefail). A `.env` with `FD_STATE_DIR=$MISPELLED_VAR` exits
	// nonzero rather than silently defaulting the state directory to
	// the wrong place.
	const script = `
		set -euo pipefail
		set -a
		# shellcheck disable=SC1090
		source "$1"
		set +a
		env -0
	`;
	// Pass process.env explicitly: Bun's spawnSync snapshots the env at
	// startup and ignores later mutations to process.env unless we hand
	// it through. Without this, ${VAR} substitution misses keys set
	// after process start.
	const r = spawnSync("bash", ["-c", script, "_", target], { encoding: "utf8", env: process.env as NodeJS.ProcessEnv });
	if (r.status !== 0) {
		// Bash runs scripts under `set -e` (and `set -euo pipefail` in
		// flightdeck-state.bash specifically); a failing `source .env`
		// aborts the script. Match that contract: fail loud, exit 2.
		process.stderr.write(`Error: .env load failed: ${r.stderr ?? ""}`);
		process.exit(2);
	}
	// Determine which keys are *declared* by the .env file by diffing
	// `compgen -v` (all shell variable names) before and after the
	// source. The previous regex-over-lines scan only saw the first
	// KEY= on each line, so `FD_A=one; FD_B=two` and `export FD_A=1
	// FD_B=2` silently dropped the second key. A snapshot diff is
	// authoritative against whatever bash actually assigned.
	const diffScript = `
		set -euo pipefail
		compgen -v | sort > /tmp/fd-env-before.$$
		set -a
		# shellcheck disable=SC1090
		source "$1"
		set +a
		compgen -v | sort > /tmp/fd-env-after.$$
		comm -13 /tmp/fd-env-before.$$ /tmp/fd-env-after.$$
		rm -f /tmp/fd-env-before.$$ /tmp/fd-env-after.$$
	`;
	const diffR = spawnSync("bash", ["-c", diffScript, "_", target], { encoding: "utf8", env: process.env as NodeJS.ProcessEnv });
	const declared = new Set<string>();
	if (diffR.status === 0) {
		for (const k of (diffR.stdout ?? "").split("\n")) {
			const key = k.trim();
			if (key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) declared.add(key);
		}
	} else {
		// Fall back to the regex scan if compgen diff fails (older bash,
		// exotic shells). Still better than dropping the import entirely.
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;
			const stripped = line.replace(/^export\s+/, "");
			const eq = stripped.indexOf("=");
			if (eq <= 0) continue;
			const key = stripped.slice(0, eq).trim();
			if (key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) declared.add(key);
		}
	}
	for (const entry of (r.stdout ?? "").split("\0")) {
		if (!entry) continue;
		const eq = entry.indexOf("=");
		if (eq <= 0) continue;
		const key = entry.slice(0, eq);
		if (!declared.has(key)) continue;
		// Project .env values must overwrite inherited environment
		// (matching `bash -c "set -a; source .env"` semantics). A previous
		// skip-if-set approach silently sent state files to different
		// directories whenever the outer shell had a preset FD_STATE_DIR
		// or FLIGHTDECK_STATE_DIR.
		(process.env as Record<string, string>)[key] = entry.slice(eq + 1);
	}
}
