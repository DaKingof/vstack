import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-caveman.installed");
const BRIDGE_SYMBOL = Symbol.for("vstack.pi.caveman");
const STATE_TYPE = "vstack-caveman:state";
const STATUS_KEY = "caveman";
const CONFIG_ID = "@vanillagreen/pi-caveman";

interface CavemanBridge {
	isActive(): boolean;
	getMode(): Mode;
	getLastActiveMode(): ActiveMode;
	subscribe(listener: () => void): () => void;
}

type Mode = "off" | "lite" | "full" | "ultra" | "micro";
type ActiveMode = Exclude<Mode, "off">;
type VstackConfig = Record<string, unknown>;

const MODE_VALUES: readonly Mode[] = ["off", "lite", "full", "ultra", "micro"];

const SUBCOMMAND_DESCRIPTIONS: Record<string, string> = {
	lite: "Caveman lite — professional, no fluff",
	full: "Caveman full — classic caveman",
	ultra: "Caveman ultra — maximum compression",
	micro: "Caveman micro — prompt-minimized compression",
	toggle: "Toggle caveman mode on/off",
};

interface CavemanState {
	mode: Mode;
	lastActiveMode: ActiveMode;
	source: "default" | "session";
	updatedAt: string;
}

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

function projectSettingsPath(cwd: string): string {
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

function piSettingsPaths(cwd = process.cwd()): string[] {
	const userDir = resolve(expandHome(process.env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent"));
	return [join(userDir, "settings.json"), projectSettingsPath(cwd)];
}

function readVstackConfig(cwd?: string): VstackConfig {
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

function settingBoolean(key: string, fallback: boolean, cwd?: string): boolean {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "boolean" ? value : fallback;
}

function settingString(key: string, fallback: string, cwd?: string): string {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "string" ? value : fallback;
}

function normalizeMode(input: string | undefined): Mode | undefined {
	const mode = (input ?? "").trim().toLowerCase();
	if (MODE_VALUES.includes(mode as Mode)) return mode as Mode;
	return undefined;
}

function normalizeActiveMode(input: string | undefined): ActiveMode | undefined {
	const mode = normalizeMode(input);
	return mode && mode !== "off" ? mode : undefined;
}

function defaultMode(cwd?: string): ActiveMode {
	return normalizeActiveMode(settingString("defaultMode", "full", cwd)) ?? "full";
}

function initialState(cwd?: string): CavemanState {
	const fallback = defaultMode(cwd);
	return {
		mode: settingBoolean("enabled", false, cwd) ? fallback : "off",
		lastActiveMode: fallback,
		source: "default",
		updatedAt: new Date().toISOString(),
	};
}

function statusLabel(mode: Mode): string | undefined {
	if (mode === "off") return undefined;
	if (mode === "full") return "CAVEMAN";
	return `CAVEMAN:${mode.toUpperCase()}`;
}

function shouldClarityEscape(prompt: string): boolean {
	return /(security|vulnerab|exploit|secret|token|password|credential|delete|drop\s+table|rm\s+-rf|destructive|irreversible|danger|confirm|clarify|confused|explain again|not clear|ambiguous)/i.test(prompt);
}

function instructions(mode: Mode, cwd: string, clarityEscape: boolean): string {
	if (mode === "off") return "";
	const boundaries: string[] = [];
	if (settingBoolean("boundaryNormalForCode", true, cwd)) boundaries.push("Code and code blocks stay normal; do not caveman-transform code, commands, identifiers, or quoted errors.");
	if (settingBoolean("boundaryNormalForCommits", true, cwd)) boundaries.push("Commit messages and PR descriptions stay normal unless user explicitly asks for caveman style there.");
	if (settingBoolean("boundaryNormalForReviews", true, cwd)) boundaries.push("Formal reviews stay normal unless user explicitly asks for caveman style there.");
	const suffix = settingString("customPromptSuffix", "", cwd).trim();
	if (clarityEscape) {
		return [
			"Caveman mode is active, but this turn appears to need safety/clarity. Use normal clear prose for warnings, irreversible actions, or clarification. After clear part, you may add a short 'Caveman resume.' note.",
			...boundaries,
			suffix,
		].filter(Boolean).join("\n");
	}
	if (mode === "micro") {
		const compactBoundaries: string[] = [];
		if (settingBoolean("boundaryNormalForCode", true, cwd)) compactBoundaries.push("Code/commands/identifiers/quoted errors unchanged.");
		if (settingBoolean("boundaryNormalForCommits", true, cwd)) compactBoundaries.push("Commit/PR text normal unless user asks caveman.");
		if (settingBoolean("boundaryNormalForReviews", true, cwd)) compactBoundaries.push("Formal reviews normal unless user asks caveman.");
		return [
			"Token efficiency mode: terse smart caveman.",
			"Cut filler/pleasantries/hedging. Fragments OK. Technical terms exact. Accuracy > brevity.",
			"Use normal clarity for security/destructive/ambiguous turns, then resume.",
			...compactBoundaries,
			suffix,
		].filter(Boolean).join("\n");
	}
	const modeText: Record<Exclude<Mode, "off" | "micro">, string> = {
		lite: "Lite: remove filler, hedging, and pleasantries. Keep articles and professional complete sentences, but be tight.",
		full: "Full: terse smart caveman. Drop articles/filler/hedging. Fragments OK. Pattern: [thing] [action] [reason]. [next step]. Technical terms exact.",
		ultra: "Ultra: maximum terse English. Abbreviate common technical words, use arrows for causality, one word when one word enough. Preserve exact technical terms.",
	};
	return [
		"Caveman communication mode active for assistant natural-language chat.",
		modeText[mode],
		"No pleasantries. No filler. No unnecessary hedging. Accuracy over terseness if conflict.",
		"Auto-clarity rule: for security warnings, irreversible actions, confusing multi-step sequences, or user confusion, temporarily use normal clarity; resume caveman after clear part.",
		...boundaries,
		suffix,
	].filter(Boolean).join("\n");
}

function restoreState(ctx: ExtensionContext): CavemanState {
	let state = initialState(ctx.cwd);
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
		const data = entry.data as Partial<CavemanState> | undefined;
		const mode = normalizeMode(data?.mode);
		if (!mode) continue;
		const lastActiveMode = normalizeActiveMode(data?.lastActiveMode) ?? (mode !== "off" ? mode : state.lastActiveMode);
		state = {
			mode,
			lastActiveMode,
			source: data?.source === "default" ? "default" : "session",
			updatedAt: data?.updatedAt ?? new Date().toISOString(),
		};
	}
	return state;
}

function statusText(state: CavemanState): string {
	return state.mode === "off" ? "Caveman off." : `Caveman ${state.mode} active.`;
}

export default function caveman(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;

	let state: CavemanState = initialState();
	let activeCtx: ExtensionContext | undefined;
	const listeners = new Set<() => void>();
	const notifyListeners = () => {
		for (const listener of [...listeners]) {
			try { listener(); } catch { /* swallow listener errors */ }
		}
	};

	const host = globalThis as unknown as Record<PropertyKey, unknown>;
	const bridge: CavemanBridge = {
		isActive: () => state.mode !== "off",
		getMode: () => state.mode,
		getLastActiveMode: () => state.lastActiveMode,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
	};
	host[BRIDGE_SYMBOL] = bridge;

	const persist = () => pi.appendEntry<CavemanState>(STATE_TYPE, { ...state, updatedAt: new Date().toISOString() });
	const syncStatus = (ctx?: ExtensionContext) => {
		const runCtx = ctx ?? activeCtx;
		if (!runCtx?.hasUI) return;
		runCtx.ui.setStatus(STATUS_KEY, settingBoolean("showStatusBadge", true, runCtx.cwd) ? statusLabel(state.mode) : undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		state = restoreState(ctx);
		syncStatus(ctx);
		notifyListeners();
	});
	pi.on("session_tree", (_event, ctx) => {
		activeCtx = ctx;
		state = restoreState(ctx);
		syncStatus(ctx);
		notifyListeners();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		notifyListeners();
	});

	const applySubcommand = async (sub: string, ctx: ExtensionContext) => {
		activeCtx = ctx;
		const arg = sub.trim().toLowerCase();
		if (arg === "status") {
			ctx.ui.notify(statusText(state), "info");
			return;
		}
		let mode: Mode | undefined;
		if (!arg || arg === "toggle") {
			mode = state.mode === "off" ? state.lastActiveMode || defaultMode(ctx.cwd) : "off";
		} else {
			mode = normalizeMode(arg);
		}
		if (!mode) {
			ctx.ui.notify("Unknown caveman mode. Try lite, full, ultra, micro, toggle, off, or status.", "warning");
			return;
		}
		if (!settingBoolean("sessionOverrideAllowed", true, ctx.cwd)) {
			ctx.ui.notify("Session override disabled in caveman settings.", "warning");
			return;
		}
		const lastActiveMode: ActiveMode = mode === "off" ? state.lastActiveMode : mode;
		state = { mode, lastActiveMode, source: "session", updatedAt: new Date().toISOString() };
		persist();
		syncStatus(ctx);
		notifyListeners();
		ctx.ui.notify(mode === "off" ? "Caveman off." : `Caveman ${mode} active.`, "info");
	};

	pi.registerCommand("caveman", {
		description: "Token-efficient caveman response mode.",
		handler: async (args, ctx) => applySubcommand(args, ctx),
	});

	for (const sub of ["lite", "full", "ultra", "micro", "toggle"] as const) {
		pi.registerCommand(`caveman:${sub}`, {
			description: SUBCOMMAND_DESCRIPTIONS[sub],
			handler: async (_args, ctx) => applySubcommand(sub, ctx),
		});
	}

	pi.on("before_agent_start", (event, ctx) => {
		activeCtx = ctx;
		if (state.source === "default") state = initialState(ctx.cwd);
		if (state.mode === "off") {
			syncStatus(ctx);
			return undefined;
		}
		const clarity = settingBoolean("autoClarityEscape", true, ctx.cwd) && shouldClarityEscape(event.prompt ?? "");
		const prompt = instructions(state.mode, ctx.cwd, clarity);
		if (clarity && !settingBoolean("resumeAfterClarityEscape", true, ctx.cwd)) {
			state = { mode: "off", lastActiveMode: state.lastActiveMode, source: "session", updatedAt: new Date().toISOString() };
			persist();
			notifyListeners();
		}
		syncStatus(ctx);
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});
}
