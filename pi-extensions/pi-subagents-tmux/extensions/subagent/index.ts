/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	formatSize,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
	truncateHead,
	truncateTail,
	type TruncationResult,
	withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "./agents.js";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-subagents-tmux.installed");
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PANE_LAUNCHER_VERSION = 6;
const FIRST_AGENT_COLUMN_ROWS = 3;
const NEXT_AGENT_COLUMN_ROWS = 4;
const DETAIL_STRING_MAX_CHARS = 8 * 1024;
const DEFAULT_RESULT_MAX_BYTES = 100 * 1024;
const DEFAULT_RESULT_MAX_LINES = 4_000;

type VstackConfig = Record<string, unknown>;

function expandHome(input: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return input;
}

function piUserDir(): string {
	return path.resolve(expandHome(process.env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent"));
}

function sessionIdForContext(ctx: ExtensionContext): string {
	const id = ctx.sessionManager.getSessionId();
	if (id && id.trim()) return id;
	const file = ctx.sessionManager.getSessionFile();
	if (file) return path.basename(file, path.extname(file));
	return `ephemeral-${process.pid}`;
}

function runtimeSessionId(ctx: ExtensionContext): string {
	return process.env.PI_SUBAGENT_PARENT_SESSION_ID?.trim() || sessionIdForContext(ctx);
}

function sessionRuntimeDir(sessionId: string): string {
	return path.join(piUserDir(), "vstack", "pi-subagents-tmux", "sessions", safeFileName(sessionId));
}

function runtimeDirForContext(ctx: ExtensionContext): string {
	return sessionRuntimeDir(runtimeSessionId(ctx));
}

function projectSettingsPath(cwd: string): string {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, ".pi", "settings.json");
		if (fs.existsSync(candidate)) return candidate;
		if (fs.existsSync(path.join(current, ".pi")) || fs.existsSync(path.join(current, ".git")) || fs.existsSync(path.join(current, ".vstack-lock.json"))) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return path.join(path.resolve(cwd), ".pi", "settings.json");
		current = parent;
	}
}

function piSettingsPaths(cwd = process.cwd()): string[] {
	return [path.join(piUserDir(), "settings.json"), projectSettingsPath(cwd)];
}

function readVstackConfig(cwd?: string): VstackConfig {
	const merged: VstackConfig = {};
	for (const settingsPath of piSettingsPaths(cwd)) {
		if (!fs.existsSync(settingsPath)) continue;
		try {
			const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
			const config = parsed?.vstack?.extensionManager?.config?.["pi-subagents-tmux"];
			if (config && typeof config === "object" && !Array.isArray(config)) Object.assign(merged, config);
		} catch {
			// Ignore malformed optional manager config.
		}
	}
	return merged;
}

function settingNumber(key: string, fallback: number, cwd?: string): number {
	const value = readVstackConfig(cwd)[key];
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
}

function settingBoolean(key: string, fallback: boolean, cwd?: string): boolean {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "boolean" ? value : fallback;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function oneLinePreview(text: string | undefined, maxChars: number): string {
	const compact = (text ?? "").replace(/\s+/g, " ").trim();
	return compact.length > maxChars ? `${compact.slice(0, Math.max(0, maxChars - 1))}…` : compact;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	fullOutputError?: string;
	fullOutputPath?: string;
	step?: number;
	truncation?: TruncationResult;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	fullOutputError?: string;
	fullOutputPath?: string;
	truncation?: TruncationResult;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

interface PaneRegistryEntry {
	agent: string;
	paneId: string;
	windowName: string;
	cwd: string;
	sessionFile: string;
	promptFile: string;
	launcherFile: string;
	model?: string;
	thinkingLevel?: string;
	startedAt: string;
	lastTaskAt?: string;
	lastTaskId?: string;
	launcherVersion?: number;
	layoutGroup?: number;
	primaryPaneId?: string;
}

interface PaneCompletion {
	agent?: string;
	taskId?: string;
	status?: "completed" | "blocked" | "failed";
	summary?: string;
	filesChanged?: string[];
	validation?: string[];
	notes?: string;
}

type PaneRegistry = Record<string, PaneRegistryEntry>;

function safeFileName(value: string): string {
	return value.replace(/[^\w.-]+/g, "_");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

type PreparedSingleResult = {
	fullOutputError?: string;
	fullOutputPath?: string;
	result: SingleResult;
	text: string;
	truncation?: TruncationResult;
};

function stringifyError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

type ResultLimits = { maxBytes: number; maxLines: number };

function resultLimits(cwd?: string): ResultLimits {
	return {
		maxBytes: Math.max(1, Math.floor(settingNumber("resultMaxBytes", DEFAULT_RESULT_MAX_BYTES, cwd))),
		maxLines: Math.max(1, Math.floor(settingNumber("resultMaxLines", DEFAULT_RESULT_MAX_LINES, cwd))),
	};
}

function splitResultLimits(total: ResultLimits, parts: number): ResultLimits {
	const count = Math.max(1, parts);
	return {
		maxBytes: Math.max(1024, Math.floor(total.maxBytes / count)),
		maxLines: Math.max(40, Math.floor(total.maxLines / count)),
	};
}

function formatTruncationNotice(
	truncation: TruncationResult,
	fullOutputPath?: string,
	fullOutputError?: string,
	direction: "head" | "tail" = "head",
): string {
	const omittedLines = Math.max(0, truncation.totalLines - truncation.outputLines);
	const omittedBytes = Math.max(0, truncation.totalBytes - truncation.outputBytes);
	const shown = direction === "tail" ? `showing last ${truncation.outputLines}` : `showing ${truncation.outputLines}`;
	const artifact = fullOutputPath
		? ` Full output saved to: ${fullOutputPath}`
		: fullOutputError
			? ` Full output preservation failed: ${fullOutputError}`
			: "";
	return `[Output truncated (${direction}): ${shown} of ${truncation.totalLines} lines (${formatSize(
		truncation.outputBytes,
	)} of ${formatSize(truncation.totalBytes)}). ${omittedLines} lines (${formatSize(omittedBytes)}) omitted.${artifact}]`;
}

async function writeFullOutputArtifact(
	runtimeRoot: string,
	agentName: string,
	label: string,
	text: string,
): Promise<{ error?: string; path?: string }> {
	const dir = path.join(runtimeRoot, "outputs", safeFileName(agentName || "subagent"));
	const filePath = path.join(
		dir,
		`${Date.now()}-${Math.random().toString(16).slice(2)}-${safeFileName(label || "output")}.txt`,
	);
	try {
		await withFileMutationQueue(filePath, async () => {
			await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
			await fs.promises.writeFile(filePath, text, { encoding: "utf-8", mode: 0o600 });
		});
		return { path: filePath };
	} catch (error) {
		return { error: stringifyError(error) };
	}
}

async function truncateForToolResult(
	text: string,
	runtimeRoot: string,
	cwd: string,
	agentName: string,
	label: string,
	direction: "head" | "tail" = "head",
	limits: ResultLimits = resultLimits(cwd),
): Promise<Omit<PreparedSingleResult, "result">> {
	if (!settingBoolean("truncateResults", true, cwd)) return { text };
	const truncation = (direction === "tail" ? truncateTail : truncateHead)(text, limits);
	if (!truncation.truncated) return { text: truncation.content };

	const artifact = settingBoolean("preserveFullOutput", true, cwd)
		? await writeFullOutputArtifact(runtimeRoot, agentName, label, text)
		: {};
	return {
		fullOutputError: artifact.error,
		fullOutputPath: artifact.path,
		text: `${truncation.content}\n\n${formatTruncationNotice(truncation, artifact.path, artifact.error, direction)}`,
		truncation,
	};
}

function truncateForDetails(text: string, cwd?: string): string {
	if (!settingBoolean("truncateResults", true, cwd)) return text;
	const truncation = truncateHead(text, resultLimits(cwd));
	if (!truncation.truncated) return truncation.content;
	return `${truncation.content}\n\n[Output truncated in subagent details: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
		truncation.outputBytes,
	)} of ${formatSize(truncation.totalBytes)}).]`;
}

function sanitizeDetailValue(value: unknown, depth = 0): unknown {
	if (depth > 4) return "[Max detail depth reached]";
	if (value == null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "string") {
		return value.length > DETAIL_STRING_MAX_CHARS
			? `${value.slice(0, DETAIL_STRING_MAX_CHARS)}… [detail string truncated]`
			: value;
	}
	if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeDetailValue(item, depth + 1));
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [index, [key, nested]] of Object.entries(value as Record<string, unknown>).entries()) {
			if (index >= 80) {
				out["[truncated]"] = "detail object field cap reached";
				break;
			}
			out[key] = sanitizeDetailValue(nested, depth + 1);
		}
		return out;
	}
	return String(value);
}

