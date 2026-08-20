import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadBenchManifest } from "../packages/bench/manifest.ts";

test("loads a versioned Bench task manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-bench-manifest-"));
    const path = join(directory, "manifest.json");
    try {
        await writeFile(
            path,
            JSON.stringify({
                version: 1,
                tasks: [{ id: "task-one", specPath: "specs/task.md" }],
            }),
            "utf8",
        );

        assert.deepEqual(await loadBenchManifest(path), {
            version: 1,
            tasks: [{ id: "task-one", specPath: "specs/task.md" }],
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("rejects duplicate Bench task ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-bench-duplicate-"));
    const path = join(directory, "manifest.json");
    try {
        await writeFile(
            path,
            JSON.stringify({
                version: 1,
                tasks: [
                    { id: "same", specPath: "one.md" },
                    { id: "same", specPath: "two.md" },
                ],
            }),
            "utf8",
        );

        await assert.rejects(loadBenchManifest(path), /ids must be unique/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
