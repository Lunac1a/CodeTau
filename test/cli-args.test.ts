import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArgs } from "../apps/cli/args.ts";

test("parses a status command", () => {
    assert.deepEqual(parseCliArgs(["status", "session-123"]), {
        kind: "status",
        sessionId: "session-123",
    });
});

test("parses run and resume commands", () => {
    assert.deepEqual(
        parseCliArgs([
            "run",
            "specs/bench/fix-greeting/task.md",
            "--session",
            "session-1",
        ]),
        {
            kind: "run",
            specPath: "specs/bench/fix-greeting/task.md",
            sessionId: "session-1",
        },
    );
    assert.deepEqual(
        parseCliArgs(["resume", "session-1", "--approval", "allow-once"]),
        {
            kind: "resume",
            sessionId: "session-1",
            approvalResponse: "allow-once",
        },
    );
    assert.deepEqual(parseCliArgs(["--", "status", "session-1"]), {
        kind: "status",
        sessionId: "session-1",
    });
});

test("parses interactive and direct natural-language commands", () => {
    assert.deepEqual(parseCliArgs([]), { kind: "chat" });
    assert.deepEqual(parseCliArgs(["chat"]), { kind: "chat" });
    assert.deepEqual(
        parseCliArgs(["chat", "--conversation", "conversation-1"]),
        { kind: "chat", conversationId: "conversation-1" },
    );
    assert.deepEqual(
        parseCliArgs([
            "ask",
            "fix the bug",
            "--session",
            "natural-1",
            "--yes",
            "--validate",
            "pnpm test",
            "--validate",
            "pnpm typecheck",
        ]),
        {
            kind: "ask",
            task: "fix the bug",
            sessionId: "natural-1",
            yes: true,
            validationCommands: ["pnpm test", "pnpm typecheck"],
        },
    );
    assert.deepEqual(parseCliArgs(["--verbose"]), {
        kind: "chat",
        verbose: true,
    });
    assert.deepEqual(
        parseCliArgs([
            "chat",
            "--conversation",
            "conversation-1",
            "--verbose",
        ]),
        {
            kind: "chat",
            conversationId: "conversation-1",
            verbose: true,
        },
    );
    assert.deepEqual(
        parseCliArgs(["ask", "fix the bug", "--verbose"]),
        {
            kind: "ask",
            task: "fix the bug",
            sessionId: undefined,
            yes: false,
            validationCommands: [],
            verbose: true,
        },
    );
});

test("rejects incomplete or unsupported commands", () => {
    const invalidArguments = [
        ["ask"],
        ["ask", "task", "--validate"],
        ["chat", "conversation-1"],
        ["chat", "--conversation"],
        ["status"],
        ["status", ""],
        ["status", "session-123", "extra"],
        ["run"],
        ["run", "specs/bench/fix-greeting/task.md", "--unknown", "value"],
        ["resume", "session-1", "--approval", "yes"],
        ["status", "session-1", "--verbose"],
        ["chat", "--verbose", "--verbose"],
    ];

    for (const argv of invalidArguments) {
        assert.throws(
            () => parseCliArgs(argv),
            /codetau run <spec-path>/,
        );
    }
});