function lastAssistantTextPart(messages: Message[]): { messageIndex: number; partIndex: number } | undefined {
	for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
		const message = messages[messageIndex];
		if (message.role !== "assistant") continue;
		for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
			const part = message.content[partIndex] as any;
			if (part?.type === "text" && typeof part.text === "string") return { messageIndex, partIndex };
		}
	}
	return undefined;
}

function cloneMessagesForDetails(messages: Message[], finalOutputText: string | undefined, cwd?: string): Message[] {
	const final = lastAssistantTextPart(messages);
	const cloned: Message[] = [];
	messages.forEach((message, messageIndex) => {
		if (message.role !== "assistant") return;
		const content = message.content.map((part, partIndex) => {
			const candidate = part as any;
			if (candidate?.type === "text" && typeof candidate.text === "string") {
				const isFinal = final?.messageIndex === messageIndex && final?.partIndex === partIndex;
				return { ...candidate, text: isFinal && finalOutputText !== undefined ? finalOutputText : truncateForDetails(candidate.text, cwd) };
			}
			if (candidate?.type === "toolCall") {
				const next = { ...candidate };
				if ("arguments" in next) next.arguments = sanitizeDetailValue(next.arguments);
				if ("args" in next) next.args = sanitizeDetailValue(next.args);
				return next;
			}
			return candidate;
		});
		cloned.push({ ...message, content } as Message);
	});
	return cloned;
}

async function prepareSingleResultForReturn(
	result: SingleResult,
	runtimeRoot: string,
	cwd: string,
	label: string,
	textOverride?: string,
	limits?: ResultLimits,
): Promise<PreparedSingleResult> {
	const finalOutput = getFinalOutput(result.messages);
	const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
	const rawText = textOverride ?? (finalOutput || (isError ? result.errorMessage || result.stderr : finalOutput));
	const direction = isError && !finalOutput ? "tail" : "head";
	const output = rawText
		? await truncateForToolResult(rawText, runtimeRoot, cwd, result.agent, label, direction, limits)
		: { text: rawText };
	const prepared: SingleResult = {
		...result,
		messages: cloneMessagesForDetails(result.messages, output.text || undefined, cwd),
	};
	if (isError && output.text && !prepared.errorMessage) prepared.errorMessage = output.text;
	if (output.truncation) {
		prepared.fullOutputError = output.fullOutputError;
		prepared.fullOutputPath = output.fullOutputPath;
		prepared.truncation = output.truncation;
	}
	return { ...output, result: prepared };
}

function detailsWithTruncation(details: SubagentDetails, prepared: PreparedSingleResult): SubagentDetails {
	if (!prepared.truncation) return details;
	return {
		...details,
		fullOutputError: prepared.fullOutputError,
		fullOutputPath: prepared.fullOutputPath,
		truncation: prepared.truncation,
	};
}

function setCurrentTmuxPaneTitle(title: string): void {
	const paneId = process.env.TMUX_PANE;
	if (!paneId) return;
	const proc = spawn("tmux", ["select-pane", "-t", paneId, "-T", title], { stdio: "ignore" });
	proc.on("error", () => undefined);
	proc.unref?.();
}

function registryPath(runtimeRoot: string): string {
	return path.join(runtimeRoot, "panes.json");
}

function outboxRoot(runtimeRoot: string): string {
	return path.join(runtimeRoot, "outbox");
}

function completionPath(runtimeRoot: string, agentName: string, taskId: string): string {
	return path.join(outboxRoot(runtimeRoot), safeFileName(agentName), `${safeFileName(taskId)}.json`);
}

function inboxDir(runtimeRoot: string, agentName: string): string {
	return path.join(runtimeRoot, "inbox", safeFileName(agentName));
}

function completionArchiveDir(runtimeRoot: string, agentName: string): string {
	return path.join(runtimeRoot, "processed", safeFileName(agentName));
}

