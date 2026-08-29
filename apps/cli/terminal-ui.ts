import { createInterface, type Interface } from "node:readline";

import type { CodeTauConfig } from "../../src/config/loader.ts";
import type { ContextManagementConfig } from "../../src/context/types.ts";
import {
    formatValidationCommand,
    parseValidationCommand,
    type ValidationCommand,
} from "../../src/natural-language/command-line.ts";
import type { SessionReport } from "../../src/session/report.ts";
import type { ApprovalResponse } from "../../src/spec/types.ts";
import type { AgentEvent, ToolCall } from "../../src/types.ts";
import { BUILT_IN_PROTECTED_PATHS } from "../../src/natural-language/task-builder.ts";
import { renderTerminalMarkdown } from "./markdown.ts";

type Writer = { write(text: string): unknown };

function terminalSafe(value: string): string {
    return value.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu, "�");
}

export interface NaturalLanguageUI {
    readonly interactive: boolean;
    readTask(): Promise<string | undefined>;
    selectValidationCommands(
        detected: readonly ValidationCommand[],
    ): Promise<readonly ValidationCommand[]>;
    confirmPreflight(options: {
        config: CodeTauConfig;
        commands: readonly ValidationCommand[];
        assumeYes: boolean;
    }): Promise<boolean>;
    requestApproval(call: ToolCall): Promise<ApprovalResponse>;
    renderEvent(event: AgentEvent): void;
    renderReport(report: SessionReport): void;
    writeError(message: string): void;
    close(): void;
}

export interface ConversationUI extends NaturalLanguageUI {
    renderConversationHeader(options: {
        conversationId: string;
        resumed: boolean;
        completedTurns: number;
        contextBudget: ContextManagementConfig;
    }): void;
    readConversationMessage(): Promise<string | undefined>;
    renderAssistantReply(message: string): void;
    renderContextStatus?(options: {
        summarized: boolean;
        omittedTurns: number;
    }): void;
}

