import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	expandLoadedSlashContent,
	parseCommandArgs,
	pasteAndSubmitToPane,
	resolveOwnTmuxPaneByParentChain,
	type ExecLike,
	type SlashCommandInfoLike,
} from "../extensions/session-bridge.ts";

let dir = "";
let oldTmux: string | undefined;
function p(name: string): string { return join(dir, name); }

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-session-bridge-slash-"));
	oldTmux = process.env.TMUX;
});

afterEach(() => {
	if (oldTmux === undefined) delete process.env.TMUX;
	else process.env.TMUX = oldTmux;
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("slash expansion", () => {
	test("bridge dispatch matrix matches Pi editor outcomes", () => {
		const skillPath = p("skills/worktree/SKILL.md");
		const promptPath = p("prompts/clear-ai.md");
		mkdirSync(dirname(skillPath), { recursive: true });
		mkdirSync(dirname(promptPath), { recursive: true });
		writeFileSync(skillPath, "---\nname: worktree\ndescription: Worktree ops\n---\n# Worktree\nUse git worktrees.\n");
		writeFileSync(promptPath, "---\ndescription: Clear AI\n---\nClear $1 with all=$@ and rest=${@:2}\n");

		const commands: SlashCommandInfoLike[] = [
			{ name: "bridge:ping", source: "extension", sourceInfo: { path: p("bridge.ts") } },
			{ name: "tasks:add", source: "extension", sourceInfo: { path: p("tasks.ts") } },
			{ name: "skill:worktree", source: "skill", sourceInfo: { path: skillPath } },
			{ name: "clear-ai", source: "prompt", sourceInfo: { path: promptPath } },
		];

		const plain = expandLoadedSlashContent("hello", commands);
		expect(plain.expanded).toBe(false);

		const ping = expandLoadedSlashContent("/bridge:ping ok", commands);
		expect(ping.expanded).toBe(false); // Route 2: own tmux pane, editor executes extension command.

		const tasks = expandLoadedSlashContent("/tasks:add foo", commands);
		expect(tasks.expanded).toBe(false); // Route 2: own tmux pane, editor executes extension command.

		const skill = expandLoadedSlashContent("/skill:worktree status", commands);
		expect(skill.expanded).toBe(true);
		expect(skill.kind).toBe("skill");
		expect(skill.text).toBe([
			`<skill name="worktree" location="${skillPath}">`,
			`References are relative to ${dirname(skillPath)}.`,
			"",
			"# Worktree",
			"Use git worktrees.",
			"</skill>",
			"",
			"status",
		].join("\n"));

		const prompt = expandLoadedSlashContent('/clear-ai one "two words"', commands);
		expect(prompt.expanded).toBe(true);
		expect(prompt.kind).toBe("prompt");
		expect(prompt.text).toBe("Clear one with all=one two words and rest=two words");
	});

	test("extension command wins name collisions, matching Pi prompt() precedence", () => {
		const promptPath = p("prompts/dupe.md");
		mkdirSync(dirname(promptPath), { recursive: true });
		writeFileSync(promptPath, "Prompt body");
		const result = expandLoadedSlashContent("/dupe args", [
			{ name: "dupe", source: "prompt", sourceInfo: { path: promptPath } },
			{ name: "dupe", source: "extension", sourceInfo: { path: p("extension.ts") } },
		]);
		expect(result.expanded).toBe(false);
	});

	test("prompt argument substitution matches Pi prompt-template rules", () => {
		expect(parseCommandArgs("one 'two words' \"three words\" four")).toEqual(["one", "two words", "three words", "four"]);
		const promptPath = p("template.md");
		writeFileSync(promptPath, "---\ndescription: Demo\n---\n$1|$2|$@|$ARGUMENTS|${@:2}|${@:2:2}");
		const result = expandLoadedSlashContent('/template alpha "beta gamma" delta', [
			{ name: "template", source: "prompt", sourceInfo: { path: promptPath } },
		]);
		expect(result.text).toBe("alpha|beta gamma|alpha beta gamma delta|alpha beta gamma delta|beta gamma delta|beta gamma delta");
	});
});

describe("tmux pane dispatch", () => {
	test("resolves own pane by parent chain, not active tmux client state", async () => {
		process.env.TMUX = "/tmp/tmux-1000/default,123,0";
		const calls: Array<[string, string[]]> = [];
		const exec: ExecLike = async (command, args) => {
			calls.push([command, args]);
			if (command === "tmux") return { code: 0, stdout: "100 %1\n250 %2\n" };
			const pid = args.at(-1);
			if (pid === "303") return { code: 0, stdout: "202\n" };
			if (pid === "202") return { code: 0, stdout: "100\n" };
			if (pid === "100") return { code: 0, stdout: "1\n" };
			return { code: 1, stderr: "missing pid" };
		};

		await expect(resolveOwnTmuxPaneByParentChain(exec, 303)).resolves.toBe("%1");
		expect(calls[0]).toEqual(["tmux", ["list-panes", "-a", "-F", "#{pane_pid} #{pane_id}"]]);
		expect(calls.some(([command, args]) => command === "tmux" && args[0] === "display-message")).toBe(false);
	});

	test("pastes slash text literally and submits Enter", async () => {
		const calls: Array<[string, string[]]> = [];
		const exec: ExecLike = async (command, args) => {
			calls.push([command, args]);
			return { code: 0, stdout: "" };
		};
		await pasteAndSubmitToPane(exec, "%7", "/tasks:add foo");
		expect(calls).toEqual([
			["tmux", ["send-keys", "-t", "%7", "-l", "/tasks:add foo"]],
			["tmux", ["send-keys", "-t", "%7", "Enter"]],
		]);
	});
});
