import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadCodeTauConfig, type CodeTauConfig } from "../../src/config/loader.ts";
import type { EventStore } from "../../src/persistence/event-store.ts";
import { SQLiteEventStore } from "../../src/persistence/sqlite-event-store.ts";
import { SessionRunner, type SessionRunnerLike } from "../../src/session/runner.ts";
import { parseCliArgs } from "./args.ts";
import { runNaturalLanguageCommand } from "./natural-language.ts";
import { ObservedEventStore } from "./observed-event-store.ts";
import { runSessionCommand } from "./session.ts";
import { runStatusCommand } from "./status.ts";
import { TerminalUI, type NaturalLanguageUI } from "./terminal-ui.ts";

type CliWriter = {
    write(text: string): unknown;
};

export type RunCliOptions = Readonly<{
    argv: readonly string[];
    configPath: string;
    stdout: CliWriter;
    stderr: CliWriter;
    stdin?: NodeJS.ReadableStream;
    interactive?: boolean;
    loadConfig?: (path: string) => Promise<CodeTauConfig>;
    createEventStore?: (databasePath: string) => EventStore;
    createSessionRunner?: (
        config: CodeTauConfig,
        eventStore: EventStore,
    ) => SessionRunnerLike;
    createNaturalLanguageUI?: () => NaturalLanguageUI;
}>;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown CLI error";
}

export async function runCli(options: RunCliOptions): Promise<number> {
    let eventStore: EventStore | undefined;
    let naturalLanguageUI: NaturalLanguageUI | undefined;

    try {
        const command = parseCliArgs(options.argv);
        const config = await (options.loadConfig ?? loadCodeTauConfig)(
            options.configPath,
        );
        const baseEventStore = options.createEventStore?.(config.databasePath) ??
            new SQLiteEventStore(config.databasePath);
        eventStore = baseEventStore;
        if (command.kind === "ask") {
            naturalLanguageUI =
                options.createNaturalLanguageUI?.() ??
                new TerminalUI({
                    input: options.stdin ?? process.stdin,
                    output: options.stdout as NodeJS.WritableStream & CliWriter,
                    error: options.stderr,
                    interactive: options.interactive ?? false,
                });
            eventStore = new ObservedEventStore(
                baseEventStore,
                (event) => naturalLanguageUI?.renderEvent(event),
            );
        }

        const result =
            command.kind === "status"
                ? await runStatusCommand(command, eventStore)
                : command.kind === "ask"
                  ? await runNaturalLanguageCommand({
                        command,
                        config,
                        eventStore,
                        runner:
                            options.createSessionRunner?.(config, eventStore) ??
                            new SessionRunner({ config, eventStore }),
                        ui: naturalLanguageUI as NaturalLanguageUI,
                    })
                : await runSessionCommand(
                      command,
                      options.createSessionRunner?.(config, eventStore) ??
                          new SessionRunner({ config, eventStore }),
                  );
        if (typeof result === "number") {
            return result;
        }
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
        naturalLanguageUI?.close();
        await eventStore?.close();
    }
}

export async function main(): Promise<void> {
    process.exitCode = await runCli({
        argv: process.argv.slice(2),
        configPath: resolve(process.cwd(), "codetau.config.json"),
        stdout: process.stdout,
        stderr: process.stderr,
        stdin: process.stdin,
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    });
}

const entryPath = process.argv[1];
if (
    entryPath !== undefined &&
    import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
    await main();
}
