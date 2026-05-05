import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { computeNextActiveTools, statusLines } from "./active-tools.js";
import { INSTALL_SYMBOL } from "./activation.js";
import { rewriteNativeOpenAiWebSearch } from "./native-openai.js";
import { resolveWebProvider } from "./provider-selection.js";
import { loadSettings, WEB_PROVIDERS, type WebProvider, type WebToolsSettings } from "./settings.js";
import { restoreStoredContent } from "./storage.js";
import { createCodeSearchToolDefinition } from "./tools/code-search.js";
import { createGetWebContentToolDefinition } from "./tools/get-web-content.js";
import { createWebAnswerToolDefinition } from "./tools/web-answer.js";
import { createWebFetchToolDefinition } from "./tools/web-fetch.js";
import { createWebFindSimilarToolDefinition } from "./tools/web-find-similar.js";
import { createWebResearchToolDefinition } from "./tools/web-research.js";
import { createWebSearchToolDefinition } from "./tools/web-search.js";

type ModelLike = { provider?: string; id?: string; name?: string };
let providerOverride: WebProvider | undefined;

function currentSettings(cwd?: string): WebToolsSettings {
	const settings = loadSettings(cwd);
	if (providerOverride) settings.defaultProvider = providerOverride;
	return settings;
}

function contextModel(ctx: ExtensionContext): ModelLike | undefined {
	return ctx.model as ModelLike | undefined;
}

function registerTools(pi: ExtensionAPI): void {
	pi.registerTool(createWebSearchToolDefinition(pi, currentSettings) as never);
	pi.registerTool(createWebFetchToolDefinition(pi, currentSettings) as never);
	pi.registerTool(createWebResearchToolDefinition(pi, currentSettings) as never);
	pi.registerTool(createWebAnswerToolDefinition(pi, currentSettings) as never);
	pi.registerTool(createWebFindSimilarToolDefinition(pi, currentSettings) as never);
	pi.registerTool(createCodeSearchToolDefinition(pi, currentSettings) as never);
	pi.registerTool(createGetWebContentToolDefinition() as never);
	if (currentSettings().compatibilityTools) {
		pi.registerTool(createWebFetchToolDefinition(pi, currentSettings, "fetch_content") as never);
		pi.registerTool(createGetWebContentToolDefinition("get_search_content") as never);
		pi.registerTool(createWebSearchToolDefinition(pi, currentSettings, "web_search_exa", "exa") as never);
		pi.registerTool(createWebFetchToolDefinition(pi, currentSettings, "web_fetch_exa") as never);
		pi.registerTool(createWebResearchToolDefinition(pi, currentSettings, "web_research_exa") as never);
		pi.registerTool(createWebAnswerToolDefinition(pi, currentSettings, "web_answer_exa") as never);
		pi.registerTool(createWebFindSimilarToolDefinition(pi, currentSettings, "web_find_similar_exa") as never);
	}
}

function syncActiveTools(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const settings = currentSettings(ctx.cwd);
	const active = pi.getActiveTools?.() ?? [];
	const next = computeNextActiveTools(active, contextModel(ctx), settings);
	if (next.join("\0") !== active.join("\0")) pi.setActiveTools(next);
}

function registerDiagnosticCommand(pi: ExtensionAPI): void {
	pi.registerCommand("web-tools", {
		description: "Show Web Tools status or set provider. Usage: /web-tools doctor | provider [auto|exa|openai-native|perplexity|gemini]",
		getArgumentCompletions(prefix: string) {
			const items = ["doctor", "settings", "provider", "provider auto", "provider exa", "provider openai-native", "provider perplexity", "provider gemini"].map((value) => ({ value, label: value }));
			const query = prefix.trim().toLowerCase();
			const filtered = items.filter((item) => item.value.startsWith(query));
			return filtered.length ? filtered : null;
		},
		handler: async (args: string, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const settings = currentSettings(ctx.cwd);
			if (parts[0] === "settings") {
				ctx.ui.notify("Web Tools settings live under vstack.extensionManager.config[\"pi-web-tools\"]. Use env vars or PI_WEB_TOOLS_CONFIG_FILE for API keys.", "info");
				return;
			}
			if (parts[0] === "provider" && parts[1]) {
				const next = parts[1] as WebProvider;
				if (!WEB_PROVIDERS.includes(next)) {
					ctx.ui.notify(`Unknown provider: ${parts[1]}. Use auto, exa, openai-native, perplexity, or gemini.`, "error");
					return;
				}
				providerOverride = next;
				syncActiveTools(pi, ctx);
				ctx.ui.notify(`Web Tools provider set to ${next} for this session. Persist via vstack.extensionManager.config[\"pi-web-tools\"].defaultProvider.`, "info");
				return;
			}
			const lines = statusLines(contextModel(ctx), settings);
			if (settings.warnings.length) lines.push("warnings:", ...settings.warnings.map((line) => `- ${line}`));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

export default function webTools(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;

	registerDiagnosticCommand(pi);
	registerTools(pi);

	pi.on("session_start", async (_event, ctx) => {
		restoreStoredContent(ctx);
		syncActiveTools(pi, ctx);
	});
	pi.on("model_select", async (_event, ctx) => syncActiveTools(pi, ctx));
	pi.on("thinking_level_select", async (_event, ctx) => syncActiveTools(pi, ctx));

	pi.on("before_provider_request", (event, ctx) => {
		const settings = currentSettings(ctx.cwd);
		if (!settings.enabled || !settings.nativeOpenAiWebSearch) return undefined;
		const resolution = resolveWebProvider(undefined, settings, contextModel(ctx));
		if (resolution.provider !== "openai-native") return undefined;
		const result = rewriteNativeOpenAiWebSearch(event.payload, { externalWebAccess: settings.openAiExternalWebAccess });
		return result.rewritten.length > 0 ? result.payload : undefined;
	});
}
