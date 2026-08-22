import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
    encodeHostMessage,
    parseBridgeLine,
    TAU_MAX_LINE_BYTES,
    TauProtocolError,
    type BridgeMessage,
    type HostMessage,
    type TauAssistantMessage,
} from "./protocol.ts";

export class TauBridgeClientError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "TauBridgeClientError";
        this.code = code;
    }
}

export class TauBridgeRemoteError extends TauBridgeClientError {
    readonly fatal: boolean;
    readonly details: Readonly<Record<string, unknown>> | null;

    constructor(message: Extract<BridgeMessage, { type: "error" }>) {
        super(message.payload.code, message.payload.message);
        this.name = "TauBridgeRemoteError";
        this.fatal = message.payload.fatal;
        this.details = message.payload.details;
    }
}

export interface TauBridgeTransport {
    send(message: HostMessage): Promise<void>;
    receive(): Promise<BridgeMessage>;
    waitForExit(): Promise<number>;
    terminate(): Promise<number>;
    diagnostics(): string;
}

export type TauBridgeProcessOptions = Readonly<{
    command: string;
    args: readonly string[];
    cwd: string;
    timeoutMs?: number;
    maxDiagnosticBytes?: number;
    onDiagnostic?: (text: string) => void;
}>;

type PendingReceive = {
    resolve(message: BridgeMessage): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
};

export class ProcessTauBridgeTransport implements TauBridgeTransport {
    readonly #child: ChildProcessWithoutNullStreams;
    readonly #timeoutMs: number;
    readonly #maxDiagnosticBytes: number;
    readonly #onDiagnostic?: (text: string) => void;
    readonly #messages: BridgeMessage[] = [];
    readonly #exit: Promise<number>;
    #stdoutBuffer = "";
    #diagnostics = "";
    #pending?: PendingReceive;
    #failure?: Error;
    #exited = false;

