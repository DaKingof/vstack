import { accent, emptyComponent, errorSummary, firstText, muted, oneLine, providerLabel, successSummary, textComponent, tree, webCallText } from "../utils/render.js";

export interface ExaRenderableResult {
	title?: string;
	url?: string;
	contentId?: string;
}

export function renderExaCall(label: string, target: string | undefined, theme: any, context: any, meta?: string) {
	if (context?.executionStarted && !context?.isPartial) return emptyComponent();
	return textComponent(webCallText(theme, providerLabel(label, "exa"), target || "query", meta));
}

export function renderExaResultList(label: string, target: string | undefined, result: any, options: any, theme: any, context: any, resultNoun = "results") {
	if (options?.isPartial) return emptyComponent();
	if (context?.isError) return textComponent(errorSummary(theme, providerLabel(label, "exa"), firstText(result) || "failed"));
	const details = result?.details ?? {};
	const results: ExaRenderableResult[] = Array.isArray(details.results) ? details.results : [];
	const meta = `${results.length} ${resultNoun}`;
	const lines = [successSummary(theme, providerLabel(label, "exa"), target || "complete", meta)];
	const limit = options?.expanded ? 8 : 3;
	const shown = results.slice(0, limit);
	for (let index = 0; index < shown.length; index++) {
		const item = shown[index]!;
		const title = item.title || item.url || "Untitled";
		const bits = [item.url ? oneLine(item.url, 72) : undefined].filter(Boolean).join(" · ");
		const isLast = index === shown.length - 1 && results.length <= shown.length;
		lines.push(`${tree(theme, isLast ? "└" : "├")}${accent(theme, oneLine(title, 72))}${bits ? muted(theme, ` · ${bits}`) : ""}`);
	}
	if (results.length > limit) lines.push(`${tree(theme, "└")}${muted(theme, `… ${results.length - limit} more · Ctrl+O to expand`)}`);
	return textComponent(lines.join("\n"));
}
