import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { loadSettings } from "./settings.js";
import {
	buildGeneratedImageDisplayText,
	IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
	saveOpenAICodexGeneratedImage,
} from "./provider-shim.js";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const BACKGROUND_IMAGE_INSTRUCTIONS = "Generate or edit images with the hosted image_generation tool. Use the user's prompt and any provided reference images. Return the image_generation_call result.";
const IMAGE_GEN_STATUS_KEY = "codex-image-gen";

interface ActiveImageJob {
	id: string;
	startedAt: number;
	prompt: string;
	referenceCount: number;
	imageModel: string;
}

const activeImageJobs = new Map<string, ActiveImageJob>();
let activeStatusCtx: ExtensionCommandContext | undefined;
let statusTimer: ReturnType<typeof setInterval> | undefined;

export interface ParsedImageGenCommand {
	prompt: string;
	imagePaths: string[];
}

interface ReferenceImage {
	path: string;
	mimeType: string;
	base64: string;
}

interface CodexImageResult {
	id: string;
	result: string;
	outputFormat?: string;
	revisedPrompt?: string;
	imageModel?: string;
}

function tokenizeArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (const ch of input) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

function padAnsi(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function imageGenBranch(theme: any, branch: "├" | "└"): string {
	return theme.fg("muted", `${branch}─ `);
}

function simpleFrame(lines: string[], width: number, theme: any, title: string): string[] {
	if (width < 8) return lines.map((line) => truncateToWidth(line, width, ""));
	const border = (text: string) => theme.fg("borderAccent", text);
	const titleText = ` ${truncateToWidth(title, Math.max(1, width - 4), "…")} `;
	const fill = Math.max(1, width - 2 - visibleWidth(titleText));
	const innerWidth = Math.max(1, width - 4);
	return [
		`${border("┏")}${theme.fg("success", titleText)}${border("━".repeat(fill))}${border("┓")}`,
		...lines.map((line) => `${border("┃")} ${padAnsi(truncateToWidth(line, innerWidth, ""), innerWidth)} ${border("┃")}`),
		`${border("┗")}${border("━".repeat(width - 2))}${border("┛")}`,
	].map((line) => truncateToWidth(line, width, ""));
}

function renderJobLines(theme: any, width: number): string[] {
	const jobs = Array.from(activeImageJobs.values()).sort((a, b) => a.startedAt - b.startedAt);
	if (jobs.length === 0) return [];
	const running = jobs.length;
	const dot = theme.fg("dim", " · ");
	const lines = [
		`${theme.fg("accent", "● ")}${theme.fg("text", theme.bold("Image Generation"))}${dot}${theme.fg("success", `${running} running`)}${dot}${theme.fg("dim", "/image-gen")}`,
	];
	const shown = jobs.slice(0, 4);
	for (const [index, job] of shown.entries()) {
		const ageSeconds = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000));
		const isLast = index === shown.length - 1 && jobs.length <= shown.length;
		const refs = job.referenceCount > 0 ? `${dot}${theme.fg("warning", `${job.referenceCount} ref`)}` : "";
		const promptWidth = Math.max(16, width - 36);
		lines.push(`${imageGenBranch(theme, isLast ? "└" : "├")}${theme.fg("accent", "◐ ")}${theme.fg("toolOutput", job.imageModel)}${refs}${dot}${theme.fg("success", "running")}${dot}${theme.fg("dim", `${ageSeconds}s`)}${dot}${theme.fg("text", truncateToWidth(job.prompt, promptWidth, "…"))}`);
	}
	const hidden = jobs.length - shown.length;
	if (hidden > 0) lines.push(`${imageGenBranch(theme, "└")}${theme.fg("muted", `… ${hidden} more`)}`);
	return simpleFrame(lines, width, theme, ` image-gen ${running} `);
}

function createImageGenWidgetFactory(): (_tui: unknown, theme: any) => Component {
	return (_tui, theme) => ({
		invalidate() {},
		render(width: number): string[] {
			return renderJobLines(theme, width);
		},
	});
}

function ensureStatusTimer(): void {
	if (statusTimer) return;
	statusTimer = setInterval(() => {
		if (!activeStatusCtx || activeImageJobs.size === 0) {
			if (statusTimer) clearInterval(statusTimer);
			statusTimer = undefined;
			return;
		}
		updateImageGenStatus(activeStatusCtx);
	}, 1000);
	statusTimer.unref?.();
}

