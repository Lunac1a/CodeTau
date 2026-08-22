import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { TauSessionAdapter } from "../packages/bench/tau/adapter.ts";
import { ProcessTauBridgeTransport, TauBridgeClient } from "../packages/bench/tau/client.ts";
import type { ModelProvider, ModelResponse } from "../src/model.ts";

type UpstreamLock = Readonly<{ benchmark: Readonly<{ commit: string }> }>;

class DeterministicSmokeModel implements ModelProvider {
    #turn = 0;

    async generate(): Promise<ModelResponse> {
        this.#turn += 1;
        if (this.#turn === 1) {
            return {
                kind: "tool_calls",
                calls: [{
                    id: "smoke-create-1",
                    name: "create_task",
                    input: { user_id: "user_1", title: "Important Meeting" },
                }],
                usage: { inputTokens: 0, outputTokens: 0 },
            };
        }
        if (this.#turn === 2) {
            return {
                kind: "text",
                text: "The Important Meeting task was created successfully.",
                usage: { inputTokens: 0, outputTokens: 0 },
            };
        }
        throw new Error("Official tau smoke requested an unexpected model turn");
    }
}

const projectRoot = resolve(".");
const lock = JSON.parse(
    await readFile(resolve("python/tau_bridge/upstream-lock.json"), "utf8"),
) as UpstreamLock;
const checkout = resolve(`.codetau/upstream/tau2-bench-${lock.benchmark.commit.slice(0, 8)}`);
const python = resolve(checkout, ".venv/Scripts/python.exe");
await access(python);

const transport = new ProcessTauBridgeTransport({
    command: python,
    args: ["-m", "tau_bridge"],
    cwd: resolve(projectRoot, "python"),
    timeoutMs: 60_000,
});
const adapter = new TauSessionAdapter({
    client: new TauBridgeClient(transport),
    model: new DeterministicSmokeModel(),
});
const result = await adapter.run({
    domain: "mock",
    taskSplit: "base",
    taskId: "create_task_1",
    trial: 1,
    seed: 42,
});

assert.equal(result.status, "completed");
assert.equal(result.reward, 1);
assert.equal(result.metadata.upstreamCommit, lock.benchmark.commit);

console.log(JSON.stringify({
    smokeMode: "deterministic-model",
    domain: result.metadata.domain,
    taskSplit: result.metadata.taskSplit,
    taskId: result.metadata.taskId,
    seed: result.metadata.seed,
    upstreamCommit: result.metadata.upstreamCommit,
    reward: result.reward,
    status: result.status,
    modelTurns: result.modelTurns,
}, null, 2));
