import type { FlightdeckActivityEventV1 } from "./types.ts";

export function formatActivityLine(event: FlightdeckActivityEventV1): string {
	const entry = event.entry_id ? ` entry=${event.entry_id}` : "";
	const pane = event.pane_id ? ` pane=${event.pane_id}` : "";
	return `${event.ts} [${event.severity}/${event.importance}] ${event.type}${entry}${pane} — ${event.summary}`;
}

export function formatActivityJsonl(events: FlightdeckActivityEventV1[]): string {
	return events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : "");
}

export function formatActivityMarkdown(events: FlightdeckActivityEventV1[]): string {
	const lines = ["# Flightdeck activity export", ""];
	if (events.length === 0) {
		lines.push("No activity events.", "");
		return lines.join("\n");
	}
	for (const event of events) {
		const labels = [`${event.severity}/${event.importance}`, event.source];
		if (event.entry_id) labels.push(`entry ${event.entry_id}`);
		if (event.pane_id) labels.push(`pane ${event.pane_id}`);
		lines.push(`- ${event.ts} — \`${event.type}\` (${labels.join(", ")}) — ${event.summary}`);
		if (event.body) lines.push(`  ${event.body.replace(/\n/g, "\n  ")}`);
		if (event.links?.length) {
			for (const link of event.links) {
				const target = link.url ?? link.path ?? "";
				lines.push(`  - ${link.label}${target ? `: ${target}` : ""}`);
			}
		}
	}
	lines.push("");
	return lines.join("\n");
}
