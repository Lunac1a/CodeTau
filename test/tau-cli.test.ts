import assert from "node:assert/strict";
import test from "node:test";

import { parseTauCliArgs } from "../packages/bench/tau/cli.ts";

test("parses repeated tau tasks, trials, seed, and LM Studio settings", () => {
    const options = parseTauCliArgs([
        "--",
        "--task", "create_task_1",
        "--task", "update_task_1",
        "--runs", "3",
        "--seed", "100",
        "--model-mode", "lmstudio",
        "--model", "local-model",
        "--base-url", "http://localhost:1234/v1",
        "--output", "reports",
    ]);
    assert.deepEqual(options, {
        taskIds: ["create_task_1", "update_task_1"],
        runsPerTask: 3,
        baseSeed: 100,
        modelMode: "lmstudio",
        model: "local-model",
        baseUrl: "http://localhost:1234/v1",
        outputDirectory: "reports",
    });
});

test("uses a bounded deterministic default and rejects unsafe options", () => {
    assert.deepEqual(parseTauCliArgs([]).taskIds, ["create_task_1"]);
    assert.throws(() => parseTauCliArgs(["--runs", "101"]), /<= 100/u);
    assert.throws(
        () => parseTauCliArgs(["--task", "../escape"]),
        /letters, numbers/u,
    );
    assert.throws(
        () => parseTauCliArgs(["--model-mode", "remote"]),
        /deterministic or lmstudio/u,
    );
});
