import type {
	FlightdeckStateLike,
	TrackedEntry,
	TrackedEntryLaunch,
} from "./types.ts";

export const ENTRY_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface ReadTrackedEntriesOptions {
	warn?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function entryRecordMap(value: unknown, warn?: (message: string) => void): Record<string, Record<string, unknown>> {
	if (!isRecord(value)) return {};
	const out: Record<string, Record<string, unknown>> = {};
	const invalid: string[] = [];
	for (const [key, raw] of Object.entries(value)) {
		if (isRecord(raw)) out[key] = raw;
		else invalid.push(key);
	}
	if (invalid.length > 0) warn?.(invalidEntriesWarning(invalid));
	return out;
}

function invalidEntriesWarning(ids: string[]): string {
	return `Warning: invalid .entries value(s) for ${ids.map((id) => JSON.stringify(id)).join(", ")}; skipping.`;
}

function invalidEntryIdWarning(entryKey: string, rawId: unknown): string {
	return `Warning: invalid .entries[${JSON.stringify(entryKey)}].id ${JSON.stringify(rawId)}; using entry key.`;
}

export function validateEntryId(value: unknown, label = "entry id"): string {
	if (typeof value !== "string") throw new Error(`invalid ${label}: must be a string`);
	const trimmed = value.trim();
	if (!trimmed || !ENTRY_ID_PATTERN.test(trimmed)) throw new Error(`invalid ${label}: must be non-empty and match ${ENTRY_ID_PATTERN.source}`);
	return trimmed;
}

function normalizeEntry(id: string, raw: Record<string, unknown>, opts: { strict?: boolean; warn?: (message: string) => void } = {}): TrackedEntry {
	const keyId = opts.strict ? validateEntryId(id, "entry id") : (validateEntryIdOrNull(id) ?? id);
	const rawId = typeof raw.id === "string" ? validateEntryIdOrNull(raw.id) : null;
	if (raw.id !== undefined && rawId === null) opts.warn?.(invalidEntryIdWarning(id, raw.id));
	const entryId = rawId ?? keyId;
	const kind = typeof raw.kind === "string" && raw.kind.trim() ? raw.kind : "adhoc";
	return { ...raw, id: entryId, kind } as TrackedEntry;
}

function validateEntryIdOrNull(value: unknown): string | null {
	try {
		return validateEntryId(value);
	} catch {
		return null;
	}
}

export function readTrackedEntries(state: FlightdeckStateLike | undefined | null, options: ReadTrackedEntriesOptions = {}): Record<string, TrackedEntry> {
	if (!state || typeof state !== "object") return {};
	const out: Record<string, TrackedEntry> = {};
	const entries = entryRecordMap(state.entries, options.warn);
	for (const [id, raw] of Object.entries(entries)) out[id] = normalizeEntry(id, raw, { warn: options.warn });
	return out;
}

export function writeTrackedEntry<T extends FlightdeckStateLike>(state: T, id: string, entry: TrackedEntry): T {
	const target = state as FlightdeckStateLike;
	const validId = validateEntryId(id, "entry id");
	const entryId = validateEntryId(entry.id, "entry.id");
	if (entryId !== validId) throw new Error(`invalid entry.id: must match entry id ${validId}`);
	validateDomainIssueId(entry);
	if (!isRecord(target.entries)) target.entries = {};
	const entries = target.entries as Record<string, TrackedEntry>;
	const normalized = normalizeEntry(validId, entry as unknown as Record<string, unknown>, { strict: true });
	entries[validId] = normalized;
	return state;
}

export function entryIdForIssue(issueId: string): string | null {
	return validateEntryIdOrNull(issueId);
}

export function issueIdForEntry(entry: Pick<TrackedEntry, "id" | "kind" | "domain">): string | undefined {
	const issue = entry.domain && typeof entry.domain === "object" && !Array.isArray(entry.domain) ? entry.domain.issue : undefined;
	if (issue && typeof issue === "object" && !Array.isArray(issue) && typeof issue.id === "string" && issue.id.trim()) return validateEntryId(issue.id, "domain.issue.id");
	return entry.kind === "issue" && entry.id.trim() ? entry.id : undefined;
}

export function validateDomainIssueId(entry: Pick<TrackedEntry, "domain">): string | undefined {
	const issue = entry.domain && typeof entry.domain === "object" && !Array.isArray(entry.domain) ? entry.domain.issue : undefined;
	if (!issue || typeof issue !== "object" || Array.isArray(issue) || !("id" in issue) || issue.id === undefined) return undefined;
	return validateEntryId(issue.id, "domain.issue.id");
}

// Suppress unused-import linter complaint while leaving the type
// re-exported for downstream callers that still import it.
export type { TrackedEntryLaunch };