    constructor(options: TauBridgeProcessOptions) {
        this.#timeoutMs = options.timeoutMs ?? 10_000;
        this.#maxDiagnosticBytes = options.maxDiagnosticBytes ?? 100_000;
        this.#onDiagnostic = options.onDiagnostic;
        if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
            throw new TauBridgeClientError(
                "invalid_configuration",
                "Tau bridge timeout must be a positive integer",
            );
        }
        this.#child = spawn(options.command, [...options.args], {
            cwd: options.cwd,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        this.#child.stdout.setEncoding("utf8");
        this.#child.stderr.setEncoding("utf8");
        this.#child.stdout.on("data", (chunk: string) => this.#acceptStdout(chunk));
        this.#child.stderr.on("data", (chunk: string) => this.#acceptDiagnostic(chunk));
        this.#child.on("error", (error) => {
            this.#fail(
                new TauBridgeClientError(
                    "process_start_failed",
                    `Unable to start tau bridge: ${error.message}`,
                    { cause: error },
                ),
            );
        });
        this.#exit = new Promise((resolve) => {
            this.#child.on("close", (code, signal) => {
                this.#exited = true;
                const exitCode = code ?? 1;
                const exitError = new TauBridgeClientError(
                    "process_exited",
                    `Tau bridge exited (code ${exitCode}, signal ${signal ?? "none"})`,
                );
                if (this.#pending !== undefined) {
                    this.#fail(exitError);
                } else if (this.#failure === undefined) {
                    this.#failure = exitError;
                }
                resolve(exitCode);
            });
        });
    }

    #acceptStdout(chunk: string): void {
        this.#stdoutBuffer += chunk;
        if (Buffer.byteLength(this.#stdoutBuffer, "utf8") > TAU_MAX_LINE_BYTES) {
            this.#fail(
                new TauBridgeClientError(
                    "message_too_large",
                    "Tau bridge stdout line exceeds 1 MiB",
                ),
            );
            this.#child.kill();
            return;
        }
        let newline = this.#stdoutBuffer.indexOf("\n");
        while (newline >= 0) {
            const rawLine = this.#stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
            this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
            if (rawLine.length > 0) {
                try {
                    this.#deliver(parseBridgeLine(rawLine));
                } catch (error) {
                    this.#fail(
                        error instanceof TauProtocolError
                            ? new TauBridgeClientError(error.code, error.message, {
                                  cause: error,
                              })
                            : error instanceof Error
                              ? error
                            : new TauBridgeClientError(
                                  "invalid_bridge_output",
                                  "Tau bridge emitted an invalid message",
                              ),
                    );
                    this.#child.kill();
                    return;
                }
            }
            newline = this.#stdoutBuffer.indexOf("\n");
        }
    }

    #acceptDiagnostic(chunk: string): void {
        this.#onDiagnostic?.(chunk);
        this.#diagnostics += chunk;
        while (Buffer.byteLength(this.#diagnostics, "utf8") > this.#maxDiagnosticBytes) {
            this.#diagnostics = this.#diagnostics.slice(
                Math.max(1, Math.floor(this.#diagnostics.length / 10)),
            );
        }
    }

    #deliver(message: BridgeMessage): void {
        if (this.#pending === undefined) {
            this.#messages.push(message);
            return;
        }
        const pending = this.#pending;
        this.#pending = undefined;
        clearTimeout(pending.timer);
        pending.resolve(message);
    }

    #fail(error: Error): void {
        this.#failure = error;
        if (this.#pending !== undefined) {
            const pending = this.#pending;
            this.#pending = undefined;
            clearTimeout(pending.timer);
            pending.reject(error);
        }
    }

    async send(message: HostMessage): Promise<void> {
        if (this.#failure !== undefined) {
            throw this.#failure;
        }
        const line = `${encodeHostMessage(message)}\n`;
        await new Promise<void>((resolve, reject) => {
            this.#child.stdin.write(line, "utf8", (error) => {
                if (error === null || error === undefined) {
                    resolve();
                } else {
                    reject(
                        new TauBridgeClientError(
                            "process_write_failed",
                            `Unable to write to tau bridge: ${error.message}`,
                            { cause: error },
                        ),
                    );
                }
            });
        });
    }

    async receive(): Promise<BridgeMessage> {
        if (this.#messages.length > 0) {
            return this.#messages.shift() as BridgeMessage;
        }
        if (this.#failure !== undefined) {
            throw this.#failure;
        }
        if (this.#pending !== undefined) {
            throw new TauBridgeClientError(
                "concurrent_receive",
                "Only one tau bridge receive may be pending",
            );
        }
        return await new Promise<BridgeMessage>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#fail(
                    new TauBridgeClientError(
                        "response_timeout",
                        `Tau bridge did not respond within ${this.#timeoutMs}ms`,
                    ),
                );
                this.#child.kill();
            }, this.#timeoutMs);
            this.#pending = { resolve, reject, timer };
        });
    }

    waitForExit(): Promise<number> {
        return this.#exit;
    }

    async terminate(): Promise<number> {
        if (!this.#exited) {
            this.#child.kill();
        }
        return await this.#exit;
    }

    diagnostics(): string {
        return this.#diagnostics;
    }
}

type ClientState = "new" | "ready" | "running" | "closed";

export type TauRunStart = Readonly<{
    domain: string;
    taskSplit: string;
    taskId: string | null;
    trial: number;
    seed: number | null;
}>;

export type TauRunEvent = Extract<
    BridgeMessage,
    { type: "agent_turn" | "run_result" }
>;

export class TauBridgeClient {
    readonly #transport: TauBridgeTransport;
    readonly #nextId: () => string;
    #state: ClientState = "new";
    #runId?: string;
    #nextTurn = 1;

    constructor(transport: TauBridgeTransport, nextId: () => string = randomUUID) {
        this.#transport = transport;
        this.#nextId = nextId;
    }

