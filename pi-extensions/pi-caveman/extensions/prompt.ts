// Pure prompt-rendering logic for pi-caveman. Kept free of pi-coding-agent
// imports so it can be unit-tested without a Pi runtime. Settings reads are
// driven by `cwd` plus the `PI_CODING_AGENT_DIR` env var, exactly as pi-core
// resolves them at runtime.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type Mode = "off" | "lite" | "full" | "ultra" | "micro";
export type ActiveMode = Exclude<Mode, "off">;
export type VstackConfig = Record<string, unknown>;

export const MODE_VALUES: readonly Mode[] = ["off", "lite", "full", "ultra", "micro"];
export const CONFIG_ID = "@vanillagreen/pi-caveman";

export function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

export function projectSettingsPath(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		const candidate = join(current, ".pi", "settings.json");
		if (existsSync(candidate)) return candidate;
		if (existsSync(join(current, ".pi")) || existsSync(join(current, ".git")) || existsSync(join(current, ".vstack-lock.json"))) return candidate;
		const parent = dirname(current);
		if (parent === current) return join(resolve(cwd), ".pi", "settings.json");
		current = parent;
	}
}

export function piSettingsPaths(cwd = process.cwd()): string[] {
	const userDir = resolve(expandHome(process.env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent"));
	return [join(userDir, "settings.json"), projectSettingsPath(cwd)];
}

export function readVstackConfig(cwd?: string): VstackConfig {
	const merged: VstackConfig = {};
	for (const path of piSettingsPaths(cwd)) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const config = parsed?.vstack?.extensionManager?.config?.[CONFIG_ID];
			if (config && typeof config === "object" && !Array.isArray(config)) Object.assign(merged, config);
		} catch {
			// Ignore malformed optional manager config.
		}
	}
	return merged;
}

export function settingBoolean(key: string, fallback: boolean, cwd?: string): boolean {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "boolean" ? value : fallback;
}

export function settingString(key: string, fallback: string, cwd?: string): string {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "string" ? value : fallback;
}

export interface ConfigurationSource {
	source: "user" | "project" | "default";
	path?: string;
	userPath: string;
	projectPath: string;
	legacyKeys: string[];
}

// Walks user → project settings.json files (matching readVstackConfig order)
// and reports which file's `mode` key won the merge, plus any legacy keys
// (`enabled`, `defaultMode`) present alongside `mode`. Project wins on tie.
export function configurationSource(cwd?: string): ConfigurationSource {
	const [userPath, projectPath] = piSettingsPaths(cwd);
	const legacyKeys = new Set<string>();
	let sourcePath: string | undefined;
	let sourceLabel: "user" | "project" | "default" = "default";
	for (const [label, path] of [["user", userPath], ["project", projectPath]] as const) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const config = parsed?.vstack?.extensionManager?.config?.[CONFIG_ID];
			if (!config || typeof config !== "object" || Array.isArray(config)) continue;
			if (typeof config.mode === "string") {
				sourceLabel = label;
				sourcePath = path;
			}
			for (const key of ["enabled", "defaultMode"]) {
				if (key in config) legacyKeys.add(key);
			}
		} catch {
			// Ignore malformed optional manager config.
		}
	}
	return { source: sourceLabel, path: sourcePath, userPath, projectPath, legacyKeys: [...legacyKeys] };
}

// Best-effort read of the pi-claude-bridge extension-manager setting that
// controls whether the caveman block is forwarded into Claude's prompt.
// Does not consult bridge's own claude-bridge.json file (a separate channel);
// /caveman debug surfaces this caveat.
export function bridgeCavemanHookEnabled(cwd?: string): boolean | undefined {
	let value: boolean | undefined;
	for (const path of piSettingsPaths(cwd)) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const config = parsed?.vstack?.extensionManager?.config?.["@vanillagreen/pi-claude-bridge"];
			if (config && typeof config === "object" && !Array.isArray(config) && typeof config.includeCavemanHook === "boolean") {
				value = config.includeCavemanHook;
			}
		} catch {
			// Ignore malformed optional manager config.
		}
	}
	return value;
}

export function normalizeMode(input: string | undefined): Mode | undefined {
	const mode = (input ?? "").trim().toLowerCase();
	if (MODE_VALUES.includes(mode as Mode)) return mode as Mode;
	return undefined;
}

export function normalizeActiveMode(input: string | undefined): ActiveMode | undefined {
	const mode = normalizeMode(input);
	return mode && mode !== "off" ? mode : undefined;
}

// Trigger the hard clarity-escape (plain-prose reply for this turn) ONLY for
// explicit irreversible destructive operations the user is about to confirm
// or run. Soft signals (security/clarify/confused/ambiguous) used to live
// here and produced false escapes on routine technical turns; they belong in
// the model's inline judgment, not in a hard prompt swap.
export function shouldClarityEscape(prompt: string): boolean {
	return /(drop\s+table|rm\s+-rf|force[- ]?push|git\s+reset\s+--hard|git\s+push\s+(?:[^\n]*\s)?--force|\bdestructive\b|\birreversible\b)/i.test(prompt);
}

