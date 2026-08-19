import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";

import type { TaskSpecContract } from "../spec/types.ts";
import type { ToolResult } from "../types.ts";
import type { AgentTool } from "./tool.ts";

type ValidationCommand = TaskSpecContract["acceptance"]["commands"][number];

export type ValidationCommandOutput = {
    readonly commandIndex: number;
    readonly executable: string;
    readonly args: readonly string[];
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    readonly outputLimitExceeded: boolean;
    readonly passed: boolean;
};

export type ValidationToolOptions = {
    readonly workspaceRoot: string;
    readonly commands: readonly ValidationCommand[];
    readonly commandAllowlist: readonly string[];
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
};

function commandIndexFrom(input: unknown): number | undefined {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return undefined;
    }
    const commandIndex = Reflect.get(input, "commandIndex");
    return Number.isInteger(commandIndex) ? (commandIndex as number) : undefined;
}

function commandKey(executable: string): string {
    return process.platform === "win32" ? executable.toLowerCase() : executable;
}

export class RunValidationTool implements AgentTool {
    readonly name = "run_validation";
    readonly permission = { action: "command-execute", risk: "execute" } as const;
    private readonly options: ValidationToolOptions;
    private readonly allowedCommands: ReadonlySet<string>;

    constructor(options: ValidationToolOptions) {
        this.options = {
            ...options,
            commands: options.commands.map((command) => ({
                executable: command.executable,
                args: [...command.args],
            })),
            commandAllowlist: [...options.commandAllowlist],
        };
        this.allowedCommands = new Set(options.commandAllowlist.map(commandKey));
    }

    async execute(input: unknown): Promise<ToolResult> {
        const commandIndex = commandIndexFrom(input);
        if (
            commandIndex === undefined ||
            commandIndex < 0 ||
            commandIndex >= this.options.commands.length
        ) {
            return {
                ok: false,
                error: {
                    code: "tool_input_invalid",
                    message: "run_validation input must contain a valid commandIndex",
                },
            };
        }

        const command = this.options.commands[commandIndex];
        if (!this.allowedCommands.has(commandKey(command.executable))) {
            return {
                ok: false,
                error: {
                    code: "command_not_allowed",
                    message: `Validation executable is not in the local allowlist: ${command.executable}`,
                },
            };
        }

        let workspaceRoot: string;
        try {
            workspaceRoot = await realpath(this.options.workspaceRoot);
            if (!(await stat(workspaceRoot)).isDirectory()) {
                throw new Error("Workspace root is not a directory");
            }
        } catch (error) {
            return {
                ok: false,
                error: {
                    code: "workspace_root_invalid",
                    message:
                        error instanceof Error
                            ? error.message
                            : "Workspace root is unavailable",
                },
            };
        }

        return this.runCommand(commandIndex, command, workspaceRoot);
    }

    private async runCommand(
        commandIndex: number,
        command: ValidationCommand,
        workspaceRoot: string,
    ): Promise<ToolResult> {
        return new Promise((resolve) => {
            let child: ReturnType<typeof spawn>;
            try {
                child = spawn(command.executable, [...command.args], {
                    cwd: workspaceRoot,
                    shell: false,
                    windowsHide: true,
                    stdio: ["ignore", "pipe", "pipe"],
                });
            } catch (error) {
                resolve({
                    ok: false,
                    error: {
                        code: "validation_spawn_failed",
                        message:
                            error instanceof Error
                                ? error.message
                                : "Validation process could not be started",
                    },
                });
                return;
            }
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let capturedBytes = 0;
            let timedOut = false;
            let outputLimitExceeded = false;
            let settled = false;

            const capture = (chunk: Buffer, destination: Buffer[]): void => {
                const remaining = this.options.maxOutputBytes - capturedBytes;
                if (remaining > 0) {
                    const captured = chunk.subarray(0, remaining);
                    destination.push(captured);
                    capturedBytes += captured.byteLength;
                }
                if (chunk.byteLength > remaining) {
                    outputLimitExceeded = true;
                    child.kill();
                }
            };

            child.stdout?.on("data", (chunk: Buffer) => capture(chunk, stdout));
            child.stderr?.on("data", (chunk: Buffer) => capture(chunk, stderr));

            const timer = setTimeout(() => {
                timedOut = true;
                child.kill();
            }, this.options.timeoutMs);

            child.once("error", (error) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                resolve({
                    ok: false,
                    error: {
                        code: "validation_spawn_failed",
                        message: error.message,
                    },
                });
            });

            child.once("close", (exitCode, signal) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                const output: ValidationCommandOutput = {
                    commandIndex,
                    executable: command.executable,
                    args: [...command.args],
                    exitCode,
                    signal,
                    stdout: Buffer.concat(stdout).toString("utf8"),
                    stderr: Buffer.concat(stderr).toString("utf8"),
                    timedOut,
                    outputLimitExceeded,
                    passed:
                        exitCode === 0 && !timedOut && !outputLimitExceeded,
                };
                resolve({ ok: true, output });
            });
        });
    }
}
