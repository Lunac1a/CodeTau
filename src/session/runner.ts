import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { resumeAgentLoop, runAgentLoop } from "../agent-loop/run.ts";
import type { CodeTauConfig } from "../config/loader.ts";
import { ContextManager } from "../context/manager.ts";
import type { TaskState } from "../events.ts";
import type { ModelProvider } from "../model.ts";
import type { EventStore } from "../persistence/event-store.ts";
import { OpenAICompatibleModelProvider } from "../providers/openai-compatible.ts";
import type { ApprovalResponse, LoadedSpec } from "../spec/types.ts";
import { loadSpec } from "../spec/loader.ts";
import { computeSpecDigest, createSpecSnapshot } from "../spec/digest.ts";
import { validateSpecContract } from "../spec/validator.ts";
import { ApplyPatchTool } from "../tools/apply-patch.ts";
import { CreateFileTool } from "../tools/create-file.ts";
import { ListFilesTool } from "../tools/list-files.ts";
import { ReadFileTool } from "../tools/read-file.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { RunValidationTool } from "../tools/run-validation.ts";
import { WorkspaceSandbox } from "../workspace/sandbox.ts";

export type SessionRunnerOptions = Readonly<{
    config: CodeTauConfig;
    eventStore: EventStore;
    model?: ModelProvider;
    nextSessionId?: () => string;
}>;

export type RunSessionOptions = Readonly<{
    specPath: string;
    sessionId?: string;
}>;

export type RunLoadedSpecOptions = Readonly<{
    spec: LoadedSpec;
    sessionId?: string;
}>;

export type ResumeSessionOptions = Readonly<{
    sessionId: string;
    approvalResponse?: ApprovalResponse;
}>;

export interface SessionRunnerLike {
    run(options: RunSessionOptions): Promise<TaskState>;
    runLoadedSpec(options: RunLoadedSpecOptions): Promise<TaskState>;
    resume(options: ResumeSessionOptions): Promise<TaskState>;
}

export class SessionRunner implements SessionRunnerLike {
    readonly #config: CodeTauConfig;
    readonly #eventStore: EventStore;
    readonly #model: ModelProvider;
    readonly #nextSessionId: () => string;
    readonly #contextManager: ContextManager;

    constructor(options: SessionRunnerOptions) {
        this.#config = options.config;
        this.#eventStore = options.eventStore;
        this.#model =
            options.model ??
            new OpenAICompatibleModelProvider({
                baseUrl: options.config.baseUrl,
                model: options.config.model,
                apiKey: process.env.CODETAU_MODEL_API_KEY,
            });
        this.#nextSessionId = options.nextSessionId ?? randomUUID;
        this.#contextManager = new ContextManager(options.config.contextManagement);
    }

    async run(options: RunSessionOptions): Promise<TaskState> {
        const spec = await loadSpec(options.specPath);
        return this.runLoadedSpec({ spec, sessionId: options.sessionId });
    }

    async runLoadedSpec(options: RunLoadedSpecOptions): Promise<TaskState> {
        const { spec } = options;
        const toolRegistry = await this.#createToolRegistry(spec);
        return runAgentLoop({
            sessionId: options.sessionId ?? this.#nextSessionId(),
            spec,
            model: this.#model,
            eventStore: this.#eventStore,
            toolRegistry,
            contextManager: this.#contextManager,
        });
    }

    async resume(options: ResumeSessionOptions): Promise<TaskState> {
        const events = await this.#eventStore.loadSession(options.sessionId);
        const started = events[0];
        if (started?.type !== "session_started") {
            throw new Error(`Session does not exist: ${options.sessionId}`);
        }

        const spec =
            started.specOrigin === "generated"
                ? await this.#restoreGeneratedSpec(started)
                : await loadSpec(started.specPath);
        const toolRegistry = await this.#createToolRegistry(spec);
        return resumeAgentLoop({
            sessionId: options.sessionId,
            spec,
            model: this.#model,
            eventStore: this.#eventStore,
            toolRegistry,
            approvalResponse: options.approvalResponse,
            contextManager: this.#contextManager,
        });
    }

    async #createToolRegistry(spec: LoadedSpec): Promise<ToolRegistry> {
        const workspaceRoot = resolve(
            this.#config.rootDirectory,
            spec.contract.workspace.root,
        );
        const sandbox = await WorkspaceSandbox.create(
            workspaceRoot,
            spec.contract.workspace.allowedPaths,
            spec.contract.workspace.deniedPaths,
        );
        return new ToolRegistry([
            new CreateFileTool(sandbox),
            new ListFilesTool(sandbox),
            new ReadFileTool(sandbox),
            new ApplyPatchTool(sandbox),
            new RunValidationTool({
                workspaceRoot: sandbox.workspaceRoot(),
                commands: spec.contract.acceptance.commands,
                commandAllowlist: this.#config.commandAllowlist,
                timeoutMs: this.#config.commandTimeoutMs,
                maxOutputBytes: this.#config.maxOutputBytes,
            }),
        ]);
    }

    async #restoreGeneratedSpec(
        started: Extract<
            Awaited<ReturnType<EventStore["loadSession"]>>[number],
            { type: "session_started" }
        >,
    ): Promise<LoadedSpec> {
        const contract = await validateSpecContract(
            started.specSnapshot.contract,
            started.specPath,
        );
        const digest = computeSpecDigest(
            createSpecSnapshot(contract, started.specSnapshot.context),
        );
        if (digest !== started.specDigest) {
            throw new Error(
                `Generated Session Spec digest does not match: ${started.sessionId}`,
            );
        }
        return {
            sourcePath: started.specPath,
            origin: "generated",
            contract,
            context: started.specSnapshot.context,
            digest,
        };
    }
}
