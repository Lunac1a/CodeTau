import type { ModelProvider, ModelResponse } from "../../../src/model.ts";

type Script = Readonly<{
    tool: string;
    input: Readonly<Record<string, unknown>>;
    confirmation: string;
}>;

const scripts: Readonly<Record<string, Script>> = {
    create_task_1: {
        tool: "create_task",
        input: { user_id: "user_1", title: "Important Meeting" },
        confirmation: "The Important Meeting task was created successfully.",
    },
    update_task_1: {
        tool: "update_task_status",
        input: { task_id: "task_1", status: "completed" },
        confirmation: "Task task_1 was marked as completed successfully.",
    },
};

export const deterministicTauTaskIds = Object.freeze(Object.keys(scripts));

export class DeterministicTauModel implements ModelProvider {
    readonly #script: Script;
    #turn = 0;

    constructor(taskId: string) {
        const script = scripts[taskId];
        if (script === undefined) {
            throw new Error(`No deterministic tau script exists for task: ${taskId}`);
        }
        this.#script = script;
    }

    async generate(): Promise<ModelResponse> {
        this.#turn += 1;
        if (this.#turn === 1) {
            return {
                kind: "tool_calls",
                calls: [{
                    id: `deterministic-${this.#script.tool}`,
                    name: this.#script.tool,
                    input: this.#script.input,
                }],
                usage: { inputTokens: 0, outputTokens: 0 },
            };
        }
        if (this.#turn === 2) {
            return {
                kind: "text",
                text: this.#script.confirmation,
                usage: { inputTokens: 0, outputTokens: 0 },
            };
        }
        throw new Error("Deterministic tau model received an unexpected turn");
    }
}
