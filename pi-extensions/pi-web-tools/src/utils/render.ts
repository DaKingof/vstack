import { Text, truncateToWidth, type Component } from "@mariozechner/pi-tui";

export function emptyComponent(): Component {
	return { invalidate() {}, render: () => [] };
}

export function textComponent(text: string): Component {
	return new Text(text, 0, 0);
}

export function oneLine(value: unknown, max = 88): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

export function bullet(theme: any, tone: "accent" | "success" | "error" | "warning" = "accent"): string {
	return theme.fg(tone, "● ");
}

export function toolLabel(theme: any, label: string): string {
	return theme.fg("text", theme.bold(label));
}

export function dim(theme: any, text: string): string {
	return theme.fg("dim", text);
}

export function muted(theme: any, text: string): string {
	return theme.fg("muted", text);
}

export function accent(theme: any, text: string): string {
	return theme.fg("accent", text);
}

export function tree(theme: any, branch: "├" | "└" | "│" = "└"): string {
	if (branch === "│") return theme.fg("muted", "  │ ");
	return theme.fg("muted", `  ${branch}─ `);
}

export function firstText(result: any): string {
	const part = result?.content?.find?.((candidate: any) => candidate?.type === "text" && typeof candidate.text === "string");
	return part?.text ?? "";
}

export function renderLines(lines: string[]): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			return lines.map((line) => truncateToWidth(line, Math.max(1, width), ""));
		},
	};
}

export function webCallText(theme: any, label: string, target: string, meta?: string): string {
	return `${bullet(theme)}${toolLabel(theme, `${label} `)}${accent(theme, oneLine(target, 92))}${meta ? dim(theme, ` · ${meta}`) : ""}`;
}

export function successSummary(theme: any, label: string, target: string, meta?: string): string {
	return `${bullet(theme, "success")}${toolLabel(theme, `${label} `)}${accent(theme, oneLine(target, 92))}${meta ? dim(theme, ` · ${meta}`) : ""}`;
}

export function errorSummary(theme: any, label: string, message: string): string {
	return `${bullet(theme, "error")}${toolLabel(theme, `${label} `)}${theme.fg("error", oneLine(message, 120))}`;
}
