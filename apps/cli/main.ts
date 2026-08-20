import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadCodeTauConfig, type CodeTauConfig } from "../../src/config/loader.ts";
import type { EventStore } from "../../src/persistence/event-store.ts";
import { SQLiteEventStore } from "../../src/persistence/sqlite-event-store.ts";
import { SessionRunner, type SessionRunnerLike } from "../../src/session/runner.ts";
import { parseCliArgs } from "./args.ts";
import { runSessionCommand } from "./session.ts";
import { runStatusCommand } from "./status.ts";

type CliWriter = {
    write(text: string): unknown;
};

export type RunCliOptions = Readonly<{
    argv: readonly string[];
    configPath: string;
    stdout: CliWriter;
    stderr: CliWriter;
    loadConfig?: (path: string) => Promise<CodeTauConfig>;
    createEventStore?: (databasePath: string) => EventStore;
    createSessionRunner?: (
        config: CodeTauConfig,
        eventStore: EventStore,
    ) => SessionRunnerLike;
}>;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown CLI error";
}

export async function runCli(options: RunCliOptions): Promise<number> {
    let eventStore: EventStore | undefined;

    try {
        const command = parseCliArgs(options.argv);
        const config = await (options.loadConfig ?? loadCodeTauConfig)(
            options.configPath,
        );
        eventStore = options.createEventStore?.(config.databasePath) ??
            new SQLiteEventStore(config.databasePath);

        const result =
            command.kind === "status"
                ? await runStatusCommand(command, eventStore)
                : await runSessionCommand(
                      command,
                      options.createSessionRunner?.(config, eventStore) ??
                          new SessionRunner({ config, eventStore }),
                  );
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
        configPath: resolve(process.cwd(), "codetau.config.json"),
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
