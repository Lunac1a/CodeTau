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

test("rejects incomplete or unsupported commands", () => {
    const invalidArguments = [
        [],
        ["status"],
        ["status", ""],
        ["status", "session-123", "extra"],
        ["run"],
        ["run", "specs/bench/fix-greeting/task.md", "--unknown", "value"],
        ["resume", "session-1", "--approval", "yes"],
    ];

    for (const argv of invalidArguments) {
        assert.throws(
            () => parseCliArgs(argv),
            /codetau run <spec-path>/,
        );
    }
});
