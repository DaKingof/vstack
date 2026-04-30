import { StringEnum } from "@mariozechner/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Type } from "typebox";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-task-panel.installed");
const STATE_TYPE = "vstack-task-panel:state";
const WIDGET_KEY = "vstack-task-panel";

type Status = "pending" | "in_progress" | "completed" | "abandoned";
type PanelState = "hidden" | "compact" | "expanded";
type VstackConfig = Record<string, unknown>;

interface TaskItem {
	id: string;
	content: string;
	status: Status;
	phaseId?: string;
	notes: string[];
	order: number;
}

interface PhaseItem {
	id: string;
	title: string;
	order: number;
}

interface TodoState {
	version: 1;
	panel: PanelState;
	phases: PhaseItem[];
	tasks: TaskItem[];
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
			const config = parsed?.vstack?.extensionManager?.config?.["pi-task-panel"];
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

function settingString(key: string, fallback: string, cwd?: string): string {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function newId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function emptyState(cwd?: string): TodoState {
	const panel = settingString("panelDefaultState", "compact", cwd) as PanelState;
	return { panel: panel === "hidden" || panel === "expanded" ? panel : "compact", phases: [], tasks: [], updatedAt: new Date().toISOString(), version: 1 };
}

function cloneState(state: TodoState): TodoState {
	return JSON.parse(JSON.stringify(state)) as TodoState;
}

function normalizeState(value: unknown, cwd?: string): TodoState {
	if (!value || typeof value !== "object") return emptyState(cwd);
	const candidate = value as Partial<TodoState>;
	return {
		version: 1,
		panel: candidate.panel === "hidden" || candidate.panel === "expanded" ? candidate.panel : "compact",
		phases: Array.isArray(candidate.phases) ? candidate.phases.filter((p): p is PhaseItem => Boolean(p?.id && p.title)) : [],
		tasks: Array.isArray(candidate.tasks) ? candidate.tasks.filter((t): t is TaskItem => Boolean(t?.id && t.content && t.status)) : [],
		updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
	};
}

function taskIcon(status: Status, active = false): string {
	if (active || status === "in_progress" || status === "completed") return "●";
	return "○";
}

function markerColor(status: Status, active = false): string {
	if (active || status === "in_progress") return "accent";
	if (status === "completed") return "success";
	if (status === "abandoned") return "error";
	return "dim";
}

function taskText(task: TaskItem, active: boolean, theme: Theme): string {
	if (active || task.status === "in_progress") return theme.fg("accent", task.content);
	if (task.status === "completed") return theme.fg("muted", theme.strikethrough(task.content));
	if (task.status === "abandoned") return theme.fg("dim", theme.strikethrough(task.content));
	return task.content;
}

function renderTaskLine(task: TaskItem, theme: Theme, active = false): string {
	const marker = theme.fg(markerColor(task.status, active), taskIcon(task.status, active));
	const notes = task.notes.length ? theme.fg("dim", ` +${task.notes.length}`) : "";
	return ` ${marker} ${taskText(task, active, theme)}${notes}`;
}

function formatShortcutHint(shortcut: string): string {
	return shortcut
		.split("+")
		.map((part) => part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
		.join("+");
}

function panelToggleHint(cwd: string): string {
	const shortcut = settingString("alternateShortcut", "alt+t", cwd);
	return shortcut === "none" ? "" : `${formatShortcutHint(shortcut)} toggle`;
}

function activeTask(state: TodoState): TaskItem | undefined {
	return state.tasks.find((task) => task.status === "in_progress") ?? sortTasks(state.tasks).find((task) => task.status === "pending");
}

function ensureActiveTask(state: TodoState): TaskItem | undefined {
	const current = state.tasks.find((task) => task.status === "in_progress");
	if (current) return current;
	const next = sortTasks(state.tasks).find((task) => task.status === "pending");
	if (next) next.status = "in_progress";
	return next;
}

function remainingCount(state: TodoState): number {
	return state.tasks.filter((task) => task.status === "pending" || task.status === "in_progress").length;
}

function completedCount(state: TodoState): number {
	return state.tasks.filter((task) => task.status === "completed").length;
}

function phaseTitle(state: TodoState, phaseId?: string): string {
	return state.phases.find((phase) => phase.id === phaseId)?.title ?? "Tasks";
}

function sortTasks(tasks: TaskItem[]): TaskItem[] {
	return [...tasks].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function ensurePhase(state: TodoState, title: string): string {
	const trimmed = title.trim();
	const existing = state.phases.find((phase) => phase.title.toLowerCase() === trimmed.toLowerCase());
	if (existing) return existing.id;
	const phase: PhaseItem = { id: newId("phase"), order: state.phases.length, title: trimmed || "General" };
	state.phases.push(phase);
	return phase.id;
}

function updatePanelAfterTaskChange(state: TodoState, cwd?: string): void {
	const active = sortTasks(state.tasks.filter((task) => task.status === "in_progress"));
	for (const task of active.slice(1)) task.status = "pending";
	const remaining = remainingCount(state);
	if (remaining === 0 && state.tasks.length > 0) {
		state.panel = "hidden";
		return;
	}
	if (remaining > 0) {
		ensureActiveTask(state);
		if (state.panel === "hidden" && settingBoolean("autoShowOnFirstTask", true, cwd)) state.panel = "compact";
	}
}

function addTask(state: TodoState, content: string, phaseTitleText?: string, cwd?: string): TaskItem {
	const task: TaskItem = {
		content: content.trim(),
		id: newId("task"),
		notes: [],
		order: state.tasks.length,
		phaseId: phaseTitleText ? ensurePhase(state, phaseTitleText) : undefined,
		status: "pending",
	};
	state.tasks.push(task);
	updatePanelAfterTaskChange(state, cwd);
	return task;
}

function findTask(state: TodoState, token: string): TaskItem | undefined {
	const trimmed = token.trim();
	if (!trimmed) return undefined;
	const needle = trimmed.toLowerCase();
	return state.tasks.find((task) => task.id === trimmed) ?? state.tasks.find((task) => task.content.toLowerCase().includes(needle));
}

function findTaskOrActive(state: TodoState, token: string): TaskItem | undefined {
	return findTask(state, token) ?? (!token.trim() ? activeTask(state) : undefined);
}

function startTask(state: TodoState, token: string, cwd?: string): TaskItem | undefined {
	const task = findTaskOrActive(state, token);
	if (!task) return undefined;
	for (const candidate of state.tasks) if (candidate.status === "in_progress") candidate.status = "pending";
	task.status = "in_progress";
	updatePanelAfterTaskChange(state, cwd);
	return task;
}

function isStatus(value: unknown): value is Status {
	return value === "pending" || value === "in_progress" || value === "completed" || value === "abandoned";
}

function markStatus(state: TodoState, token: string, status: Status, cwd?: string): TaskItem | undefined {
	const task = findTaskOrActive(state, token);
	if (!task) return undefined;
	task.status = status;
	updatePanelAfterTaskChange(state, cwd);
	return task;
}

function removeTask(state: TodoState, token: string, cwd?: string): boolean {
	const task = findTask(state, token);
	if (!task) return false;
	state.tasks = state.tasks.filter((candidate) => candidate.id !== task.id);
	updatePanelAfterTaskChange(state, cwd);
	return true;
}

function toMarkdown(state: TodoState): string {
	const lines = ["# Tasks", ""];
	const phaseIds = new Set(state.tasks.map((task) => task.phaseId).filter(Boolean) as string[]);
	const phases = state.phases.filter((phase) => phaseIds.has(phase.id)).sort((a, b) => a.order - b.order);
	const unphased = sortTasks(state.tasks.filter((task) => !task.phaseId));
	const renderTask = (task: TaskItem) => {
		const box = task.status === "completed" ? "[x]" : task.status === "abandoned" ? "[-]" : task.status === "in_progress" ? "[>]" : "[ ]";
		lines.push(`- ${box} ${task.content} <!-- ${task.id} -->`);
		for (const note of task.notes) lines.push(`  - note: ${note}`);
	};
	if (unphased.length > 0) unphased.forEach(renderTask);
	for (const phase of phases) {
		lines.push("", `## ${phase.title}`, "");
		sortTasks(state.tasks.filter((task) => task.phaseId === phase.id)).forEach(renderTask);
	}
	return `${lines.join("\n").trim()}\n`;
}

function parseMarkdown(text: string, cwd?: string): TodoState {
	const state = emptyState(cwd);
	let currentPhase: string | undefined;
	let lastTask: TaskItem | undefined;
	for (const line of text.split(/\r?\n/)) {
		const phase = line.match(/^##\s+(.+)$/);
		if (phase) {
			currentPhase = ensurePhase(state, phase[1] ?? "General");
			lastTask = undefined;
			continue;
		}
		const note = line.match(/^\s+[-*]\s+note:\s*(.+)$/i);
		if (note && lastTask) {
			lastTask.notes.push(note[1] ?? "");
			continue;
		}
		const task = line.match(/^[-*]\s+\[( |x|-|>)\]\s+(.+?)(?:\s+<!--\s*([^>]+)\s*-->)?\s*$/i);
		if (!task) continue;
		const item = addTask(state, task[2] ?? "Task", undefined, cwd);
		item.phaseId = currentPhase;
		item.id = task[3]?.trim() || item.id;
		item.status = task[1] === "x" || task[1] === "X" ? "completed" : task[1] === "-" ? "abandoned" : task[1] === ">" ? "in_progress" : "pending";
		lastTask = item;
	}
	updatePanelAfterTaskChange(state, cwd);
	return state;
}

function renderPanelLines(state: TodoState, theme: Theme, cwd: string): string[] {
	if (state.tasks.length === 0 || state.panel === "hidden") return [];
	const remaining = remainingCount(state);
	const active = activeTask(state);
	const hint = panelToggleHint(cwd);
	const header = `${theme.fg("accent", theme.bold("Tasks"))} ${theme.fg("muted", `${completedCount(state)}/${state.tasks.length} done · ${remaining} remaining`)}`;
	if (state.panel === "compact") {
		const limit = Math.max(1, Math.floor(settingNumber("maxCompactTasks", 4, cwd)));
		const candidates = active?.phaseId ? sortTasks(state.tasks.filter((task) => task.phaseId === active.phaseId)) : sortTasks(state.tasks);
		const incomplete = candidates.filter((task) => task.status !== "completed" && task.status !== "abandoned");
		const visible = incomplete.filter((task) => task.id !== active?.id).slice(0, Math.max(0, limit - (active ? 1 : 0)));
		const lines = [header];
		if (active) lines.push(renderTaskLine(active, theme, true));
		for (const task of visible) lines.push(renderTaskLine(task, theme));
		const shown = visible.length + (active ? 1 : 0);
		const hidden = Math.max(0, remaining - shown);
		if (hidden > 0) lines.push(theme.fg("dim", ` +${hidden} more${hint ? ` · ${hint}` : ""}`));
		else if (hint) lines.push(theme.fg("dim", ` ${hint}`));
		return lines;
	}
	const lines = [hint ? `${header} ${theme.fg("dim", `· ${hint}`)}` : header];
	const phases = [...state.phases].sort((a, b) => a.order - b.order);
	const unphased = sortTasks(state.tasks.filter((task) => !task.phaseId));
	if (unphased.length) lines.push(...renderTaskGroup("Tasks", unphased, theme, cwd));
	for (const phase of phases) {
		const tasks = sortTasks(state.tasks.filter((task) => task.phaseId === phase.id));
		if (tasks.length) lines.push(...renderTaskGroup(phase.title, tasks, theme, cwd));
	}
	return lines;
}

function renderTaskGroup(title: string, tasks: TaskItem[], theme: Theme, cwd: string): string[] {
	const lines = [theme.fg("muted", title)];
	const active = tasks.find((task) => task.status === "in_progress");
	for (const task of tasks) {
		const isActive = active?.id === task.id;
		lines.push(renderTaskLine(task, theme, isActive));
		if (isActive && settingBoolean("showNotesInExpanded", true, cwd)) {
			for (const note of task.notes) lines.push(theme.fg("dim", `    note: ${note}`));
		}
	}
	return lines;
}

function writeFileSafe(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, "utf8");
}

function summarize(state: TodoState): string {
	return `${state.tasks.length} task(s), ${remainingCount(state)} remaining, panel=${state.panel}`;
}

function toolResultSummary(action: string, message: string, state: TodoState): string {
	if (message.startsWith("No task")) return message;
	const remaining = remainingCount(state);
	const suffix = remaining === 0 ? "all complete" : `${remaining} remaining`;
	switch (action) {
		case "replace": return `${state.tasks.length} tasks written (${suffix})`;
		case "add_task": return `1 task added (${suffix})`;
		case "add_phase": return "phase added";
		case "start_task": return `task started (${suffix})`;
		case "mark_done": return `1 task completed (${suffix})`;
		case "drop_task": return `1 task dropped (${suffix})`;
		case "remove_task": return `1 task removed (${suffix})`;
		case "append_note": return "task note added";
		case "set_panel": return `task panel ${state.panel}`;
		default: return message;
	}
}

const TodoToolParams = Type.Object({
	action: StringEnum(["replace", "add_phase", "add_task", "start_task", "mark_done", "drop_task", "remove_task", "append_note", "set_panel"] as const),
	tasks: Type.Optional(Type.Array(Type.Object({ content: Type.String(), status: Type.Optional(Type.String()), phase: Type.Optional(Type.String()), notes: Type.Optional(Type.Array(Type.String())) }))),
	phase: Type.Optional(Type.String()),
	task: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
	panel: Type.Optional(StringEnum(["hidden", "compact", "expanded"] as const)),
});

export default function taskPanel(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;
	if (!settingBoolean("enabled", true)) return;

	let state: TodoState = emptyState();
	let activeCtx: ExtensionContext | undefined;
	let lastReminderAt = 0;

	const persist = () => {
		state.updatedAt = new Date().toISOString();
		pi.appendEntry<TodoState>(STATE_TYPE, cloneState(state));
	};

	const restore = (ctx: ExtensionContext) => {
		activeCtx = ctx;
		state = emptyState(ctx.cwd);
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE) state = normalizeState(entry.data, ctx.cwd);
		}
		updatePanelAfterTaskChange(state, ctx.cwd);
		syncWidget(ctx);
	};

	const syncWidget = (ctx: ExtensionContext) => {
		activeCtx = ctx;
		if (!ctx.hasUI || state.tasks.length === 0 || state.panel === "hidden") {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				return renderPanelLines(state, theme, ctx.cwd).map((line) => truncateToWidth(line, width, ""));
			},
		}), { placement: "aboveEditor" });
	};

	const mutate = (ctx: ExtensionContext | ExtensionCommandContext, fn: () => string): string => {
		const message = fn();
		persist();
		syncWidget(ctx as ExtensionContext);
		return message;
	};

	async function manage(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify(toMarkdown(state), "info");
			return;
		}
		await ctx.ui.custom((_tui, theme, _kb, done) => ({
			handleInput(data: string) {
				if (data === "\u001b" || data === "\u0003") done(undefined);
			},
			invalidate() {},
			render(width: number) {
				const lines = [theme.fg("accent", theme.bold("Tasks manager")), theme.fg("dim", "esc close · use /todo edit for bulk editing"), "", ...renderPanelLines({ ...state, panel: "expanded" }, theme, (ctx as ExtensionContext).cwd)];
				return lines.map((line) => truncateToWidth(line, width, ""));
			},
		}), { overlay: true, overlayOptions: { anchor: "center", width: 100, maxHeight: "85%" } });
	}

	function handleTodoCommand(args: string, ctx: ExtensionCommandContext): Promise<void> | void {
		const trimmed = args.trim();
		if (!trimmed || trimmed === "manage") return manage(ctx);
		const [cmd, ...restParts] = trimmed.split(/\s+/);
		const rest = restParts.join(" ").trim();
		let message = "";
		switch (cmd) {
			case "add": {
				const [phase, task] = rest.includes("::") ? rest.split(/\s*::\s*/, 2) : [undefined, rest];
				message = mutate(ctx, () => `Added ${addTask(state, task || rest, phase, ctx.cwd).id}`);
				break;
			}
			case "start": message = mutate(ctx, () => startTask(state, rest, ctx.cwd)?.content ?? `No task matched: ${rest}`); break;
			case "done": message = mutate(ctx, () => markStatus(state, rest, "completed", ctx.cwd)?.content ?? `No task matched: ${rest}`); break;
			case "drop": message = mutate(ctx, () => markStatus(state, rest, "abandoned", ctx.cwd)?.content ?? `No task matched: ${rest}`); break;
			case "rm": message = mutate(ctx, () => removeTask(state, rest, ctx.cwd) ? `Removed ${rest}` : `No task matched: ${rest}`); break;
			case "clear-completed": message = mutate(ctx, () => { const before = state.tasks.length; state.tasks = state.tasks.filter((task) => task.status !== "completed"); updatePanelAfterTaskChange(state, ctx.cwd); return `Removed ${before - state.tasks.length} completed task(s)`; }); break;
			case "hide": message = mutate(ctx, () => { state.panel = "hidden"; return "Task panel hidden"; }); break;
			case "show":
			case "show4":
			case "show-4":
			case "compact": message = mutate(ctx, () => { state.panel = "compact"; return `Task panel showing ${Math.max(1, Math.floor(settingNumber("maxCompactTasks", 4, ctx.cwd)))} task(s)`; }); break;
			case "all":
			case "show-all":
			case "expand": message = mutate(ctx, () => { state.panel = "expanded"; return "Task panel showing all tasks"; }); break;
			case "export": { const out = rest || join(ctx.cwd, ".pi", "tasks.md"); writeFileSafe(resolve(ctx.cwd, out), toMarkdown(state)); message = `Exported tasks to ${out}`; break; }
			case "import": { const input = resolve(ctx.cwd, rest || join(".pi", "tasks.md")); state = parseMarkdown(readFileSync(input, "utf8"), ctx.cwd); message = mutate(ctx, () => `Imported ${state.tasks.length} task(s)`); break; }
			case "edit": return ctx.ui.editor("Edit tasks markdown", toMarkdown(state)).then((text) => { if (text !== undefined) { state = parseMarkdown(text, ctx.cwd); ctx.ui.notify(mutate(ctx, () => `Saved ${state.tasks.length} task(s)`), "info"); } });
			default: message = "Unknown /todo action. Try add/start/done/drop/rm/clear-completed/hide/show/show-all/compact/expand/edit/export/import/manage.";
		}
		ctx.ui.notify(message, message.startsWith("No task") || message.startsWith("Unknown") ? "warning" : "info");
	}

	pi.registerCommand("todo", { description: "Manage the persistent task panel", handler: async (args, ctx) => handleTodoCommand(args, ctx) });

	pi.registerTool({
		name: "todo_write",
		label: "Todo Write",
		description: "Structured task panel updates: replace/add/start/done/drop/remove/note/panel.",
		promptSnippet: "Create and update the persistent task panel for multi-step work.",
		promptGuidelines: [
			"Use todo_write to keep a visible task list when the user asks for multi-step work or when you need to track progress across tool calls.",
			"Use todo_write replace for a fresh plan, add_task for discovered follow-ups, start_task before working a task, and mark_done/drop_task when status changes.",
			"todo_write automatically keeps one current task in progress, advances to the next pending task when the active task is completed/dropped, hides the panel when all tasks are complete, and shows it again when pending work appears.",
		],
		parameters: TodoToolParams,
		async execute(_id, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
			const runCtx = ctx ?? activeCtx;
			if (!runCtx) throw new Error("No active Pi context for todo_write");
			const message = mutate(runCtx, () => {
				switch (params.action) {
					case "replace": state = emptyState(runCtx.cwd); for (const input of params.tasks ?? []) { const task = addTask(state, input.content, input.phase, runCtx.cwd); task.status = isStatus(input.status) ? input.status : "pending"; task.notes = input.notes ?? []; } updatePanelAfterTaskChange(state, runCtx.cwd); return `Replaced tasks (${state.tasks.length})`;
					case "add_phase": ensurePhase(state, params.phase ?? "General"); return `Added phase ${params.phase ?? "General"}`;
					case "add_task": return `Added ${addTask(state, params.task ?? "Task", params.phase, runCtx.cwd).id}`;
					case "start_task": return startTask(state, params.task ?? "", runCtx.cwd)?.content ?? "No task matched";
					case "mark_done": return markStatus(state, params.task ?? "", "completed", runCtx.cwd)?.content ?? "No task matched";
					case "drop_task": return markStatus(state, params.task ?? "", "abandoned", runCtx.cwd)?.content ?? "No task matched";
					case "remove_task": return removeTask(state, params.task ?? "", runCtx.cwd) ? "Removed task" : "No task matched";
					case "append_note": { const task = findTaskOrActive(state, params.task ?? ""); if (!task) return "No task matched"; task.notes.push(params.note ?? ""); return `Noted ${task.content}`; }
					case "set_panel": state.panel = params.panel ?? "compact"; return `Panel ${state.panel}`;
					default: return "No todo action matched";
				}
			});
			const summary = toolResultSummary(params.action, message, state);
			return { content: [{ type: "text", text: `• ${summary}` }], details: { summary, state: cloneState(state) } };
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", "todo_write"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content?.find((part: any) => part?.type === "text")?.text ?? "• tasks updated";
			return new Text(theme.fg("muted", text), 0, 0);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		restore(ctx);
	});
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("agent_end", (_event, ctx) => {
		if (!settingBoolean("showIncompleteReminder", true, ctx.cwd) || remainingCount(state) === 0) return;
		const now = Date.now();
		if (now - lastReminderAt > 60_000) {
			lastReminderAt = now;
			ctx.ui.notify(`${remainingCount(state)} task(s) still incomplete. Use /todo manage or todo_write to update.`, "info");
		}
	});
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setWidget(WIDGET_KEY, undefined));

	const toggle = async (ctx: ExtensionContext) => {
		state.panel = state.panel === "hidden" ? "compact" : state.panel === "compact" ? "expanded" : "hidden";
		persist();
		syncWidget(ctx);
		if (ctx.hasUI) {
			const label = state.panel === "hidden" ? "hidden" : state.panel === "compact" ? `showing ${Math.max(1, Math.floor(settingNumber("maxCompactTasks", 4, ctx.cwd)))} task(s)` : "showing all tasks";
			ctx.ui.notify(`Task panel ${label}`, "info");
		}
	};
	const alternateShortcut = settingString("alternateShortcut", "alt+t");
	if (alternateShortcut !== "none") {
		pi.registerShortcut(alternateShortcut, { description: "Toggle task panel", handler: async (ctx) => toggle(ctx as ExtensionContext) });
	}
	if (settingBoolean("takeoverCtrlT", false)) {
		pi.registerShortcut("ctrl+t", { description: "Toggle task panel (vstack takeover)", handler: async (ctx) => toggle(ctx as ExtensionContext) });
	}
}