function updateImageGenStatus(ctx: ExtensionCommandContext): void {
	activeStatusCtx = ctx;
	const count = activeImageJobs.size;
	ctx.ui.setStatus(IMAGE_GEN_STATUS_KEY, count > 0 ? `image-gen ${count}` : undefined);
	ctx.ui.setWidget(IMAGE_GEN_STATUS_KEY, count > 0 ? createImageGenWidgetFactory() : undefined, { placement: "aboveEditor" });
	if (count > 0) ensureStatusTimer();
}

function startImageJob(ctx: ExtensionCommandContext, parsed: ParsedImageGenCommand, imageModel: string): ActiveImageJob {
	const job: ActiveImageJob = {
		id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		startedAt: Date.now(),
		prompt: parsed.prompt,
		referenceCount: parsed.imagePaths.length,
		imageModel,
	};
	activeImageJobs.set(job.id, job);
	updateImageGenStatus(ctx);
	return job;
}

function finishImageJob(ctx: ExtensionCommandContext, jobId: string): void {
	activeImageJobs.delete(jobId);
	updateImageGenStatus(ctx);
}

export function parseImageGenCommandArgs(input: string): ParsedImageGenCommand {
	const imagePaths: string[] = [];
	const promptParts: string[] = [];
	for (const token of tokenizeArgs(input.trim())) {
		if (token.startsWith("@") && token.length > 1) imagePaths.push(token.slice(1));
		else promptParts.push(token);
	}
	return { prompt: promptParts.join(" ").trim(), imagePaths };
}

function mimeTypeForPath(path: string): string {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".webp") return "image/webp";
	if (ext === ".png") return "image/png";
	throw new Error(`Unsupported reference image type: ${path}. Use PNG, JPEG, or WebP.`);
}

async function loadReferenceImage(cwd: string, rawPath: string): Promise<ReferenceImage> {
	const path = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
	const buffer = await readFile(path);
	return { path, mimeType: mimeTypeForPath(path), base64: buffer.toString("base64") };
}

function resolveCodexUrl(baseUrl: string | undefined): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function extractAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64").toString("utf8"));
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (!accountId) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from Codex OAuth token");
	}
}

function buildHeaders(model: Model<Api>, apiKey: string, extraHeaders?: Record<string, string>): Headers {
	const headers = new Headers(model.headers);
	for (const [key, value] of Object.entries(extraHeaders ?? {})) headers.set(key, value);
	headers.set("Authorization", `Bearer ${apiKey}`);
	headers.set("chatgpt-account-id", extractAccountId(apiKey));
	headers.set("originator", "pi");
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	return headers;
}

export function buildBackgroundImageRequest(options: {
	prompt: string;
	referenceImages: ReferenceImage[];
	responsesModel: string;
	imageModel: string;
}): Record<string, unknown> {
	const content: Array<Record<string, unknown>> = [
		{ type: "input_text", text: options.referenceImages.length > 0 ? `Edit the provided image(s): ${options.prompt}` : options.prompt },
		...options.referenceImages.map((image) => ({
			type: "input_image",
			detail: "auto",
			image_url: `data:${image.mimeType};base64,${image.base64}`,
		})),
	];
	return {
		model: options.responsesModel,
		store: false,
		stream: true,
		instructions: BACKGROUND_IMAGE_INSTRUCTIONS,
		input: [{ role: "user", content }],
		tools: [{
			type: "image_generation",
			model: options.imageModel,
			output_format: "png",
			action: options.referenceImages.length > 0 ? "edit" : "generate",
		}],
		tool_choice: { type: "image_generation" },
	};
}

async function* parseSseEvents(response: Response): AsyncIterable<Record<string, unknown>> {
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let boundary: number;
		while ((boundary = buffer.indexOf("\n\n")) >= 0) {
			const raw = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			for (const line of raw.split(/\r?\n/)) {
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (!data || data === "[DONE]") continue;
				yield JSON.parse(data) as Record<string, unknown>;
			}
		}
	}
}

