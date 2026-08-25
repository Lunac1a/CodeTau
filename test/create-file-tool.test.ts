import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CreateFileTool } from "../src/tools/create-file.ts";
import { WorkspaceSandbox } from "../src/workspace/sandbox.ts";

test("creates a new UTF-8 file without overwriting existing content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-create-file-"));
    try {
        await mkdir(join(directory, "src"));
        const sandbox = await WorkspaceSandbox.create(directory, ["**"], [".codetau/**"]);
        const tool = new CreateFileTool(sandbox);
        const created = await tool.execute({ path: "src/new.ts", content: "export {};\n" });
        assert.equal(created.ok, true);
        assert.equal(await readFile(join(directory, "src", "new.ts"), "utf8"), "export {};\n");

        await writeFile(join(directory, "src", "existing.ts"), "original", "utf8");
        const existing = await tool.execute({
            path: "src/existing.ts",
            content: "replacement",
        });
        assert.equal(existing.ok, false);
        if (!existing.ok) assert.equal(existing.error.code, "file_already_exists");
        assert.equal(await readFile(join(directory, "src", "existing.ts"), "utf8"), "original");

        const protectedResult = await tool.execute({
            path: ".codetau/task.md",
            content: "hidden",
        });
        assert.equal(protectedResult.ok, false);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