function legacyProjectRuntimeDirs(cwd: string): string[] {
	const candidates = [path.join(cwd, ".pi", "subagent-runtime")];
	try {
		candidates.push(path.join(path.dirname(projectSettingsPath(cwd)), "subagent-runtime"));
	} catch {
		// Ignore project-root probing failures; the direct cwd candidate is enough.
	}
	return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

async function stopLegacyPanes(legacyRoot: string): Promise<void> {
	try {
		const content = await fs.promises.readFile(path.join(legacyRoot, "panes.json"), "utf-8");
		const registry = JSON.parse(content) as PaneRegistry;
		for (const entry of Object.values(registry)) {
			if (entry.paneId) await tmux(["kill-pane", "-t", entry.paneId]);
		}
	} catch {
		// Best-effort only. The migration still moves files out of the project.
	}
}

async function migrateLegacyProjectRuntime(cwd: string, runtimeRoot: string): Promise<void> {
	for (const legacyRoot of legacyProjectRuntimeDirs(cwd)) {
		if (legacyRoot === path.resolve(runtimeRoot) || !fs.existsSync(legacyRoot)) continue;
		await stopLegacyPanes(legacyRoot);
		await fs.promises.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
		const target = path.join(runtimeRoot, `legacy-project-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		try {
			await fs.promises.rename(legacyRoot, target);
		} catch {
			try {
				await fs.promises.cp(legacyRoot, target, { recursive: true, force: false });
				await fs.promises.rm(legacyRoot, { recursive: true, force: true });
			} catch {
				// If the filesystem refuses migration, leave the legacy tree in place
				// rather than breaking startup. New runtime state still uses runtimeRoot.
			}
		}
	}
}

function createTaskId(agentName: string): string {
	return `${safeFileName(agentName)}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildDelegation(agent: AgentConfig, task: string, outboxFile: string, taskId: string): string {
	const compactTask = task.replace(/\s+/g, " ").trim();
	const schema = JSON.stringify({
		agent: agent.name,
		taskId,
		status: "completed|blocked|failed",
		summary: "1-3 sentence result",
		filesChanged: ["path/or empty"],
		validation: ["command/result or empty"],
		notes: "optional",
	});
	return `DELEGATION for ${agent.name}. Task ID: ${taskId}. Task: ${compactTask}. Completion protocol mandatory: when the delegation is complete, write exactly one JSON object to ${outboxFile} using this schema ${schema}. Then print one brief final message in your pane and go idle. Do not write the completion file before the work is actually done.`;
}

async function execCapture(command: string, args: string[], options?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, { cwd: options?.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (data) => (stdout += data.toString()));
		proc.stderr.on("data", (data) => (stderr += data.toString()));
		proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
		proc.on("error", (error) => resolve({ code: 1, stdout, stderr: String(error) }));
	});
}

async function tmux(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return execCapture("tmux", args);
}

async function ensureTmux(): Promise<void> {
	if (!process.env.TMUX) throw new Error("Persistent pane agents require tmux ($TMUX is unset).");
	const result = await tmux(["display-message", "-p", "#S"]);
	if (result.code !== 0) throw new Error(`tmux is unavailable: ${result.stderr || result.stdout}`.trim());
}

async function paneExists(paneId: string): Promise<boolean> {
	const result = await tmux(["display-message", "-p", "-t", paneId, "#{pane_id}"]);
	return result.code === 0 && result.stdout.trim() === paneId;
}

async function getPrimaryPaneId(): Promise<string> {
	if (process.env.TMUX_PANE && (await paneExists(process.env.TMUX_PANE))) return process.env.TMUX_PANE;
	const result = await tmux(["display-message", "-p", "#{pane_id}"]);
	if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
	throw new Error(`Unable to determine primary tmux pane: ${result.stderr || result.stdout}`.trim());
}

function columnCapacity(group: number): number {
	return group <= 1 ? FIRST_AGENT_COLUMN_ROWS : NEXT_AGENT_COLUMN_ROWS;
}

function sortPaneEntries(entries: PaneRegistryEntry[]): PaneRegistryEntry[] {
	return [...entries].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.agent.localeCompare(b.agent));
}

function groupedPaneEntries(registry: PaneRegistry): Map<number, PaneRegistryEntry[]> {
	const groups = new Map<number, PaneRegistryEntry[]>();
	for (const entry of sortPaneEntries(Object.values(registry))) {
		if (!entry.layoutGroup) continue;
		const group = groups.get(entry.layoutGroup) ?? [];
		group.push(entry);
		groups.set(entry.layoutGroup, group);
	}
	return groups;
}

function nextLayoutGroup(registry: PaneRegistry): number {
	const groups = groupedPaneEntries(registry);
	for (let group = 1; group <= 16; group += 1) {
		if ((groups.get(group)?.length ?? 0) < columnCapacity(group)) return group;
	}
	return Math.max(1, groups.size + 1);
}

async function cleanupPaneRegistry(registry: PaneRegistry): Promise<boolean> {
	let changed = false;
	for (const [agentName, entry] of Object.entries(registry)) {
		if (!(await paneExists(entry.paneId))) {
			delete registry[agentName];
			changed = true;
			continue;
		}
		if (entry.launcherVersion !== PANE_LAUNCHER_VERSION) {
			await tmux(["kill-pane", "-t", entry.paneId]);
			delete registry[agentName];
			changed = true;
		}
	}
	return changed;
}

async function rebalanceColumn(entries: PaneRegistryEntry[]): Promise<void> {
	if (entries.length <= 1) return;
	const sorted = sortPaneEntries(entries);
	const heightResult = await tmux(["display-message", "-p", "-t", sorted[0].paneId, "#{window_height}"]);
	const windowHeight = Number.parseInt(heightResult.stdout.trim(), 10);
	if (heightResult.code !== 0 || !Number.isFinite(windowHeight) || windowHeight <= 0) return;

	const availablePaneRows = Math.max(sorted.length, windowHeight - (sorted.length - 1));
	const targetHeight = Math.max(3, Math.floor(availablePaneRows / sorted.length));
	for (const entry of sorted.slice(0, -1)) {
		await tmux(["resize-pane", "-t", entry.paneId, "-y", String(targetHeight)]);
	}
}

async function rebalanceColumns(registry: PaneRegistry, primaryPaneId: string): Promise<void> {
	const groups = groupedPaneEntries(registry);
	const columns = [{ paneId: primaryPaneId, group: 0 }];
	for (const [group, entries] of [...groups.entries()].sort(([a], [b]) => a - b)) {
		const representative = sortPaneEntries(entries)[0];
		if (representative) columns.push({ paneId: representative.paneId, group });
	}
	if (columns.length <= 1) return;

	const measured: Array<{ paneId: string; left: number; windowWidth: number }> = [];
	for (const column of columns) {
		if (!(await paneExists(column.paneId))) continue;
		const result = await tmux(["display-message", "-p", "-t", column.paneId, "#{pane_left}\t#{window_width}"]);
		const [leftText, windowWidthText] = result.stdout.trim().split("\t");
		const left = Number.parseInt(leftText ?? "", 10);
		const windowWidth = Number.parseInt(windowWidthText ?? "", 10);
		if (result.code === 0 && Number.isFinite(left) && Number.isFinite(windowWidth)) measured.push({ paneId: column.paneId, left, windowWidth });
	}
	if (measured.length <= 1) return;

	measured.sort((a, b) => a.left - b.left);
	const windowWidth = measured[0].windowWidth;
	const availablePaneColumns = Math.max(measured.length, windowWidth - (measured.length - 1));
	const baseWidth = Math.max(10, Math.floor(availablePaneColumns / measured.length));
	const remainder = Math.max(0, availablePaneColumns - baseWidth * measured.length);
	for (const [index, column] of measured.entries()) {
		const targetWidth = baseWidth + (index >= measured.length - remainder ? 1 : 0);
		await tmux(["resize-pane", "-t", column.paneId, "-x", String(targetWidth)]);
	}
}

async function readPaneRegistry(runtimeRoot: string): Promise<PaneRegistry> {
	try {
		const content = await fs.promises.readFile(registryPath(runtimeRoot), "utf-8");
		return JSON.parse(content) as PaneRegistry;
	} catch {
		return {};
	}
}

async function writePaneRegistry(runtimeRoot: string, registry: PaneRegistry): Promise<void> {
	const filePath = registryPath(runtimeRoot);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
		await fs.promises.writeFile(filePath, `${JSON.stringify(registry, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
	});
}

async function writeLauncher(
	runtimeRoot: string,
	parentSessionId: string,
	cwd: string,
	agent: AgentConfig,
	model: string | undefined,
	thinkingLevel: string | undefined,
): Promise<{ sessionFile: string; promptFile: string; launcherFile: string }> {
	const dir = runtimeRoot;
	const safeName = safeFileName(agent.name);
	const sessionsDir = path.join(dir, "sessions");
	const promptsDir = path.join(dir, "prompts");
	const launchersDir = path.join(dir, "launchers");
	await fs.promises.mkdir(sessionsDir, { recursive: true, mode: 0o700 });
	await fs.promises.mkdir(promptsDir, { recursive: true, mode: 0o700 });
	await fs.promises.mkdir(launchersDir, { recursive: true, mode: 0o700 });

	const sessionFile = path.join(sessionsDir, `${safeName}.jsonl`);
	const promptFile = path.join(promptsDir, `${safeName}.md`);
	const launcherFile = path.join(launchersDir, `${safeName}.sh`);

	await withFileMutationQueue(promptFile, async () => {
		await fs.promises.writeFile(promptFile, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
	});

	const args = ["--session", sessionFile, "--append-system-prompt", promptFile];
	if (model) args.push("--model", model);
	if (thinkingLevel && thinkingLevel !== "off") args.push("--thinking", thinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	const invocation = getPiInvocation(args);
	const command = [invocation.command, ...invocation.args].map(shellQuote).join(" ");
	const script = `#!/usr/bin/env bash
set -euo pipefail
cd ${shellQuote(cwd)}
export PI_SUBAGENT_CHILD_AGENT=${shellQuote(agent.name)}
export PI_SUBAGENT_PARENT_SESSION_ID=${shellQuote(parentSessionId)}
exec ${command}
`;
	await withFileMutationQueue(launcherFile, async () => {
		await fs.promises.writeFile(launcherFile, script, { encoding: "utf-8", mode: 0o700 });
	});

	return { sessionFile, promptFile, launcherFile };
}

async function ensurePersistentPane(
	runtimeRoot: string,
	parentSessionId: string,
	cwd: string,
	agent: AgentConfig,
	parentModel: string | undefined,
	parentThinkingLevel: string | undefined,
): Promise<PaneRegistryEntry> {
	await ensureTmux();
	const registry = await readPaneRegistry(runtimeRoot);
	if (await cleanupPaneRegistry(registry)) await writePaneRegistry(runtimeRoot, registry);

	const existing = registry[agent.name];
	if (existing && (await paneExists(existing.paneId))) return existing;

	const selectedModel = parentModel ?? agent.model;
	const paths = await writeLauncher(runtimeRoot, parentSessionId, cwd, agent, selectedModel, parentThinkingLevel);
	const windowName = `subagent:${agent.name}`;
	const primaryPaneId = await getPrimaryPaneId();
	const layoutGroup = nextLayoutGroup(registry);
	const groupEntries = groupedPaneEntries(registry).get(layoutGroup) ?? [];
	const splitHorizontally = groupEntries.length === 0;
	const splitTarget = splitHorizontally ? primaryPaneId : groupEntries[0].paneId;
	const splitPercent = splitHorizontally ? "50" : String(Math.max(10, Math.floor(100 / (groupEntries.length + 1))));
	const result = await tmux([
		"split-window",
		splitHorizontally ? "-h" : "-v",
		"-d",
		"-P",
		"-F",
		"#{pane_id}",
		"-p",
		splitPercent,
		"-t",
		splitTarget,
		"-c",
		cwd,
		"bash",
		paths.launcherFile,
	]);
	if (result.code !== 0) throw new Error(`Failed to launch tmux pane for ${agent.name}: ${result.stderr || result.stdout}`.trim());
	const paneId = result.stdout.trim();
	await tmux(["select-pane", "-t", paneId, "-T", windowName]);
	await tmux(["set-window-option", "-t", paneId, "pane-border-status", "top"]);
	await tmux([
		"set-window-option",
		"-t",
		paneId,
		"pane-border-format",
		"#{?pane_active,#[bold fg=colour39],#[fg=colour245]} #T #[default]",
	]);

	const entry: PaneRegistryEntry = {
		agent: agent.name,
		paneId,
		windowName,
		cwd,
		sessionFile: paths.sessionFile,
		promptFile: paths.promptFile,
		launcherFile: paths.launcherFile,
		model: selectedModel,
		thinkingLevel: parentThinkingLevel,
		startedAt: new Date().toISOString(),
		launcherVersion: PANE_LAUNCHER_VERSION,
		layoutGroup,
		primaryPaneId,
	};
	registry[agent.name] = entry;
	await rebalanceColumn([...(groupedPaneEntries(registry).get(layoutGroup) ?? [])]);
	await rebalanceColumns(registry, primaryPaneId);
	await writePaneRegistry(runtimeRoot, registry);
	return entry;
}

async function archiveCompletion(runtimeRoot: string, agentName: string, filePath: string): Promise<void> {
	const archiveDir = completionArchiveDir(runtimeRoot, agentName);
	await fs.promises.mkdir(archiveDir, { recursive: true, mode: 0o700 });
	const archivedPath = path.join(archiveDir, `${Date.now()}-${path.basename(filePath)}`);
	await fs.promises.rename(filePath, archivedPath);
}

function formatCompletion(completion: PaneCompletion, filePath: string): string {
	const files = completion.filesChanged?.length ? completion.filesChanged.map((file) => `- ${file}`).join("\n") : "None reported";
	const validation = completion.validation?.length
		? completion.validation.map((item) => `- ${item}`).join("\n")
		: "None reported";
	return [
		`# Subagent completion: ${completion.agent ?? "unknown"}`,
		`Task ID: ${completion.taskId ?? "unknown"}`,
		`Status: ${completion.status ?? "unknown"}`,
		`Source: ${filePath}`,
		"",
		"## Summary",
		completion.summary ?? "No summary provided.",
		"",
		"## Files Changed",
		files,
		"",
		"## Validation",
		validation,
		completion.notes ? `\n## Notes\n${completion.notes}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

async function pollPaneCompletions(runtimeRoot: string, pi: ExtensionAPI, triggerTurn = true): Promise<number> {
	let collected = 0;
	const root = outboxRoot(runtimeRoot);
	let agentDirs: fs.Dirent[];
	try {
		agentDirs = await fs.promises.readdir(root, { withFileTypes: true });
	} catch {
		return collected;
	}

	for (const agentDir of agentDirs) {
		if (!agentDir.isDirectory()) continue;
		const dir = path.join(root, agentDir.name);
		let files: string[];
		try {
			files = (await fs.promises.readdir(dir)).filter((file) => file.endsWith(".json"));
		} catch {
			continue;
		}

		for (const file of files) {
			const filePath = path.join(dir, file);
			try {
				const completion = JSON.parse(await fs.promises.readFile(filePath, "utf-8")) as PaneCompletion;
				const content = formatCompletion(completion, filePath);
				pi.sendMessage(
					{ customType: "subagent-completion", content, display: true },
					triggerTurn ? { triggerTurn: true, deliverAs: "followUp" } : undefined,
				);
				await archiveCompletion(runtimeRoot, completion.agent ?? agentDir.name, filePath);
				collected++;
			} catch {
				// Leave malformed or concurrently-written files in place for the agent/user to fix.
			}
		}
	}
	return collected;
}

async function runPersistentPaneAgent(
	defaultCwd: string,
	runtimeRoot: string,
	parentSessionId: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	parentModel: string | undefined,
	parentThinkingLevel: string | undefined,
	step: number | undefined,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const effectiveCwd = cwd ?? defaultCwd;
	const pane = await ensurePersistentPane(runtimeRoot, parentSessionId, effectiveCwd, agent, parentModel, parentThinkingLevel);
	const taskId = createTaskId(agent.name);
	const outboxFile = completionPath(runtimeRoot, agent.name, taskId);
	await fs.promises.mkdir(path.dirname(outboxFile), { recursive: true, mode: 0o700 });
	const delegation = buildDelegation(agent, task, outboxFile, taskId);
	const taskFile = path.join(inboxDir(runtimeRoot, agent.name), `${safeFileName(taskId)}.md`);
	await fs.promises.mkdir(path.dirname(taskFile), { recursive: true, mode: 0o700 });
	await fs.promises.writeFile(taskFile, delegation, { encoding: "utf-8", mode: 0o600 });
	const registry = await readPaneRegistry(runtimeRoot);
	if (registry[agent.name]) {
		registry[agent.name].lastTaskAt = new Date().toISOString();
		registry[agent.name].lastTaskId = taskId;
		await writePaneRegistry(runtimeRoot, registry);
	}

	const text = `Queued task ${taskId} for persistent tmux pane ${pane.paneId} (${pane.windowName}). Inbox file: ${taskFile}. Completion file: ${outboxFile}`;
	return {
		agent: agent.name,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as Message],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: pane.model,
		step,
	};
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	parentModel: string | undefined,
	parentThinkingLevel: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const selectedModel = parentModel ?? agent.model;
	if (selectedModel) args.push("--model", selectedModel);
	if (parentThinkingLevel && parentThinkingLevel !== "off") args.push("--thinking", parentThinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: selectedModel,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			const rawOutput = getFinalOutput(currentResult.messages);
			const displayText = rawOutput ? truncateForDetails(rawOutput, cwd ?? defaultCwd) : "(running...)";
			const partialResult: SingleResult = {
				...currentResult,
				messages: cloneMessagesForDetails(currentResult.messages, rawOutput ? displayText : undefined, cwd ?? defaultCwd),
			};
			onUpdate({
				content: [{ type: "text", text: displayText }],
				details: makeDetails([partialResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end") {
					// Tool-result messages can contain large read/bash payloads. The parent result
					// only needs assistant text/tool-call summaries, so avoid retaining nested output.
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "project" (.pi/agents plus .claude/agents compatibility). Use "both" to include user-level agents too.',
	default: "project",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: false.", default: false }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;
	if (!settingBoolean("enabled", true)) return;

	const childAgentName = process.env.PI_SUBAGENT_CHILD_AGENT;
	let completionPoller: ReturnType<typeof setInterval> | undefined;
	let completionPollInFlight = false;
	let childInboxPoller: ReturnType<typeof setInterval> | undefined;
	let childTitlePoller: ReturnType<typeof setInterval> | undefined;
	let childPollInFlight = false;
	let childCurrentTaskFile: string | undefined;

	pi.registerMessageRenderer("subagent-agents", (message, _options, _theme) => {
		return new Text(message.content, 0, 0);
	});

	pi.registerMessageRenderer("subagent-completion", (message, _options, _theme) => {
		return new Text(message.content, 0, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		if (completionPoller) clearInterval(completionPoller);
		if (childInboxPoller) clearInterval(childInboxPoller);
		if (childTitlePoller) clearInterval(childTitlePoller);

		const runtimeRoot = runtimeDirForContext(ctx);

		if (childAgentName) {
			ctx.ui.setTitle(`pi subagent - ${childAgentName}`);
			setCurrentTmuxPaneTitle(`subagent:${childAgentName}`);
			childTitlePoller = setInterval(() => setCurrentTmuxPaneTitle(`subagent:${childAgentName}`), 1000);
			childTitlePoller.unref?.();
			ctx.ui.setStatus("subagent", `${childAgentName} idle`);
			if (ctx.hasUI) ctx.ui.setWidget("subagent-marker", undefined);
			const pollInbox = () => {
				if (childPollInFlight || !ctx.isIdle()) return;
				childPollInFlight = true;
				(async () => {
					const inbox = inboxDir(runtimeRoot, childAgentName);
					let files: string[];
					try {
						files = (await fs.promises.readdir(inbox)).filter((file) => file.endsWith(".md")).sort();
					} catch {
						return;
					}
					const file = files[0];
					if (!file) return;

					const source = path.join(inbox, file);
					const processing = path.join(runtimeRoot, "processing", safeFileName(childAgentName), file);
					await fs.promises.mkdir(path.dirname(processing), { recursive: true, mode: 0o700 });
					try {
						await fs.promises.rename(source, processing);
					} catch {
						return;
					}

					const prompt = await fs.promises.readFile(processing, "utf-8");
					childCurrentTaskFile = processing;
					ctx.ui.setStatus("subagent", `${childAgentName} running ${file}`);
					pi.sendUserMessage(prompt);
				})().finally(() => {
					childPollInFlight = false;
				});
			};
			pollInbox();
			childInboxPoller = setInterval(pollInbox, Math.max(500, Math.floor(settingNumber("childInboxPollMs", 1000, ctx.cwd))));
			return;
		}

		ctx.ui.setStatus("subagent", undefined);
		await migrateLegacyProjectRuntime(ctx.cwd, runtimeRoot);
		if (!ctx.hasUI) return;
		const poll = () => {
			if (completionPollInFlight) return;
			completionPollInFlight = true;
			pollPaneCompletions(runtimeRoot, pi).finally(() => {
				completionPollInFlight = false;
			});
		};
		poll();
		completionPoller = setInterval(poll, Math.max(500, Math.floor(settingNumber("completionPollMs", 2000, ctx.cwd))));
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!childAgentName || !childCurrentTaskFile) return;
		const doneFile = path.join(runtimeDirForContext(ctx), "done", safeFileName(childAgentName), path.basename(childCurrentTaskFile));
		try {
			await fs.promises.mkdir(path.dirname(doneFile), { recursive: true, mode: 0o700 });
			await fs.promises.rename(childCurrentTaskFile, doneFile);
		} catch {
			// Keep the processing file as evidence if archival fails.
		}
		childCurrentTaskFile = undefined;
		ctx.ui.setStatus("subagent", `${childAgentName} idle`);
	});

	pi.on("session_shutdown", () => {
		if (completionPoller) clearInterval(completionPoller);
		if (childInboxPoller) clearInterval(childInboxPoller);
		completionPoller = undefined;
		childInboxPoller = undefined;
	});

	pi.registerCommand("agents", {
		description: "List/show/manage subagents. Usage: /agents, /agents show <name>, /agents start|send|attach|stop|status|collect ...",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const scopes = new Set<AgentScope>(["user", "project", "both"]);
			const command = parts[0];
			let scope: AgentScope = "project";
			let content = "";

			const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const parentThinkingLevel = pi.getThinkingLevel();
			const parentSessionId = runtimeSessionId(ctx);
			const runtimeRoot = sessionRuntimeDir(parentSessionId);
			const discovery = discoverAgents(ctx.cwd, scopes.has(parts.at(-1) as AgentScope) ? (parts.at(-1) as AgentScope) : scope);
			const findAgent = (name: string | undefined) => discovery.agents.find((candidate) => candidate.name === name);

			try {
				if (command === "start") {
					const agent = findAgent(parts[1]);
					if (!agent) throw new Error(`Unknown agent: ${parts[1] ?? "(missing)"}`);
					if (!agent.pane) throw new Error(`Agent ${agent.name} is not configured for persistent panes. Add \`pane: true\` to its frontmatter to enable.`);
					const pane = await ensurePersistentPane(runtimeRoot, parentSessionId, ctx.cwd, agent, parentModel, parentThinkingLevel);
					content = `Started/reused ${agent.name} in ${pane.paneId} (${pane.windowName}).\nSession: ${pane.sessionFile}`;
				} else if (command === "send") {
					const agent = findAgent(parts[1]);
					if (!agent) throw new Error(`Unknown agent: ${parts[1] ?? "(missing)"}`);
					if (!agent.pane) throw new Error(`Agent ${agent.name} is not configured for persistent panes. Add \`pane: true\` to its frontmatter to enable.`);
					const task = parts.slice(2).join(" ").trim();
					if (!task) throw new Error("Usage: /agents send <name> <task>");
					const pane = await ensurePersistentPane(runtimeRoot, parentSessionId, ctx.cwd, agent, parentModel, parentThinkingLevel);
					const taskId = createTaskId(agent.name);
					const outboxFile = completionPath(runtimeRoot, agent.name, taskId);
					await fs.promises.mkdir(path.dirname(outboxFile), { recursive: true, mode: 0o700 });
					const taskFile = path.join(inboxDir(runtimeRoot, agent.name), `${safeFileName(taskId)}.md`);
					await fs.promises.mkdir(path.dirname(taskFile), { recursive: true, mode: 0o700 });
					await fs.promises.writeFile(taskFile, buildDelegation(agent, task, outboxFile, taskId), {
						encoding: "utf-8",
						mode: 0o600,
					});
					const registry = await readPaneRegistry(runtimeRoot);
					if (registry[agent.name]) {
						registry[agent.name].lastTaskAt = new Date().toISOString();
						registry[agent.name].lastTaskId = taskId;
						await writePaneRegistry(runtimeRoot, registry);
					}
					content = `Queued task ${taskId} for ${agent.name} in ${pane.paneId} (${pane.windowName}).\nInbox file: ${taskFile}\nCompletion file: ${outboxFile}`;
				} else if (command === "attach") {
					const registry = await readPaneRegistry(runtimeRoot);
					const entry = registry[parts[1] ?? ""];
					if (!entry || !(await paneExists(entry.paneId))) throw new Error(`No live pane for agent: ${parts[1] ?? "(missing)"}`);
					const result = await tmux(["select-pane", "-t", entry.paneId]);
					if (result.code !== 0) throw new Error(result.stderr || result.stdout || "tmux select-pane failed");
					content = `Attached to ${entry.agent} at ${entry.paneId}.`;
				} else if (command === "stop") {
					const registry = await readPaneRegistry(runtimeRoot);
					const entry = registry[parts[1] ?? ""];
					if (!entry) throw new Error(`No pane registry entry for agent: ${parts[1] ?? "(missing)"}`);
					if (await paneExists(entry.paneId)) await tmux(["kill-pane", "-t", entry.paneId]);
					delete registry[entry.agent];
					await writePaneRegistry(runtimeRoot, registry);
					content = `Stopped ${entry.agent} pane ${entry.paneId}.`;
				} else if (command === "collect") {
					const collected = await pollPaneCompletions(runtimeRoot, pi, false);
					content = `Collected ${collected} subagent completion file${collected === 1 ? "" : "s"}.`;
				} else if (command === "status") {
					const registry = await readPaneRegistry(runtimeRoot);
					const lines = await Promise.all(
						Object.values(registry).map(async (entry) => {
							const live = await paneExists(entry.paneId);
							return `- ${entry.agent}: ${live ? "live" : "dead"} ${entry.paneId} ${entry.windowName} model=${entry.model ?? "default"} lastTask=${entry.lastTaskAt ?? "never"}`;
						}),
					);
					content = [`# Persistent subagent panes`, "", lines.join("\n") || "No persistent panes registered."].join("\n");
				} else {
					let showName: string | undefined;
					if (command === "show") {
						showName = parts[1];
						if (scopes.has(parts[2] as AgentScope)) scope = parts[2] as AgentScope;
					} else if (scopes.has(command as AgentScope)) {
						scope = command as AgentScope;
					} else if (command) {
						showName = command;
					}

					const scopedDiscovery = discoverAgents(ctx.cwd, scope);
					if (showName) {
						const agent = scopedDiscovery.agents.find((candidate) => candidate.name === showName);
						content = agent
							? [
									`# Agent: ${agent.name}`,
									`Source: ${agent.source}`,
									`Path: ${agent.filePath}`,
									`Model: ${agent.model ?? "default"}`,
									`Tools: ${agent.tools?.join(", ") ?? "default"}`,
									`Persistent pane: ${agent.pane ? "yes" : "no"}`,
									"",
									agent.description,
									"",
									"---",
									"",
									agent.systemPrompt.trim(),
								]
								.join("\n")
							: `Unknown agent "${showName}" for scope "${scope}". Available: ${scopedDiscovery.agents
									.map((agent) => agent.name)
									.join(", ") || "none"}.`;
					} else {
						const formatted = formatAgentList(scopedDiscovery.agents);
						content = [
							`# Available subagents (${scope})`,
							`Project agent dirs: ${scopedDiscovery.projectAgentsDir ?? "none"}`,
							"",
							formatted.text
								.split("; ")
								.map((line) => {
									const name = line.match(/^-?\s*([^ ]+)/)?.[1];
									const agent = scopedDiscovery.agents.find((candidate) => candidate.name === name);
									return `- ${line}${agent?.pane ? " [pane]" : ""}`;
								})
								.join("\n"),
							"",
							"Commands: `/agents show <name>`, `/agents start <name>`, `/agents send <name> <task>`, `/agents attach <name>`, `/agents stop <name>`, `/agents status`, `/agents collect`.",
						].join("\n");
					}
				}
			} catch (error) {
				content = `Error: ${error instanceof Error ? error.message : String(error)}`;
			}

			pi.sendMessage({ customType: "subagent-agents", content, display: true });
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!pi.getActiveTools().includes("subagent")) return;

		const discovery = discoverAgents(ctx.cwd, "project");
		if (discovery.agents.length === 0) return;

		const agentLines = discovery.agents
			.map((agent) => {
				const model = agent.model ? ` model=${agent.model}` : "";
				const tools = agent.tools ? ` tools=${agent.tools.join(",")}` : "";
				const pane = agent.pane ? " pane=true" : "";
				return `- ${agent.name}: ${agent.description} (${agent.source}${model}${tools}${pane})`;
			})
			.join("\n");

		return {
			systemPrompt: `${event.systemPrompt}\n\n## Project Subagents\nUse the \`subagent\` tool when isolated context, specialist review, reconnaissance, planning, or parallel read-only investigation would help. Project-local agents are loaded from .pi/agents, with .claude/agents as a compatibility source. Agents with \`pane=true\` run in persistent tmux panes and can also be managed with \`/agents start|send|attach|stop|status\`. Available project subagents:\n${agentLines}\n\nDefault \`agentScope\` is \"project\". Use \"both\" only when user-level agents are explicitly needed.`,
		};
	});

	pi.registerTool({
		renderShell: "self",
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Results are truncated by default to ${DEFAULT_RESULT_MAX_LINES} lines or ${formatSize(DEFAULT_RESULT_MAX_BYTES)}; full oversized output is saved under the session runtime when enabled.`,
			'Default agent scope is "project" (.pi/agents plus .claude/agents compatibility).',
			'Use agentScope: "both" to include user-level agents from ~/.pi/agent/agents.',
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "project";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? false;
			const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const parentThinkingLevel = pi.getThinkingLevel();
			const parentSessionId = runtimeSessionId(ctx);
			const runtimeRoot = sessionRuntimeDir(parentSessionId);

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult].map((result) => {
										const rawOutput = getFinalOutput(result.messages);
										return {
											...result,
											messages: cloneMessagesForDetails(
												result.messages,
												rawOutput ? truncateForDetails(rawOutput, ctx.cwd) : undefined,
												ctx.cwd,
											),
										};
									});
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const stepAgent = agents.find((agent) => agent.name === step.agent);
					const result = stepAgent?.pane
						? await runPersistentPaneAgent(
								ctx.cwd,
								runtimeRoot,
								parentSessionId,
								agents,
								step.agent,
								taskWithContext,
								step.cwd,
								parentModel,
								parentThinkingLevel,
								i + 1,
							)
						: await runSingleAgent(
								ctx.cwd,
								agents,
								step.agent,
								taskWithContext,
								step.cwd,
								parentModel,
								parentThinkingLevel,
								i + 1,
								signal,
								chainUpdate,
								makeDetails("chain"),
							);
					results.push(result);

					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg =
							result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						const preparedResults = await Promise.all(
							results.map((candidate, index) =>
								prepareSingleResultForReturn(
									candidate,
									runtimeRoot,
									ctx.cwd,
									`chain-step-${candidate.step ?? index + 1}`,
									candidate === result ? errorMsg : undefined,
								),
							),
						);
						const failed = preparedResults[preparedResults.length - 1];
						failed.result.errorMessage = failed.text || errorMsg;
						const details = makeDetails("chain")(preparedResults.map((prepared) => prepared.result));
						return {
							content: [
								{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${failed.text || "(no output)"}` },
							],
							details: detailsWithTruncation(details, failed),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				const preparedResults = await Promise.all(
					results.map((result, index) =>
						prepareSingleResultForReturn(result, runtimeRoot, ctx.cwd, `chain-step-${result.step ?? index + 1}`),
					),
				);
				const last = preparedResults[preparedResults.length - 1];
				const details = makeDetails("chain")(preparedResults.map((prepared) => prepared.result));
				return {
					content: [{ type: "text", text: last.text || "(no output)" }],
					details: detailsWithTruncation(details, last),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				const maxParallelTasks = Math.max(1, Math.floor(settingNumber("maxParallelTasks", MAX_PARALLEL_TASKS, ctx.cwd)));
				if (params.tasks.length > maxParallelTasks)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${maxParallelTasks}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						const updateResults = allResults.map((result) => {
							const rawOutput = getFinalOutput(result.messages);
							return {
								...result,
								messages: cloneMessagesForDetails(
									result.messages,
									rawOutput ? truncateForDetails(rawOutput, ctx.cwd) : undefined,
									ctx.cwd,
								),
							};
						});
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")(updateResults),
						});
					}
				};

				const maxConcurrency = Math.max(1, Math.floor(settingNumber("maxConcurrency", MAX_CONCURRENCY, ctx.cwd)));
				const results = await mapWithConcurrencyLimit(params.tasks, maxConcurrency, async (t: { agent: string; task: string; cwd?: string }, index) => {
					const taskAgent = agents.find((agent) => agent.name === t.agent);
					const result = taskAgent?.pane
						? await runPersistentPaneAgent(
								ctx.cwd,
								runtimeRoot,
								parentSessionId,
								agents,
								t.agent,
								t.task,
								t.cwd,
								parentModel,
								parentThinkingLevel,
								undefined,
							)
						: await runSingleAgent(
								ctx.cwd,
								agents,
								t.agent,
								t.task,
								t.cwd,
								parentModel,
								parentThinkingLevel,
								undefined,
								signal,
								// Per-task update callback
								(partial) => {
									if (partial.details?.results[0]) {
										allResults[index] = partial.details.results[0];
										emitParallelUpdate();
									}
								},
								makeDetails("parallel"),
							);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const perResultLimits = splitResultLimits(resultLimits(ctx.cwd), results.length);
				const preparedResults = await Promise.all(
					results.map((result, index) =>
						prepareSingleResultForReturn(
							result,
							runtimeRoot,
							ctx.cwd,
							`parallel-${index + 1}-${result.agent}`,
							undefined,
							perResultLimits,
						),
					),
				);
				const sections = preparedResults.map((prepared) => {
					const r = prepared.result;
					const status = r.exitCode === 0 ? "completed" : r.exitCode === -1 ? "running" : "failed";
					return `## ${r.agent} (${status})\n${prepared.text || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${sections.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(preparedResults.map((prepared) => prepared.result)),
				};
			}

			if (params.agent && params.task) {
				const agent = agents.find((candidate) => candidate.name === params.agent);
				const result = agent?.pane
					? await runPersistentPaneAgent(
							ctx.cwd,
							runtimeRoot,
							parentSessionId,
							agents,
							params.agent,
							params.task,
							params.cwd,
							parentModel,
							parentThinkingLevel,
							undefined,
						)
					: await runSingleAgent(
							ctx.cwd,
							agents,
							params.agent,
							params.task,
							params.cwd,
							parentModel,
							parentThinkingLevel,
							undefined,
							signal,
							onUpdate,
							makeDetails("single"),
						);
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg =
						result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					const prepared = await prepareSingleResultForReturn(result, runtimeRoot, ctx.cwd, "single-error", errorMsg);
					prepared.result.errorMessage = prepared.text || errorMsg;
					const details = makeDetails("single")([prepared.result]);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${prepared.text || "(no output)"}` }],
						details: detailsWithTruncation(details, prepared),
						isError: true,
					};
				}
				const prepared = await prepareSingleResultForReturn(result, runtimeRoot, ctx.cwd, "single");
				const details = makeDetails("single")([prepared.result]);
				return {
					content: [{ type: "text", text: prepared.text || "(no output)" }],
					details: detailsWithTruncation(details, prepared),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			const treeLine = (prefix: "├" | "└", name: string, task?: string) =>
				`${theme.fg("muted", `  ${prefix} `)}${theme.fg("accent", theme.bold(name))}${task ? theme.fg("text", ` (${oneLinePreview(task, 72)})`) : ""}`;
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				const tasks = args.tasks as Array<{ agent: string; task?: string }>;
				let text =
					theme.fg("accent", "● ") +
					theme.fg("toolTitle", theme.bold(`${tasks.length} background agent${tasks.length === 1 ? "" : "s"} launching`)) +
					theme.fg("muted", ` [${scope}]`);
				const shown = tasks.slice(0, 8);
				for (const [index, task] of shown.entries()) {
					text += `\n${treeLine(index === shown.length - 1 && tasks.length <= shown.length ? "└" : "├", task.agent, task.task)}`;
				}
				if (tasks.length > shown.length) text += `\n${theme.fg("muted", `  └ … +${tasks.length - shown.length} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, context) {
			const collapsedItemCount = Math.max(1, Math.floor(settingNumber("collapsedItemCount", COLLAPSED_ITEM_COUNT, context?.cwd)));
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const truncationBadge = (r: SingleResult) => (r.truncation?.truncated ? theme.fg("warning", " · truncated") : "");
			const fullOutputLine = (r: SingleResult) =>
				r.fullOutputPath
					? theme.fg("dim", `Full output: ${r.fullOutputPath}`)
					: r.fullOutputError
						? theme.fg("warning", `Full output unavailable: ${r.fullOutputError}`)
						: "";

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					header += truncationBadge(r);
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const outputPath = fullOutputLine(r);
					if (outputPath) container.addChild(new Text(outputPath, 0, 0));
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				text += truncationBadge(r);
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, collapsedItemCount)}`;
					if (displayItems.length > collapsedItemCount) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const outputPath = fullOutputLine(r);
				if (outputPath) text += `\n${outputPath}`;
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}${truncationBadge(r)}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const outputPath = fullOutputLine(r);
						if (outputPath) container.addChild(new Text(outputPath, 0, 0));
						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}${truncationBadge(r)}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
					const outputPath = fullOutputLine(r);
					if (outputPath) text += `\n${outputPath}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				const total = details.results.length;
				const headerLabel = isRunning
					? `${total} background agent${total === 1 ? "" : "s"} running`
					: failCount > 0
						? `${successCount}/${total} background agent${total === 1 ? "" : "s"} completed`
						: `${total} background agent${total === 1 ? "" : "s"} completed`;
				const headerText =
					theme.fg("accent", "● ") +
					theme.fg("toolTitle", theme.bold(headerLabel)) +
					(expanded ? "" : theme.fg("muted", " (Ctrl+O to inspect)"));
				const rowIcon = (r: SingleResult) =>
					r.exitCode === -1 ? theme.fg("warning", "⏳ ") : r.exitCode === 0 ? theme.fg("success", "✓ ") : theme.fg("error", "✗ ");
				const treeText = details.results
					.map((r, index) => {
						const prefix = index === details.results.length - 1 ? "└" : "├";
						const task = oneLinePreview(r.task, 72);
						return `${theme.fg("muted", `  ${prefix} `)}${rowIcon(r)}${theme.fg("accent", theme.bold(r.agent))}${task ? theme.fg("text", ` (${task})`) : ""}${truncationBadge(r)}`;
					})
					.join("\n");

				if (expanded && !isRunning) {
					const lines = [headerText];
					for (const [index, r] of details.results.entries()) {
						const isLast = index === details.results.length - 1;
						const branch = isLast ? "└" : "├";
						const stem = theme.fg("muted", isLast ? "     " : "  │  ");
						const task = oneLinePreview(r.task, 140);
						const displayItems = getDisplayItems(r.messages);
						const toolCalls = displayItems.filter((item) => item.type === "toolCall");
						const finalOutput = getFinalOutput(r.messages).trim();

						lines.push(
							`${theme.fg("muted", `  ${branch} `)}${rowIcon(r)}${theme.fg("accent", theme.bold(r.agent))}${task ? theme.fg("text", ` (${task})`) : ""}${truncationBadge(r)}`,
						);
						if (toolCalls.length > 0) {
							for (const item of toolCalls) lines.push(`${stem}${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, theme.fg.bind(theme))}`);
						}
						if (finalOutput) {
							if (toolCalls.length > 0) lines.push(stem);
							for (const line of finalOutput.split(/\r?\n/)) lines.push(`${stem}${line}`);
						}
						const outputPath = fullOutputLine(r);
						if (outputPath) lines.push(`${stem}${outputPath}`);
						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) lines.push(`${stem}${theme.fg("dim", taskUsage)}`);
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) lines.push("", theme.fg("dim", `Total: ${usageStr}`));
					return new Text(lines.join("\n"), 0, 0);
				}

				let text = `${headerText}\n${treeText}`;
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
