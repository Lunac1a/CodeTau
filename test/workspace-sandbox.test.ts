import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceSandboxError } from "../src/workspace/errors.ts";
import { WorkspaceSandbox } from "../src/workspace/sandbox.ts";

async function withWorkspace(
    run: (options: { root: string; outside: string }) => Promise<void>,
): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "codetau-sandbox-"));
    const root = join(directory, "workspace");
    const outside = join(directory, "outside.txt");
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "private"), { recursive: true });
    await writeFile(join(root, "src", "nested", "hello.ts"), "hello");
    await writeFile(join(root, "private", "secret.txt"), "secret");
    await writeFile(outside, "outside");

    try {
        await run({ root, outside });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

function expectSandboxError(code: WorkspaceSandboxError["code"]): (error: unknown) => boolean {
    return (error: unknown) => {
        assert.ok(error instanceof WorkspaceSandboxError);
        assert.equal(error.code, code);
        return true;
    };
}

test("resolves an existing path matched by allowedPaths", async () => {
    await withWorkspace(async ({ root }) => {
        const sandbox = await WorkspaceSandbox.create(root, ["src/**"]);
        const resolved = await sandbox.resolveExistingPath("src/nested/hello.ts");

        assert.equal(resolved.relativePath, "src/nested/hello.ts");
        assert.equal(resolved.absolutePath, join(root, "src", "nested", "hello.ts"));
    });
});

test("supports single-segment wildcards in allowedPaths", async () => {
    await withWorkspace(async ({ root }) => {
        const sandbox = await WorkspaceSandbox.create(root, ["src/*/*.ts"]);

        assert.equal(
            (await sandbox.resolveExistingPath("src/nested/hello.ts")).relativePath,
            "src/nested/hello.ts",
        );
    });
});

test("rejects traversal, absolute, and disallowed paths", async () => {
    await withWorkspace(async ({ root, outside }) => {
        const sandbox = await WorkspaceSandbox.create(root, ["src/**"]);

        await assert.rejects(
            sandbox.resolveExistingPath("../outside.txt"),
            expectSandboxError("workspace_path_outside"),
        );
        await assert.rejects(
            sandbox.resolveExistingPath(outside),
            expectSandboxError("workspace_path_outside"),
        );
        await assert.rejects(
            sandbox.resolveExistingPath("private/secret.txt"),
            expectSandboxError("workspace_path_not_allowed"),
        );
    });
});

test("rejects a missing allowed path with a stable error", async () => {
    await withWorkspace(async ({ root }) => {
        const sandbox = await WorkspaceSandbox.create(root, ["src/**"]);

        await assert.rejects(
            sandbox.resolveExistingPath("src/missing.ts"),
            expectSandboxError("workspace_path_not_found"),
        );
    });
});

test("rejects a symlink that resolves outside the workspace", async () => {
    await withWorkspace(async ({ root, outside }) => {
        const link = join(root, "src", "outside-link.txt");
        try {
            await symlink(outside, link, "file");
        } catch (error) {
            const code =
                typeof error === "object" && error !== null && "code" in error
                    ? error.code
                    : undefined;
            if (code === "EPERM") {
                return;
            }
            throw error;
        }
        const sandbox = await WorkspaceSandbox.create(root, ["src/**"]);

        await assert.rejects(
            sandbox.resolveExistingPath("src/outside-link.txt"),
            expectSandboxError("workspace_path_outside"),
        );
    });
});

test("deniedPaths override a repository-wide allow pattern", async () => {
    await withWorkspace(async ({ root }) => {
        const sandbox = await WorkspaceSandbox.create(
            root,
            ["**"],
            ["private/**"],
        );
        await assert.rejects(
            sandbox.resolveExistingPath("private/secret.txt"),
            expectSandboxError("workspace_path_not_allowed"),
        );
        await assert.rejects(
            sandbox.resolveNewFilePath("private/new.txt"),
            expectSandboxError("workspace_path_not_allowed"),
        );
        assert.equal(
            (await sandbox.resolveNewFilePath("src/new.ts")).relativePath,
            "src/new.ts",
        );
    });
});

test("new files require an existing parent inside the workspace", async () => {
    await withWorkspace(async ({ root }) => {
        const sandbox = await WorkspaceSandbox.create(root, ["**"]);
        await assert.rejects(
            sandbox.resolveNewFilePath("missing/new.ts"),
            expectSandboxError("workspace_parent_invalid"),
        );
    });
});
