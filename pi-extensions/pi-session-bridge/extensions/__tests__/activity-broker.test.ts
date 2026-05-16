import { beforeEach, describe, expect, test } from "bun:test";

import {
	getPiActivityBroker,
	installPiActivityBridgePublisher,
	publishPiActivity,
	type PiActivityEvent,
} from "../activity-broker.js";

const BROKER_SYMBOL = Symbol.for("vstack.pi.activity");

function event(overrides: Partial<PiActivityEvent> = {}): PiActivityEvent {
	return {
		importance: "normal",
		severity: "info",
		source: "pi-session",
		summary: "activity event",
		type: "pi.session.event",
		...overrides,
	};
}

beforeEach(() => {
	delete (globalThis as unknown as Record<PropertyKey, unknown>)[BROKER_SYMBOL];
});

describe("Pi activity broker", () => {
	test("publish and subscribe round-trip", () => {
		const broker = getPiActivityBroker();
		const seen: PiActivityEvent[] = [];
		const unsubscribe = broker.subscribe((item) => seen.push(item));
		broker.publish(event({ refs: { agent: "rust" }, type: "agent.spawned" }));
		unsubscribe();
		broker.publish(event({ type: "agent.ignored" }));

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ refs: { agent: "rust" }, source: "pi-session", type: "agent.spawned" });
		expect(typeof seen[0]?.ts).toBe("string");
	});

	test("ring buffer caps at 100 events", () => {
		const broker = getPiActivityBroker();
		for (let index = 0; index < 105; index += 1) {
			broker.publish(event({ summary: `event ${index}`, type: `pi.event.${index}` }));
		}

		const recent = broker.recent(200);
		expect(recent).toHaveLength(100);
		expect(recent[0]?.type).toBe("pi.event.104");
		expect(recent.at(-1)?.type).toBe("pi.event.5");
	});

	test("recent returns newest first with requested limit", () => {
		const broker = getPiActivityBroker();
		broker.publish(event({ type: "pi.event.1" }));
		broker.publish(event({ type: "pi.event.2" }));
		broker.publish(event({ type: "pi.event.3" }));

		expect(broker.recent(2).map((item) => item.type)).toEqual(["pi.event.3", "pi.event.2"]);
	});

	test("bad listener does not break other listeners or bridge publisher", () => {
		const broker = getPiActivityBroker();
		const seen: string[] = [];
		const streamed: PiActivityEvent[] = [];
		broker.subscribe(() => { throw new Error("boom"); });
		broker.subscribe((item) => seen.push(item.type));
		installPiActivityBridgePublisher("test", (item) => streamed.push(item));

		publishPiActivity(event({ type: "pi.event.good" }));

		expect(seen).toEqual(["pi.event.good"]);
		expect(streamed.map((item) => item.type)).toEqual(["pi.event.good"]);
	});
});
