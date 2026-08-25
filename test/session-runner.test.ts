import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CodeTauConfig } from "../src/config/loader.ts";
import { InMemoryEventStore } from "../src/persistence/in-memory-event-store.ts";
import { SessionRunner } from "../src/session/runner.ts";
import { buildNaturalLanguageTask } from "../src/natural-language/task-builder.ts";
import { FakeModelProvider } from "./fakes/fake-model.ts";

function configFor(directory: string): CodeTauConfig {
    return {
        databasePath: join(directory, ".codetau", "test.db"),
        model: "unused-test-model",
        baseUrl: "http://localhost:1234/v1",
        commandAllowlist: [process.execPath],
        commandTimeoutMs: 2_000,
        maxOutputBytes: 10_000,
        sourcePath: join(directory, "codetau.config.json"),
        rootDirectory: directory,
        naturalLanguage: {
            maxModelTurns: 20,
            maxToolCalls: 60,
            maxRetries: 3,
            additionalProtectedPaths: [],
        },
    };
}

async function createFixture(directory: string): Promise<string> {
    const workspace = join(directory, "workspace");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "value.txt"), "before", "utf8");
    const specPath = join(directory, "task.md");
    const executable = JSON.stringify(process.execPath);
    await writeFile(
        specPath,
        [
            "---",
            "version: 1",
            "id: test.session-runner",
            "goal: Exercise the assembled Session Runner.",
            "workspace:",
            "  root: workspace",
            "  allowedPaths: [src/**]",
            "policy:",
            "  forbiddenActions: [network-access]",
            "acceptance:",
            "  commands:",
            `    - executable: ${executable}`,
            "      args: [-e, process.exit(0)]",
            "  assertions: [Validation passes.]",
            "phases:",
            "  - id: edit",
            "    description: Edit the fixture.",
            "budget:",
            "  maxModelTurns: 4",
            "  maxToolCalls: 4",
            "  maxRetries: 1",
            "userInteraction:",
            "  allowQuestions: true",
            "  approvalResponses: [allow-once, allow-session, deny]",
            "---",
            "",
            "Update the fixture.",
        ].join("\n"),
        "utf8",
    );
    return specPath;
}

test("assembles the real tool registry around the configured workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-session-runner-"));
    const store = new InMemoryEventStore();
    try {
        const specPath = await createFixture(directory);
        const model = new FakeModelProvider([
            {
                kind: "tool_calls",
                calls: [
                    {
                        id: "read-1",
                        name: "read_file",
                        input: { path: "src/value.txt" },
                    },
                ],
                usage: { inputTokens: 10, outputTokens: 4 },
            },
            {
                kind: "finish",
                outcome: "blocked",
                message: "Read completed.",
                usage: { inputTokens: 14, outputTokens: 3 },
            },
        ]);
        const runner = new SessionRunner({
            config: configFor(directory),
            eventStore: store,
            model,
            nextSessionId: () => "generated-session",
        });

        const state = await runner.run({ specPath });

        assert.equal(state.sessionId, "generated-session");
        assert.equal(state.status, "blocked");
        assert.deepEqual(
            model.requests[0].availableTools.map((tool) => tool.name),
            ["apply_patch", "create_file", "list_files", "read_file", "run_validation"],
        );
        assert.match(model.requests[1].messages.at(-1)?.content ?? "", /before/);
    } finally {
        await store.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("resumes a persisted approval using the Spec path stored in the Session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-session-resume-"));
    const store = new InMemoryEventStore();
    try {
        const specPath = await createFixture(directory);
        const model = new FakeModelProvider([
            {
                kind: "tool_calls",
                calls: [
                    {
                        id: "patch-1",
                        name: "apply_patch",
                        input: {
                            path: "src/value.txt",
                            edits: [{ oldText: "before", newText: "after" }],
                        },
                    },
                ],
                usage: { inputTokens: 10, outputTokens: 6 },
            },
            {
                kind: "finish",
                outcome: "blocked",
                message: "Patch applied; validation was not requested in this test.",
                usage: { inputTokens: 20, outputTokens: 5 },
            },
        ]);
        const runner = new SessionRunner({
            config: configFor(directory),
            eventStore: store,
            model,
        });

        const pending = await runner.run({ specPath, sessionId: "resume-me" });
        assert.equal(pending.status, "awaiting_approval");
        assert.equal(await readFile(join(directory, "workspace", "src", "value.txt"), "utf8"), "before");

        const resumed = await runner.resume({
            sessionId: "resume-me",
            approvalResponse: "allow-once",
        });

        assert.equal(resumed.status, "blocked");
        assert.equal(await readFile(join(directory, "workspace", "src", "value.txt"), "utf8"), "after");
    } finally {
        await store.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("resumes a generated Spec from its persisted snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-generated-resume-"));
    const store = new InMemoryEventStore();
    try {
        await mkdir(join(directory, "src"), { recursive: true });
        const model = new FakeModelProvider([
            {
                kind: "tool_calls",
                calls: [
                    {
                        id: "create-1",
                        name: "create_file",
                        input: { path: "src/generated.ts", content: "export {};\n" },
                    },
                ],
                usage: { inputTokens: 10, outputTokens: 5 },
            },
            {
                kind: "tool_calls",
                calls: [
                    {
                        id: "validation-1",
                        name: "run_validation",
                        input: { commandIndex: 0 },
                    },
                ],
                usage: { inputTokens: 12, outputTokens: 4 },
            },
        ]);
        const runner = new SessionRunner({
            config: configFor(directory),
            eventStore: store,
            model,
        });
        const spec = await buildNaturalLanguageTask({
            task: "Create a generated module.",
            sessionId: "generated-resume",
            validationCommands: [
                { executable: process.execPath, args: ["-e", "process.exit(0)"] },
            ],
            config: configFor(directory),
        });
        const pending = await runner.runLoadedSpec({
            spec,
            sessionId: "generated-resume",
        });
        assert.equal(pending.status, "awaiting_approval");

        const restartedRunner = new SessionRunner({
            config: configFor(directory),
            eventStore: store,
            model,
        });
        const validationPending = await restartedRunner.resume({
            sessionId: "generated-resume",
            approvalResponse: "allow-once",
        });
        assert.equal(validationPending.status, "awaiting_approval");
        assert.equal(validationPending.pendingApproval?.toolName, "run_validation");
        const completed = await restartedRunner.resume({
            sessionId: "generated-resume",
            approvalResponse: "allow-once",
        });
        assert.equal(completed.status, "completed");
        assert.equal(
            await readFile(join(directory, "src", "generated.ts"), "utf8"),
            "export {};\n",
        );
        const started = (await store.loadSession("generated-resume"))[0];
        assert.equal(started?.type, "session_started");
        if (started?.type === "session_started") {
            assert.equal(started.specOrigin, "generated");
        }
    } finally {
        await store.close();
        await rm(directory, { recursive: true, force: true });
    }
});
