import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ReadFileTool } from "../src/tools/read-file.ts";
import { WorkspaceSandbox } from "../src/workspace/sandbox.ts";

async function createTool(maxBytes = 100_000): Promise<{
    directory: string;
    tool: ReadFileTool;
}> {
    const directory = await mkdtemp(join(tmpdir(), "codetau-read-file-"));
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src", "hello.txt"), "Hello, Agent!", "utf8");
    const sandbox = await WorkspaceSandbox.create(directory, ["src/**"]);
    return { directory, tool: new ReadFileTool(sandbox, maxBytes) };
}

test("reads an allowed UTF-8 file with path and byte metadata", async () => {
    const { directory, tool } = await createTool();
    try {
        assert.deepEqual(await tool.execute({ path: "src/hello.txt" }), {
            ok: true,
            output: {
                path: "src/hello.txt",
                content: "Hello, Agent!",
                bytes: 13,
            },
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("rejects malformed input and disallowed paths", async () => {
    const { directory, tool } = await createTool();
    try {
        assert.equal((await tool.execute({})).ok, false);
        assert.deepEqual(await tool.execute({ path: "secret.txt" }), {
            ok: false,
            error: {
                code: "workspace_path_not_allowed",
                message: "Workspace path is outside allowedPaths: secret.txt",
            },
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("enforces the configured byte limit", async () => {
    const { directory, tool } = await createTool(5);
    try {
        assert.deepEqual(await tool.execute({ path: "src/hello.txt" }), {
            ok: false,
            error: {
                code: "file_too_large",
                message: "File exceeds the 5 byte read limit: src/hello.txt",
            },
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("reads a 1-based line range with UTF-8 metadata", async () => {
    const { directory, tool } = await createTool();
    try {
        await writeFile(
            join(directory, "src", "lines.txt"),
            "alpha\nβ\n三\nomega\n",
            "utf8",
        );
        assert.deepEqual(
            await tool.execute({
                path: "src/lines.txt",
                startLine: 2,
                endLine: 3,
            }),
            {
                ok: true,
                output: {
                    path: "src/lines.txt",
                    content: "β\n三",
                    bytes: 6,
                    startLine: 2,
                    endLine: 3,
                    totalLines: 4,
                    truncated: true,
                },
            },
        );
        assert.equal(
            (await tool.execute({ path: "src/lines.txt", startLine: 5 })).ok,
            false,
        );
        assert.equal(
            (
                await tool.execute({
                    path: "src/lines.txt",
                    startLine: 3,
                    endLine: 2,
                })
            ).ok,
            false,
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