// Boundary lines kept compact and POSITIVE ("X stays normal English"). One
// short list line rather than four "Do NOT caveman-transform" sentences —
// the long boundary section was eating ~40% of the block and pushing the
// core style directive out of recency.
function boundaryClauses(cwd: string): string[] {
	const items: string[] = [];
	if (settingBoolean("boundaryNormalForCode", true, cwd)) items.push("code/commands/identifiers/quoted errors");
	if (settingBoolean("boundaryNormalForCommits", true, cwd)) items.push("commit messages and PR descriptions");
	if (settingBoolean("boundaryNormalForReviews", true, cwd)) items.push("formal reviews");
	if (settingBoolean("boundaryNormalForExternalWrites", true, cwd)) items.push("external writes (issue/PR bodies + comments, code review, chat/email)");
	return items;
}

function boundaryLine(cwd: string): string | undefined {
	const items = boundaryClauses(cwd);
	if (items.length === 0) return undefined;
	return `Boundaries — these stay normal English, NOT caveman: ${items.join("; ")}. Caveman = chat replies only.`;
}

export function instructions(mode: Mode, cwd: string, clarityEscape: boolean): string {
	if (mode === "off") return "";
	const suffix = settingString("customPromptSuffix", "", cwd).trim();
	const boundary = boundaryLine(cwd);

	// Clarity escape: irreversible destructive op detected. Write plain prose
	// for the whole reply. NO sentinel marker — the old `Caveman resume`
	// literal taught the model to use `Caveman <verb>:` as a labeling pattern
	// and leaked back into normal output ("Caveman ask:", "Caveman question:").
	// Mode resumes automatically next turn via re-injection by
	// before_agent_start.
	if (clarityEscape) {
		return [
			`You MUST respond in caveman ${mode} style normally — but THIS TURN is a safety override: write clear plain English prose for the entire reply, skip caveman style.`,
			"Caveman returns automatically next turn. Emit NO marker line, NO summary, NO label prefix like 'Caveman ___'.",
			boundary && `Boundaries already normal this turn too: ${boundaryClauses(cwd).join("; ")}.`,
			suffix,
			"You MUST keep this reply plain prose only.",
		].filter(Boolean).join("\n");
	}

	// Anti-markdown rule shared by every active mode. Live testing showed
	// Claude defaults to bold section headers (`**Section**`, `## Heading`)
	// for technical content even when told "no decorative headers" — the
	// behavior is baked into the base training, so the only thing that beats
	// it is concrete forbidden tokens plus a Bad/Good showing the alternative.
	// Same rule applied to every mode and the clean clarity branch so chat
	// replies render as continuous caveman/prose, not as a doc page.
	const antiMarkdown = "No markdown section headers. Forbidden tokens: `**Section**`, `## Heading`, `### Sub`, `**Word**` as a header line. Allowed: bare line breaks, inline em-dash transitions, an inline lead-in like `Cost:` or `Trade:` at line start (no asterisks, no hashes). Code blocks and inline code stay normal.";
	const antiMarkdownBadGood = "Bad header: \"**Why**\\n\\nObject ref new each render.\" — the asterisks make it a doc header, not caveman.\nGood header: \"Why: object ref new each render.\" — inline lead-in, caveman flows.";

	// Micro mode keeps a tight token budget. Earlier variant produced 3–5 KB
	// responses with markdown headers — not "prompt-minimized" at all. Lock in
	// a length anchor and the anti-markdown rule.
	if (mode === "micro") {
		return [
			"You MUST respond in caveman micro style for chat replies. You ARE a smart caveman engineer who answers in the FEWEST tokens that stay correct. Terse — fluff die, technical substance stay.",
			"Length anchor: typical reply ~80–200 tokens. Use longer only if the user explicitly asked for detail (\"walk me through\", \"explain in depth\", \"full breakdown\").",
			"Apply caveman from first token. No warmup (\"Let me\", \"Here's\", \"I'll\", \"Sure\"). No trailing summary.",
			antiMarkdown,
			"Drop articles, filler (just/really/basically/actually/simply), hedges (might/I think/sort of), pleasantries. Fragments OK. Technical terms + code exact. Pattern: [thing] [action] [reason]. [next step].",
			"Bad: \"Sure! Let me help. The reason your component re-renders is likely because you're creating a new object reference each render.\"",
			"Good: \"New object ref each render. Wrap in `useMemo`.\"",
			antiMarkdownBadGood,
			boundary,
			suffix,
			"Accuracy > terseness. Apply caveman to THIS reply now. Keep it short.",
		].filter(Boolean).join("\n");
	}

	// Per-mode delta: directive + one mode-specific example. Models follow
	// few-shot anchors far better than abstract rules — the previous version
	// had no example output anywhere in the block.
	const modeDirective: Record<Exclude<Mode, "off" | "micro">, { rule: string; example: string }> = {
		lite: {
			rule: "Lite: complete sentences, professional tone, active voice. Strip filler ('basically', 'essentially', 'just', 'really', 'simply', 'actually'), hedges ('could potentially', 'might possibly', 'I think', 'sort of'), and pleasantries. Drop decorative articles ('parses flags' beats 'parses the flags'); keep grammatical articles ('a Rust CLI'). Each sentence load-bearing.",
			example: "Lite example: \"Your component re-renders because you create a new object reference each render. Wrap it in `useMemo`.\"",
		},
		full: {
			rule: "Full: classic terse caveman. Drop articles where meaning survives. Fragments OK. Short synonyms preferred.",
			example: "Full example: \"New object ref each render. Inline obj prop = new ref = re-render. Wrap in `useMemo`.\"",
		},
		ultra: {
			rule: "Ultra: maximum compression. Abbreviate (DB/auth/config/req/res/fn/impl). Use → for causality. One word when one suffices.",
			example: "Ultra example: \"Inline obj prop → new ref → re-render. `useMemo`.\"",
		},
	};

	// Lite is a distinct register — tight professional prose with COMPLETE
	// sentences — not a softer caveman. Sharing the caveman identity line
	// + "fragments OK" Good example caused live testing to produce caveman-
	// style fragments under lite (bulleted one-word items, `=` shorthand,
	// `→` arrows). Give lite its own identity + its own Good example so the
	// model has a prose anchor instead of a fragment anchor.
	if (mode === "lite") {
		return [
			`You MUST respond in caveman lite style for chat replies. NOTE: 'lite' here means tight professional prose with COMPLETE SENTENCES, NOT compressed caveman shorthand. You ARE a tight professional engineer who writes complete sentences with all filler removed. Sentence-shape (subject + verb + object) every line.`,
			"Apply from first token. No warmup (\"Let me\", \"Here's\", \"I'll\", \"Sure\", \"Now I'm going to\"). No trailing summary or \"Want me to also…\" tails.",
			antiMarkdown,
			"Strip: filler (just/really/basically/actually/simply/essentially), hedges (might/I think/sort of/could potentially), pleasantries.",
			"Keep: complete sentences, grammatical articles ('a Rust CLI'), active voice, technical terms + code + identifiers + file paths + quoted errors exact.",
			"Drop only decorative articles ('parses flags' beats 'parses the flags'); keep grammatical ones.",
			`Bad (caveman shorthand, do NOT do this in lite): "New object ref each render. Inline obj prop = new ref → re-render. Wrap in useMemo."`,
			`Bad (decorative header, do NOT do this): "**Why**\\n\\nThe component re-renders because of inline objects."`,
			`Good: "Your component re-renders because you create a new object reference on every render. React's shallow prop comparison treats that as a new value and re-renders the child. Wrap the object in \`useMemo\` to keep the reference stable."`,
			"Hard rule: NO 'X = Y' equation shorthand, NO '→' arrow chains, NO one-word lines, NO bulleted list of single-word items. If you find yourself writing a fragment, expand it to a sentence.",
			boundary,
			suffix,
			"Accuracy beats terseness. Apply lite to THIS reply now — you MUST start the very next token in tight professional prose, complete sentences.",
		].filter(Boolean).join("\n");
	}

	// Length anchors per mode. Without these, all modes converge to the same
	// long technical-doc response with bold headers — Claude's default.
	const lengthAnchor: Record<"full" | "ultra", string> = {
		full: "Length anchor: typical reply ~150–350 tokens. Go longer only if the user explicitly asked for detail (\"walk me through\", \"explain in depth\", \"full breakdown\").",
		ultra: "Length anchor: typical reply ~80–250 tokens. Ultra is for punchy answers — if it takes a doc page, drop a mode and ask the user what they want.",
	};

	return [
		`You MUST respond in caveman ${mode} style for chat replies. You ARE a smart caveman engineer. Terse — fluff die, technical substance stay.`,
		lengthAnchor[mode as "full" | "ultra"],
		"Apply caveman from first token. No warmup (\"Let me\", \"Here's\", \"I'll\", \"Sure\", \"Now I'm going to\"). No trailing summary or \"Want me to also…\" tails.",
		antiMarkdown,
		"Drop: articles, filler (just/really/basically/actually/simply), hedges (might/I think/sort of), pleasantries.",
		"Keep exact: technical terms, code, identifiers, file paths, quoted errors.",
		"Pattern: [thing] [action] [reason]. [next step].",
		"Bad: \"Sure! Let me help. The reason your component re-renders is likely because you're creating a new object reference each render.\"",
		"Good: \"New object ref each render. Wrap in `useMemo`.\"",
		antiMarkdownBadGood,
		modeDirective[mode].rule,
		modeDirective[mode].example,
		// Inline auto-clarity for destructive confirmations the regex didn't
		// catch. Model self-elects plain prose, no sentinel — sentinel removed
		// system-wide to kill the "Caveman <verb>:" labeling leak.
		"Self-clarity: for an irreversible destructive op confirmation (force-push, drop table, rm -rf, hard reset, branch delete), switch that passage to plain prose inline. No marker line.",
		boundary,
		suffix,
		"Accuracy beats terseness when in conflict. Apply caveman to THIS reply now — you MUST start the very next token in caveman style.",
	].filter(Boolean).join("\n");
}
