import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CodeTauConfig } from "../src/config/loader.ts";
import {
    formatValidationCommand,
    parseValidationCommand,
} from "../src/natural-language/command-line.ts";
import {
    inspectProject,
    normalizeValidationCommandForPlatform,
} from "../src/natural-language/project-inspector.ts";
import {
    BUILT_IN_PROTECTED_PATHS,
    buildNaturalLanguageTask,
} from "../src/natural-language/task-builder.ts";

function config(rootDirectory: string): CodeTauConfig {
    return {
        databasePath: join(rootDirectory, ".codetau", "db.sqlite"),
        model: "test-model",
        baseUrl: "http://localhost:1234/v1",
        commandAllowlist: ["node", "pnpm", "pnpm.cmd", "python"],
        commandTimeoutMs: 1000,
        maxOutputBytes: 1000,
        sourcePath: join(rootDirectory, "codetau.config.json"),
        rootDirectory,
        naturalLanguage: {
            maxModelTurns: 7,
            maxToolCalls: 11,
            maxRetries: 2,
            additionalProtectedPaths: ["secrets/**"],
        },
    };
}

test("parses validation commands without invoking a shell", () => {
    const command = parseValidationCommand('node --test "test/my test.ts"');
    assert.deepEqual(command, {
        executable: "node",
        args: ["--test", "test/my test.ts"],
    });
    assert.equal(
        formatValidationCommand(command),
        'node --test "test/my test.ts"',
    );
    assert.throws(() => parseValidationCommand("pnpm test && echo unsafe"));
    assert.throws(() => parseValidationCommand("TOKEN=value node test.js"));
    assert.throws(() => parseValidationCommand('node "unterminated'));
});

test("normalizes package-manager validation without a Windows shell", async () => {
    const normalized = await normalizeValidationCommandForPlatform({
        executable: "pnpm",
        args: ["run", "test"],
    });
    if (process.platform === "win32") {
        assert.equal(normalized.executable, "node");
        assert.ok(normalized.args[0]?.endsWith("pnpm.js"));
        assert.deepEqual(normalized.args.slice(-2), ["run", "test"]);
    } else {
        assert.deepEqual(normalized, {
            executable: "pnpm",
            args: ["run", "test"],
        });
    }
});

test("discovers Node validation scripts in a stable order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-inspect-node-"));
    try {
        await writeFile(
            join(directory, "package.json"),
            JSON.stringify({
                packageManager: "pnpm@11.0.0",
                scripts: {
                    lint: "eslint .",
                    test: "node --test",
                    "test:all": "pnpm test && python -m unittest",
                    typecheck: "tsc --noEmit",
                },
            }),
            "utf8",
        );
        await writeFile(
            join(directory, "pyproject.toml"),
            "[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n",
            "utf8",
        );
        const result = await inspectProject(directory);
        assert.deepEqual(
            result.validationCommands.map((command) => command.display),
            ["pnpm run typecheck", "pnpm run test:all", "pnpm run lint"],
        );
        assert.deepEqual(
            result.validationCommands.map((command) => command.args.slice(-2)),
            [
                ["run", "typecheck"],
                ["run", "test:all"],
                ["run", "lint"],
            ],
        );
        assert.ok(
            result.validationCommands.every((command) =>
                process.platform === "win32"
                    ? command.executable === "node" &&
                      command.args[0]?.endsWith("pnpm.js")
                    : command.executable === "pnpm",
            ),
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("discovers Python unittest projects without pytest configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-inspect-python-"));
    try {
        await mkdir(join(directory, "python", "tests"), { recursive: true });
        await writeFile(join(directory, "python", "tests", "test_sample.py"), "", "utf8");
        const result = await inspectProject(directory);
        assert.deepEqual(result.validationCommands, [
            {
                executable: "python",
                args: ["-m", "unittest", "discover", "-s", "python/tests", "-t", "python"],
            },
        ]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("builds a validated generated Spec with protected paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-task-builder-"));
    try {
        const built = await buildNaturalLanguageTask({
            task: "Fix the registration bug.\nPreserve existing behavior.",
            sessionId: "Session 1",
            validationCommands: [{ executable: "node", args: ["--test"] }],
            config: config(directory),
        });
        assert.equal(built.origin, "generated");
        assert.equal(built.contract.id, "interactive.session-1");
        assert.equal(built.contract.goal, built.context);
        assert.deepEqual(built.contract.workspace.allowedPaths, ["**"]);
        assert.deepEqual(built.contract.workspace.deniedPaths, [
            ...BUILT_IN_PROTECTED_PATHS,
            "secrets/**",
        ]);
        assert.deepEqual(built.contract.budget, {
            maxModelTurns: 7,
            maxToolCalls: 11,
            maxRetries: 2,
        });
        assert.match(built.digest, /^[a-f0-9]{64}$/u);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
