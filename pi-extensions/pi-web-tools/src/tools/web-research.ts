import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import { ExaClient, type ExaDeepType, type NormalizedExaResponse } from "../providers/exa.js";
import type { WebToolsSettings } from "../settings.js";
import { emptyComponent, errorSummary, firstText, successSummary, textComponent, tree, webCallText } from "../utils/render.js";

const deepTypes = ["deep-reasoning", "deep-lite", "deep"] as const;
const reportFormats = ["findings", "markdown", "json"] as const;

export const webResearchSchema = Type.Object({
	query: Type.String({ description: "Research question to investigate with Exa Deep Search." }),
	type: Type.Optional(StringEnum(deepTypes)),
	systemPrompt: Type.Optional(Type.String()),
	additionalQueries: Type.Optional(Type.Array(Type.String())),
	numResults: Type.Optional(Type.Number()),
	textMaxCharacters: Type.Optional(Type.Number()),
	includeDomains: Type.Optional(Type.Array(Type.String())),
	excludeDomains: Type.Optional(Type.Array(Type.String())),
	startPublishedDate: Type.Optional(Type.String()),
	endPublishedDate: Type.Optional(Type.String()),
	outputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	outputPath: Type.Optional(Type.String({ description: "Optional path for the findings report. Relative paths resolve against ctx.cwd; leading @ is stripped." })),
	reportTitle: Type.Optional(Type.String()),
	reportFormat: Type.Optional(StringEnum(reportFormats)),
	rawOutputPath: Type.Optional(Type.String({ description: "Optional adjacent or explicit path for raw Exa JSON metadata." })),
});

export type WebResearchInput = Static<typeof webResearchSchema>;

function cleanPath(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

export function resolveOutputPath(cwd: string, rawPath: string): string {
	const cleaned = cleanPath(rawPath.trim());
	return isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
}

function bulletSources(response: NormalizedExaResponse): string {
	if (response.results.length === 0) return "- No source URLs returned by Exa.";
	return response.results.map((result, index) => `- [${index + 1}] ${result.title ?? result.url ?? "Untitled"}${result.url ? ` — ${result.url}` : ""}${result.publishedDate ? ` (${result.publishedDate})` : ""}`).join("\n");
}

export function renderFindingsReport(input: WebResearchInput, response: NormalizedExaResponse): string {
	const title = input.reportTitle || input.query;
	const answer = response.answer || "Exa returned sources but no synthesized answer field. Review the evidence and raw metadata below.";
	const evidence = response.results.map((result, index) => {
		const snippets = [result.summary, ...(result.highlights ?? []), result.text].filter(Boolean).join("\n");
		return `### [${index + 1}] ${result.title ?? result.url ?? "Untitled"}\n\n${result.url ?? ""}\n\n${snippets || "No snippet returned."}`;
	}).join("\n\n");
	return `# Findings: ${title}\n\n## Research Question\n\n${input.query}\n\n## Executive Summary\n\n${answer}\n\n## Key Findings\n\n${answer}\n\n## Evidence and Sources\n\n${bulletSources(response)}\n\n${evidence}\n\n## Tradeoffs / Alternatives\n\n- Review source evidence for tradeoffs; add project-specific analysis before making irreversible decisions.\n\n## Recommendation\n\n${answer}\n\n## Risks / Unknowns\n\n- Verify source freshness and applicability to this project.\n- Re-run research if provider APIs, pricing, or release notes change.\n\n## Revisit Conditions\n\n- New primary-source documentation contradicts these findings.\n- Implementation constraints differ from the context supplied to research.\n- Exa Deep Search returns materially different source coverage in a later run.\n\n## Raw Exa Metadata\n\n\`\`\`json\n${JSON.stringify({ metadata: response.metadata, raw: response.raw }, null, 2)}\n\`\`\`\n`;
}

async function writeQueued(path: string, content: string): Promise<void> {
	await withFileMutationQueue(path, async () => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
	});
}