    #expectState(expected: ClientState): void {
        if (this.#state !== expected) {
            throw new TauBridgeClientError(
                "invalid_state",
                `Expected tau client state ${expected}, received ${this.#state}`,
            );
        }
    }

    async #receive(
        expectedTypes: readonly BridgeMessage["type"][],
        expectedIds: readonly string[],
        errorIds: readonly string[] = expectedIds,
    ): Promise<BridgeMessage> {
        const message = await this.#transport.receive();
        if (message.type === "error") {
            if (!errorIds.includes(message.id)) {
                throw new TauBridgeClientError(
                    "unexpected_response",
                    `Unexpected tau bridge error id ${message.id}`,
                );
            }
            if (message.payload.fatal) {
                this.#state = "closed";
            }
            throw new TauBridgeRemoteError(message);
        }
        if (!expectedTypes.includes(message.type) || !expectedIds.includes(message.id)) {
            throw new TauBridgeClientError(
                "unexpected_response",
                `Unexpected tau bridge response ${message.type} with id ${message.id}`,
            );
        }
        return message;
    }

    async handshake(clientName = "codetau", clientVersion = "0.1.0"): Promise<
        Extract<BridgeMessage, { type: "handshake_result" }>
    > {
        this.#expectState("new");
        const id = this.#nextId();
        await this.#transport.send({
            version: 1,
            id,
            type: "handshake",
            payload: {
                client: { name: clientName, version: clientVersion },
                protocolVersion: 1,
            },
        });
        const response = await this.#receive(["handshake_result"], [id]);
        this.#state = "ready";
        return response as Extract<BridgeMessage, { type: "handshake_result" }>;
    }

    async startRun(options: TauRunStart): Promise<
        Extract<BridgeMessage, { type: "agent_init" }>
    > {
        this.#expectState("ready");
        const id = this.#nextId();
        await this.#transport.send({
            version: 1,
            id,
            type: "run_start",
            payload: options,
        });
        const response = await this.#receive(
            ["agent_init"],
            [`${id}:init`],
            [id],
        );
        this.#state = "running";
        this.#runId = id;
        this.#nextTurn = 1;
        return response as Extract<BridgeMessage, { type: "agent_init" }>;
    }

    async acknowledgeInitialization(initId: string): Promise<TauRunEvent> {
        this.#expectState("running");
        await this.#transport.send({
            version: 1,
            id: initId,
            type: "agent_init_result",
            payload: {},
        });
        return await this.#receiveRunEvent(initId);
    }

    async respondToTurn(
        turnId: string,
        message: TauAssistantMessage,
    ): Promise<TauRunEvent> {
        this.#expectState("running");
        await this.#transport.send({
            version: 1,
            id: turnId,
            type: "agent_turn_result",
            payload: { message },
        });
        return await this.#receiveRunEvent(turnId);
    }

    async #receiveRunEvent(triggerId: string): Promise<TauRunEvent> {
        if (this.#runId === undefined) {
            throw new TauBridgeClientError("invalid_state", "Tau run id is missing");
        }
        const turnId = `${this.#runId}:turn:${this.#nextTurn}`;
        const response = await this.#receive(
            ["agent_turn", "run_result"],
            [turnId, this.#runId],
            [triggerId],
        );
        if (response.type === "run_result") {
            this.#state = "ready";
            this.#runId = undefined;
            return response;
        }
        if (response.type !== "agent_turn" || response.id !== turnId) {
            throw new TauBridgeClientError(
                "unexpected_response",
                `Expected tau turn ${turnId}`,
            );
        }
        this.#nextTurn += 1;
        return response;
    }

    async shutdown(): Promise<void> {
        this.#expectState("ready");
        const id = this.#nextId();
        await this.#transport.send({
            version: 1,
            id,
            type: "shutdown",
            payload: {},
        });
        await this.#receive(["shutdown_result"], [id]);
        this.#state = "closed";
        const exitCode = await this.#transport.waitForExit();
        if (exitCode !== 0) {
            throw new TauBridgeClientError(
                "process_exit_failed",
                `Tau bridge exited with code ${exitCode}`,
            );
        }
    }

    diagnostics(): string {
        return this.#transport.diagnostics();
    }

    async terminate(): Promise<number> {
        this.#state = "closed";
        return await this.#transport.terminate();
    }
}
