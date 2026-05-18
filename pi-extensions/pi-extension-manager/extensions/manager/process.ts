import crossSpawn from "cross-spawn";
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";

export type CommandResult = SpawnSyncReturns<string>;

export function runCommand(command: string, args: string[], options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {}): CommandResult {
	return crossSpawn.sync(command, args, { ...options, encoding: "utf8" });
}