export function createWebResearchToolDefinition(pi: ExtensionAPI, getSettings: (cwd?: string) => WebToolsSettings, name = "web_research") {
	return {
		renderShell: "self" as const,
		name,
		label: "Web Research",
		description: "Run Exa Deep Search research and optionally write a findings report. Requires EXA_API_KEY; does not fall back to general web search.",
		promptSnippet: "Run Exa deep research and write evidence-backed findings reports.",
		promptGuidelines: ["Use web_research for evidence-backed research reports; pass outputPath when the user asks for findings.md or a saved report."],
		parameters: webResearchSchema,
		renderCall(args: WebResearchInput, theme: any, context: any) {
			if (context?.executionStarted && !context?.isPartial) return emptyComponent();
			const meta = [args?.type ?? "deep-reasoning", args?.outputPath ? `→ ${args.outputPath}` : undefined].filter(Boolean).join(" · ");
			return textComponent(webCallText(theme, "Web Research", args?.query ?? "research", meta));
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (options?.isPartial) return emptyComponent();
			if (context?.isError) return textComponent(errorSummary(theme, "Web Research", firstText(result) || "failed"));
			const details = result?.details ?? {};
			const outputPath = details.outputPath as string | undefined;
			const rawOutputPath = details.rawOutputPath as string | undefined;
			const sourceCount = Array.isArray(details.sources) ? details.sources.length : undefined;
			const query = context?.args?.query ?? outputPath ?? "complete";
			const meta = [sourceCount != null ? `${sourceCount} sources` : undefined, outputPath ? `report ${outputPath}` : undefined].filter(Boolean).join(" · ");
			const lines = [successSummary(theme, "Web Research", query, meta)];
			if (rawOutputPath) lines.push(`${tree(theme, "└")}${theme.fg("muted", "raw metadata ")}${theme.fg("accent", rawOutputPath)}`);
			return textComponent(lines.join("\n"));
		},
		async execute(_toolCallId: string, params: WebResearchInput, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			const settings = getSettings(ctx.cwd);
			if (!settings.exaDeepResearchEnabled) throw new Error("web_research is disabled by pi-web-tools.exaDeepResearchEnabled.");
			const client = new ExaClient({ apiKey: settings.apiKeys.exa });
			const response = await client.deepResearch({
				query: params.query,
				type: (params.type ?? "deep-reasoning") as ExaDeepType,
				systemPrompt: params.systemPrompt,
				additionalQueries: params.additionalQueries,
				numResults: params.numResults,
				textMaxCharacters: params.textMaxCharacters,
				includeDomains: params.includeDomains,
				excludeDomains: params.excludeDomains,
				startPublishedDate: params.startPublishedDate,
				endPublishedDate: params.endPublishedDate,
				outputSchema: params.outputSchema,
			}, signal);
			const format = params.reportFormat ?? "findings";
			const report = format === "json" ? JSON.stringify(response.raw, null, 2) : renderFindingsReport(params, response);
			let outputPath: string | undefined;
			let rawOutputPath: string | undefined;
			if (params.outputPath) {
				outputPath = resolveOutputPath(ctx.cwd, params.outputPath);
				await writeQueued(outputPath, report);
			}
			if (params.rawOutputPath) {
				rawOutputPath = resolveOutputPath(ctx.cwd, params.rawOutputPath);
				await writeQueued(rawOutputPath, JSON.stringify(response.raw, null, 2));
			}
			pi.appendEntry?.("pi-web-tools.web_research", { query: params.query, outputPath, rawOutputPath, metadata: response.metadata, sources: response.results.length });
			return {
				content: [{ type: "text", text: outputPath ? `Exa deep research complete. Report: ${outputPath}\nSources: ${response.results.length}${rawOutputPath ? `\nRaw metadata: ${rawOutputPath}` : ""}` : report }],
				details: { outputPath, rawOutputPath, sources: response.results, metadata: response.metadata, raw: response.raw },
			};
		},
	};
}
