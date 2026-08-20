import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArgs } from "../apps/cli/args.ts";

test("parses a status command", () => {
    assert.deepEqual(parseCliArgs(["status", "session-123"]), {
        kind: "status",
        sessionId: "session-123",
    });
});

test("rejects incomplete or unsupported commands", () => {
    const invalidArguments = [
        [],
        ["status"],
        ["status", ""],
        ["status", "session-123", "extra"],
        ["run", "specs/example.md"],
    ];

    for (const argv of invalidArguments) {
        assert.throws(
            () => parseCliArgs(argv),
            /Usage: codetau status <session-id>/,
        );
    }
});
