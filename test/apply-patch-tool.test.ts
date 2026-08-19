import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ApplyPatchTool } from "../src/tools/apply-patch.ts";
import { WorkspaceSandbox } from "../src/workspace/sandbox.ts";

async function createTool(): Promise<{
    directory: string;
    filePath: string;
    tool: ApplyPatchTool;
}> {
    const directory = await mkdtemp(join(tmpdir(), "codetau-apply-patch-"));
    const sourceDirectory = join(directory, "src");
    const filePath = join(sourceDirectory, "answer.ts");
    await mkdir(sourceDirectory);
    await writeFile(filePath, "export const answer = 41;\n", "utf8");
    const sandbox = await WorkspaceSandbox.create(directory, ["src/**"]);
    return { directory, filePath, tool: new ApplyPatchTool(sandbox) };
}

test("applies an exact patch to an allowed text file", async () => {
    const { directory, filePath, tool } = await createTool();
    try {
        assert.deepEqual(
            await tool.execute({
                path: "src/answer.ts",
                edits: [{ oldText: "answer = 41", newText: "answer = 42" }],
            }),
            {
                ok: true,
                output: {
                    path: "src/answer.ts",
                    editsApplied: 1,
                    bytes: 26,
                },
            },
        );
        assert.equal(await readFile(filePath, "utf8"), "export const answer = 42;\n");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("leaves the file unchanged when patch context is stale", async () => {
    const { directory, filePath, tool } = await createTool();
    try {
        const result = await tool.execute({
            path: "src/answer.ts",
            edits: [{ oldText: "answer = 40", newText: "answer = 42" }],
        });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error.code, "patch_context_missing");
        }
        assert.equal(await readFile(filePath, "utf8"), "export const answer = 41;\n");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("does not overwrite a file changed immediately before commit", async () => {
    const { directory, filePath } = await createTool();
    const sandbox = await WorkspaceSandbox.create(directory, ["src/**"]);
    const tool = new ApplyPatchTool(sandbox, 500_000, {
        nextTemporaryName: () => "conflict-test",
        beforeCommit: async () => {
            await writeFile(filePath, "export const answer = 43;\n", "utf8");
        },
    });
    try {
        assert.deepEqual(
            await tool.execute({
                path: "src/answer.ts",
                edits: [{ oldText: "answer = 41", newText: "answer = 42" }],
            }),
            {
                ok: false,
                error: {
                    code: "patch_conflict",
                    message:
                        "File changed before the patch could be written: src/answer.ts",
                },
            },
        );
        assert.equal(await readFile(filePath, "utf8"), "export const answer = 43;\n");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("rejects disallowed paths and malformed patch input", async () => {
    const { directory, tool } = await createTool();
    try {
        assert.equal((await tool.execute({ path: "src/answer.ts" })).ok, false);
        assert.deepEqual(
            await tool.execute({
                path: "private/secret.txt",
                edits: [{ oldText: "a", newText: "b" }],
            }),
            {
                ok: false,
                error: {
                    code: "workspace_path_not_allowed",
                    message: "Workspace path is outside allowedPaths: private/secret.txt",
                },
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