export class TerminalUI implements ConversationUI {
    readonly interactive: boolean;
    readonly #output: Writer;
    readonly #error: Writer;
    readonly #readline?: Interface;
    readonly #color: boolean;
    readonly #verbose: boolean;
    readonly #toolNames = new Map<string, string>();
    readonly #queuedLines: string[] = [];
    #lineWaiter?: Readonly<{
        resolve(line: string): void;
        reject(error: Error): void;
    }>;
    #inputClosed = false;

    constructor(options: {
        input: NodeJS.ReadableStream;
        output: NodeJS.WritableStream & Writer;
        error: Writer;
        interactive: boolean;
        color?: boolean;
        verbose?: boolean;
    }) {
        this.interactive = options.interactive;
        this.#output = options.output;
        this.#error = options.error;
        this.#color =
            (options.color ?? options.interactive) && process.env.NO_COLOR === undefined;
        this.#verbose = options.verbose ?? false;
        if (options.interactive) {
            this.#readline = createInterface({
                input: options.input,
                output: options.output,
            });
            this.#readline.on("line", (line) => {
                const waiter = this.#lineWaiter;
                if (waiter === undefined) {
                    this.#queuedLines.push(line);
                    return;
                }
                this.#lineWaiter = undefined;
                waiter.resolve(line);
            });
            this.#readline.on("close", () => {
                this.#inputClosed = true;
                const waiter = this.#lineWaiter;
                if (waiter !== undefined) {
                    this.#lineWaiter = undefined;
                    waiter.reject(new Error("Terminal input was closed"));
                }
            });
        }
    }

    async readTask(): Promise<string | undefined> {
        this.#output.write(
            "Describe the task. Enter :run on its own line to start, or :cancel to exit.\n",
        );
        const lines: string[] = [];
        while (true) {
            const line = await this.question("> ");
            if (line.trim() === ":cancel") {
                return undefined;
            }
            if (line.trim() === ":run") {
                const task = lines.join("\n").trim();
                if (task !== "") {
                    return task;
                }
                this.#output.write("Task cannot be empty.\n");
                continue;
            }
            lines.push(line);
        }
    }

    renderConversationHeader(options: {
        conversationId: string;
        resumed: boolean;
        completedTurns: number;
        contextBudget: ContextManagementConfig;
    }): void {
        this.#output.write(
            [
                "",
                "┌─ CodeTau ─────────────────────────────────────────┐",
                `│ ${options.resumed ? "Resumed" : "New"} conversation: ${terminalSafe(options.conversationId)}`,
                `│ Completed turns: ${options.completedTurns}`,
                `│ Context: ${options.contextBudget.maxContextTokens} tokens (${options.contextBudget.reservedOutputTokens} reserved, ${options.contextBudget.safetyMarginPercent}% margin)`,
                "│ Enter a message, :multi for multiline input, :exit to leave.",
                "└───────────────────────────────────────────────────┘",
                "",
            ].join("\n"),
        );
    }

    async readConversationMessage(): Promise<string | undefined> {
        let first = "";
        while (first.trim() === "") {
            first = await this.question(`${this.paint("You", "36")}> `);
            if (first.trim() === ":exit" || first.trim() === ":quit") {
                return undefined;
            }
        }
        if (first.trim() !== ":multi") {
            return first.trim();
        }
        this.#output.write("Multiline mode; enter :send on its own line to submit.\n");
        const lines: string[] = [];
        while (true) {
            const line = await this.question("... ");
            if (line.trim() === ":exit" || line.trim() === ":quit") {
                return undefined;
            }
            if (line.trim() === ":send" || line.trim() === ":run") {
                const message = lines.join("\n").trim();
                if (message !== "") return message;
                this.#output.write("Message cannot be empty.\n");
                continue;
            }
            lines.push(line);
        }
    }

    renderContextStatus(options: {
        summarized: boolean;
        omittedTurns: number;
    }): void {
        if (!options.summarized && options.omittedTurns === 0) return;
        const summary = options.summarized
            ? "rolling summary active"
            : "summary unavailable";
        this.#output.write(
            `${this.paint("◇", "36")} Context: ${summary}; ${options.omittedTurns} older turn(s) represented or omitted.\n`,
        );
    }

    renderAssistantReply(message: string): void {
        const rendered = renderTerminalMarkdown(terminalSafe(message), {
            color: this.#color,
        });
        this.#output.write(
            `\n${this.paint("CodeTau", "32")}> ${rendered}\n\n`,
        );
    }

    async selectValidationCommands(
        detected: readonly ValidationCommand[],
    ): Promise<readonly ValidationCommand[]> {
        if (detected.length > 0) {
            this.#output.write("Detected validation commands:\n");
            detected.forEach((command, index) =>
                this.#output.write(
                    `  ${index + 1}. ${terminalSafe(formatValidationCommand(command))}\n`,
                ),
            );
            const answer = (
                await this.question(
                    "Select numbers (Enter = all, add c for custom): ",
                )
            ).trim();
            if (answer === "") {
                return detected;
            }
            const parts = answer.split(",").map((value) => value.trim().toLowerCase());
            const addCustom = parts.includes("c");
            const indexes = parts
                .filter((value) => value !== "c")
                .map((value) => Number(value) - 1);
            if (
                indexes.some(
                    (index) =>
                        !Number.isInteger(index) ||
                        index < 0 ||
                        index >= detected.length,
                ) ||
                (indexes.length === 0 && !addCustom)
            ) {
                throw new Error("Invalid validation command selection");
            }
            const selected = [...new Set(indexes)].map((index) => detected[index]);
            return addCustom
                ? [...selected, await this.readCustomValidationCommand()]
                : selected;
        }
        return [await this.readCustomValidationCommand()];
    }

    async confirmPreflight(options: {
        config: CodeTauConfig;
        commands: readonly ValidationCommand[];
        assumeYes: boolean;
    }): Promise<boolean> {
        const protectedPaths = [
            ...BUILT_IN_PROTECTED_PATHS,
            ...options.config.naturalLanguage.additionalProtectedPaths,
        ];
        this.#output.write(`\nWorkspace   ${terminalSafe(options.config.rootDirectory)}\n`);
        this.#output.write(`Model       ${terminalSafe(options.config.model)}\n`);
        this.#output.write("Writable    repository files\n");
        this.#output.write(`Protected   ${terminalSafe(protectedPaths.join(", "))}\n`);
        this.#output.write("Validation\n");
        for (const command of options.commands) {
            this.#output.write(
                `  - ${terminalSafe(formatValidationCommand(command))}\n`,
            );
        }
        const budget = options.config.naturalLanguage;
        this.#output.write(
            `Budget       ${budget.maxModelTurns} model turns, ${budget.maxToolCalls} tool calls, ${budget.maxRetries} retries\n`,
        );
        if (options.assumeYes) {
            return true;
        }
        const answer = (await this.question("\nStart task? [Y/n] ")).trim();
        return answer === "" || answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
    }

    async requestApproval(call: ToolCall): Promise<ApprovalResponse> {
        this.#output.write(
            `${this.paint("◆", "33")} Permission required: ${describeCall(call)}\n`,
        );
        const answer = (
            await this.question(
                "  [1] Allow once  [2] Allow for session  [3] Deny: ",
            )
        ).trim();
        if (answer === "1") return "allow-once";
        if (answer === "2") return "allow-session";
        if (answer === "3") return "deny";
        throw new Error("Invalid approval response");
    }

    renderEvent(event: AgentEvent): void {
        if (event.type === "session_started") {
            this.#output.write(`${this.paint("●", "36")} Session started\n`);
        } else if (event.type === "model_tool_call") {
            this.#toolNames.set(event.toolCall.id, event.toolCall.name);
            if (
                this.#verbose ||
                event.toolCall.name === "apply_patch" ||
                event.toolCall.name === "create_file" ||
                event.toolCall.name === "run_validation"
            ) {
                this.#output.write(
                    `${this.paint(this.#verbose ? "●" : "◆", "36")} ${describeCall(event.toolCall)}\n`,
                );
            }
        } else if (event.type === "tool_result") {
            const toolName = this.#toolNames.get(event.toolCallId);
            this.#toolNames.delete(event.toolCallId);
            const passed = toolResultPassed(event.result);
            const symbol = passed
                ? this.paint("✓", "32")
                : this.paint("✗", "31");
            const message = event.result.ok
                ? describeOutput(event.result.output)
                : `${event.result.error.code}: ${event.result.error.message}`;
            if (this.#verbose || !passed || toolName === "run_validation") {
                this.#output.write(`${symbol} ${terminalSafe(message)}\n`);
            }
        } else if (event.type === "model_text" && event.text.trim() !== "") {
            if (this.#verbose) {
                this.#output.write(
                    `${this.paint("●", "36")} ${terminalSafe(event.text.trim())}\n`,
                );
            }
        } else if (event.type === "context_compiled") {
            if (this.#verbose || event.operations.length > 0) {
                const actions =
                    event.operations.length === 0
                        ? "no compaction"
                        : event.operations
                              .map((operation) => `${operation.kind}=${operation.count}`)
                              .join(", ");
                this.#output.write(
                    `${this.paint("◇", "36")} Context ${event.estimatedInputTokens}/${event.effectiveInputLimit} estimated tokens; ${actions}\n`,
                );
            }
        }
    }

    renderReport(report: SessionReport): void {
        const heading = report.status === "completed" ? "Completed" : report.status;
        this.#output.write(`\n${heading}\n`);
        if (report.message !== undefined) {
            this.#output.write(`Result: ${terminalSafe(report.message)}\n`);
        }
        this.#output.write(
            `Changed files: ${report.changedFiles.length === 0 ? "none" : terminalSafe(report.changedFiles.join(", "))}\n`,
        );
        this.#output.write(
            `Validation: ${report.passedValidationIndexes.length}/${report.validationCount} passed\n`,
        );
        if (this.#verbose) {
            this.#output.write(
                `Usage: ${report.modelTurns} model turns, ${report.toolCalls} tool calls, ${report.inputTokens}/${report.outputTokens} input/output tokens\n`,
            );
        }
        this.#output.write(`Session: ${terminalSafe(report.sessionId)}\n`);
    }

    writeError(message: string): void {
        this.#error.write(`${message}\n`);
    }

    close(): void {
        this.#readline?.close();
    }

    private async readCustomValidationCommand(): Promise<ValidationCommand> {
        const source = await this.question("Validation command: ");
        return parseValidationCommand(source);
    }

    private question(prompt: string): Promise<string> {
        if (this.#readline === undefined) {
            throw new Error("Interactive terminal input is unavailable");
        }
        this.#output.write(prompt);
        const queued = this.#queuedLines.shift();
        if (queued !== undefined) {
            return Promise.resolve(queued);
        }
        if (this.#inputClosed) {
            return Promise.reject(new Error("Terminal input was closed"));
        }
        if (this.#lineWaiter !== undefined) {
            return Promise.reject(new Error("Terminal input is already pending"));
        }
        return new Promise<string>((resolve, reject) => {
            this.#lineWaiter = { resolve, reject };
        });
    }

    private paint(text: string, code: string): string {
        return this.#color ? `\u001B[${code}m${text}\u001B[0m` : text;
    }
}

