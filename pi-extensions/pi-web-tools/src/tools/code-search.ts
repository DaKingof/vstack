import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ExaClient } from "../providers/exa.js";
import type { WebToolsSettings } from "../settings.js";
import { storeWebContent } from "../storage.js";
import { sourceList } from "../utils/format.js";
import { renderExaCall, renderExaResultList } from "./exa-render.js";

export const codeSearchSchema = Type.Object({ query: Type.String(), numResults: Type.Optional(Type.Number()), includeDomains: Type.Optional(Type.Array(Type.String())) });
export type CodeSearchInput = Static<typeof codeSearchSchema>;

export function createCodeSearchToolDefinition(pi: ExtensionAPI, getSettings: (cwd?: string) => WebToolsSettings) {
	return {
		renderShell: "self" as const,
		name: "code_search",
		label: "Code Search",
		description: "Search code and technical documentation. Uses Exa direct search with code-focused domain hints; Exa MCP get_code_context_exa is staged when available.",
		promptSnippet: "Search for code examples and technical docs via Exa.",
		parameters: codeSearchSchema,
		renderCall(args: CodeSearchInput, theme: any, context: any) {
			return renderExaCall("Code Search", args?.query, theme, context, args?.numResults ? `${args.numResults} results` : undefined);
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			return renderExaResultList("Code Search", context?.args?.query, result, options, theme, context, "results");
		},
		async execute(_toolCallId: string, params: CodeSearchInput, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			const client = new ExaClient({ apiKey: getSettings(ctx.cwd).apiKeys.exa });
			const includeDomains = params.includeDomains?.length ? params.includeDomains : ["github.com", "docs.github.com", "stackoverflow.com"];
			const response = await client.search({ query: params.query, numResults: params.numResults ?? 8, includeDomains }, signal);
			const results = response.results.map((result) => {
				const stored = result.text || result.summary ? storeWebContent(pi, { title: result.title, url: result.url, content: result.text || result.summary || "", metadata: { query: params.query, provider: "exa", tool: "code_search", contentKind: "code-search-result", providerTextMaxCharacters: 12000 } }) : undefined;
				return { ...result, contentId: stored?.id };
			});
			return { content: [{ type: "text", text: `${sourceList(results)}${results.some((result) => result.contentId) ? "\n\nUse get_web_content with the content id for stored full text." : ""}` }], details: { ...response, provider: "exa", results } };
		},
	};
}
