import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";

import { loadBenchManifest } from "../packages/bench/manifest.ts";
import { loadSpec } from "../src/spec/loader.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("default Bench tasks follow the directory contract and begin unsolved", async () => {
    const manifest = await loadBenchManifest(
        resolve(projectRoot, "packages/bench/manifest.json"),
    );

    assert.deepEqual(
        manifest.tasks.map((task) => task.id),
        ["fix-greeting", "clamp-score", "normalize-email"],
    );

    for (const task of manifest.tasks) {
        assert.equal(task.specPath, `specs/bench/${task.id}/task.md`);
        const spec = await loadSpec(resolve(projectRoot, task.specPath));
        assert.equal(spec.contract.id, `bench.${task.id}`);
        assert.equal(spec.contract.workspace.root, `fixtures/bench/${task.id}`);
        assert.deepEqual(spec.contract.workspace.allowedPaths, ["src/**"]);
        assert.equal(spec.contract.userInteraction.allowQuestions, false);
        assert.equal(spec.contract.acceptance.commands.length, 1);

        const command = spec.contract.acceptance.commands[0];
        const validation = spawnSync(command.executable, command.args, {
            cwd: resolve(projectRoot, spec.contract.workspace.root),
            encoding: "utf8",
            shell: false,
            windowsHide: true,
        });
        assert.equal(validation.error, undefined, `${task.id} validation must start`);
        assert.notEqual(
            validation.status,
            0,
            `${task.id} must begin with a failing acceptance command`,
        );
    }
});