function describeCall(call: ToolCall): string {
    const input =
        typeof call.input === "object" && call.input !== null
            ? (call.input as Record<string, unknown>)
            : undefined;
    const path = input?.path;
    if (call.name === "read_file" && typeof path === "string") return `Reading ${terminalSafe(path)}`;
    if (call.name === "apply_patch" && typeof path === "string") return `Modify ${terminalSafe(path)}`;
    if (call.name === "create_file" && typeof path === "string") return `Create ${terminalSafe(path)}`;
    if (call.name === "list_files") return "Inspecting project files";
    if (call.name === "run_validation") {
        return `Run validation #${String(input?.commandIndex ?? "?")}`;
    }
    return `Run ${call.name}`;
}

function describeOutput(output: unknown): string {
    if (typeof output !== "object" || output === null) return "Tool completed";
    const record = output as Record<string, unknown>;
    if (typeof record.path === "string") return `Updated ${record.path}`;
    if (typeof record.passed === "boolean") {
        return record.passed ? "Validation passed" : "Validation failed";
    }
    return "Tool completed";
}

function toolResultPassed(result: Extract<AgentEvent, { type: "tool_result" }>["result"]): boolean {
    if (!result.ok) return false;
    if (typeof result.output !== "object" || result.output === null) return true;
    return Reflect.get(result.output, "passed") !== false;
}
