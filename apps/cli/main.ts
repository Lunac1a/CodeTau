import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { EventStore } from "../../src/persistence/event-store.ts";
import { SQLiteEventStore } from "../../src/persistence/sqlite-event-store.ts";
import { parseCliArgs } from "./args.ts";
import { runStatusCommand } from "./status.ts";

type CliWriter = {
    write(text: string): unknown;
};

export type RunCliOptions = Readonly<{
    argv: readonly string[];
    databasePath: string;
    stdout: CliWriter;
    stderr: CliWriter;
    createEventStore?: (databasePath: string) => EventStore;
}>;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown CLI error";
}

export async function runCli(options: RunCliOptions): Promise<number> {
    let eventStore: EventStore | undefined;

    try {
        const command = parseCliArgs(options.argv);
        eventStore = options.createEventStore?.(options.databasePath) ??
            new SQLiteEventStore(options.databasePath);

        const result = await runStatusCommand(command, eventStore);
        if (result.stdout !== "") {
            options.stdout.write(result.stdout);
        }
        if (result.stderr !== "") {
            options.stderr.write(result.stderr);
        }
        return result.exitCode;
    } catch (error) {
        options.stderr.write(`${errorMessage(error)}\n`);
        return 1;
    } finally {
        await eventStore?.close();
    }
}

export async function main(): Promise<void> {
    process.exitCode = await runCli({
        argv: process.argv.slice(2),
        databasePath: resolve(process.cwd(), ".codetau", "codetau.db"),
        stdout: process.stdout,
        stderr: process.stderr,
    });
}

const entryPath = process.argv[1];
if (
    entryPath !== undefined &&
    import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
    await main();
}
