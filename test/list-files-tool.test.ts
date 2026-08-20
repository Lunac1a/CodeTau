import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ListFilesTool } from "../src/tools/list-files.ts";
import { WorkspaceSandbox } from "../src/workspace/sandbox.ts";

test("lists only allowed regular files in stable order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-list-files-"));
    await mkdir(join(directory, "src", "nested"), { recursive: true });
    await mkdir(join(directory, "private"));
    await writeFile(join(directory, "src", "z.ts"), "z");
    await writeFile(join(directory, "src", "nested", "a.ts"), "a");
    await writeFile(join(directory, "private", "secret.txt"), "secret");

    try {
        const sandbox = await WorkspaceSandbox.create(directory, ["src/**"]);
        const result = await new ListFilesTool(sandbox).execute({});

        assert.deepEqual(result, {
            ok: true,
            output: {
                paths: ["src/nested/a.ts", "src/z.ts"],
                truncated: false,
            },
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("enforces input and result limits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-list-limit-"));
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src", "a.ts"), "a");
    await writeFile(join(directory, "src", "b.ts"), "b");

    try {
        const sandbox = await WorkspaceSandbox.create(directory, ["src/**"]);
        const tool = new ListFilesTool(sandbox, 1);

        assert.deepEqual(await tool.execute({ path: "src" }), {
            ok: false,
            error: {
                code: "tool_input_invalid",
                message: "list_files input must be an empty object",
            },
        });
        assert.deepEqual(await tool.execute({}), {
            ok: true,
            output: { paths: ["src/a.ts"], truncated: true },
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
