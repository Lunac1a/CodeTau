import assert from "node:assert/strict";
import { resolve } from "node:path";
import { execPath } from "node:process";
import test from "node:test";

import {
    ProcessTauBridgeTransport,
    TauBridgeClientError,
} from "../packages/bench/tau/client.ts";

test("times out and terminates an unresponsive bridge process", async () => {
    const transport = new ProcessTauBridgeTransport({
        command: execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: resolve("."),
        timeoutMs: 30,
    });

    await assert.rejects(transport.receive(), (error: unknown) => {
        assert.ok(error instanceof TauBridgeClientError);
        assert.equal(error.code, "response_timeout");
        return true;
    });
    assert.notEqual(await transport.waitForExit(), 0);
});

test("rejects non-protocol stdout from a bridge process", async () => {
    const transport = new ProcessTauBridgeTransport({
        command: execPath,
        args: ["-e", "process.stdout.write('not-json\\n')"],
        cwd: resolve("."),
        timeoutMs: 1_000,
    });

    await assert.rejects(transport.receive(), (error: unknown) => {
        assert.ok(error instanceof TauBridgeClientError);
        assert.equal(error.code, "invalid_json");
        return true;
    });
    await transport.waitForExit();
});