function collectImageResult(results: CodexImageResult[], item: unknown, fallbackImageModel: string): void {
	if (!item || typeof item !== "object") return;
	const candidate = item as Record<string, unknown>;
	if (candidate.type !== "image_generation_call" || typeof candidate.result !== "string") return;
	const id = typeof candidate.id === "string" ? candidate.id : `ig_${results.length}`;
	if (results.some((result) => result.id === id)) return;
	results.push({
		id,
		result: candidate.result,
		outputFormat: typeof candidate.output_format === "string" ? candidate.output_format : "png",
		revisedPrompt: typeof candidate.revised_prompt === "string" ? candidate.revised_prompt : undefined,
		imageModel: typeof candidate.model === "string" ? candidate.model : fallbackImageModel,
	});
}

async function runBackgroundImageGeneration(pi: ExtensionAPI, ctx: ExtensionCommandContext, parsed: ParsedImageGenCommand): Promise<void> {
	const settings = loadSettings(ctx.cwd);
	const model = ctx.modelRegistry.find("openai-codex", "gpt-5.5") ?? (ctx.model?.provider === "openai-codex" ? ctx.model : undefined);
	if (!model) throw new Error("No openai-codex/gpt-5.5 model is available.");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error("No Codex OAuth token is configured. Run /login openai-codex.");
	const referenceImages = await Promise.all(parsed.imagePaths.map((path) => loadReferenceImage(ctx.cwd, path)));
	const body = buildBackgroundImageRequest({
		prompt: parsed.prompt,
		referenceImages,
		responsesModel: model.id,
		imageModel: settings.imageModel,
	});
	const response = await fetch(resolveCodexUrl(model.baseUrl), {
		method: "POST",
		headers: buildHeaders(model, auth.apiKey, auth.headers),
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`Codex image generation failed: ${response.status} ${await response.text()}`);
	const results: CodexImageResult[] = [];
	let responseId: string | undefined;
	for await (const event of parseSseEvents(response)) {
		if (event.type === "response.created" && event.response && typeof event.response === "object") {
			const id = (event.response as { id?: unknown }).id;
			if (typeof id === "string") responseId = id;
		}
		if (event.type === "response.output_item.done") collectImageResult(results, event.item, settings.imageModel);
		if ((event.type === "response.completed" || event.type === "response.done") && event.response && typeof event.response === "object") {
			const responseOutput = (event.response as { output?: unknown }).output;
			if (Array.isArray(responseOutput)) for (const item of responseOutput) collectImageResult(results, item, settings.imageModel);
		}
	}
	if (results.length === 0) throw new Error("Codex image generation completed without an image_generation_call result.");
	const savedImages = [];
	for (const result of results) {
		savedImages.push(await saveOpenAICodexGeneratedImage(ctx.cwd, {
			responseId,
			callId: result.id,
			result: result.result,
			outputFormat: result.outputFormat,
			imageModel: result.imageModel,
			revisedPrompt: result.revisedPrompt ?? parsed.prompt,
		}));
	}
	pi.sendMessage({
		customType: IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
		content: [{ type: "text", text: buildGeneratedImageDisplayText(savedImages[0], { expanded: false }) }],
		display: true,
		details: { savedImages },
	}, { triggerTurn: false });
}

export function registerBackgroundImageGenerationCommand(pi: ExtensionAPI): void {
	pi.registerCommand("image-gen", {
		description: "Generate or edit an image in the background with Codex OAuth. Usage: /image-gen prompt text [@reference.png]",
		handler: async (args, ctx) => {
			const parsed = parseImageGenCommandArgs(args);
			if (!parsed.prompt) {
				ctx.ui.notify("Usage: /image-gen prompt text [@reference.png]", "warning");
				return;
			}
			const settings = loadSettings(ctx.cwd);
			const job = startImageJob(ctx, parsed, settings.imageModel);
			ctx.ui.notify(`Queued image generation with ${settings.imageModel}${parsed.imagePaths.length ? ` (${parsed.imagePaths.length} reference image${parsed.imagePaths.length === 1 ? "" : "s"})` : ""}.`, "info");
			void runBackgroundImageGeneration(pi, ctx, parsed)
				.catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					pi.sendMessage({ customType: "codex-image-generation-error", content: `Image generation failed: ${message}`, display: true }, { triggerTurn: false });
				})
				.finally(() => finishImageJob(ctx, job.id));
		},
	});
}
