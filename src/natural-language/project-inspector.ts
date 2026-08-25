import { access, readFile, readdir } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import type { ValidationCommand } from "./command-line.ts";

export type ProjectInspection = Readonly<{
    validationCommands: readonly ValidationCommand[];
}>;

async function exists(path: string): Promise<boolean> {
    return access(path).then(
        () => true,
        () => false,
    );
}

type PackageManagerInvocation = Readonly<{
    executable: string;
    argsPrefix: readonly string[];
}>;

async function resolveWindowsPackageManager(
    name: string,
): Promise<PackageManagerInvocation | undefined> {
    const scriptSuffix =
        name === "npm"
            ? join("node_modules", "npm", "bin", "npm-cli.js")
            : join("node_modules", "corepack", "dist", `${name}.js`);
    const roots = [
        dirname(process.execPath),
        ...(process.env.PATH ?? "")
            .split(delimiter)
            .map((entry) => entry.replace(/^"|"$/gu, ""))
            .filter(Boolean),
    ];
    for (const root of [...new Set(roots)]) {
        const script = join(root, scriptSuffix);
        if (await exists(script)) {
            return { executable: "node", argsPrefix: [script] };
        }
    }
    return undefined;
}

async function packageManagerInvocation(
    name: string,
): Promise<PackageManagerInvocation | undefined> {
    return process.platform === "win32"
        ? resolveWindowsPackageManager(name)
        : { executable: name, argsPrefix: [] };
}

export async function normalizeValidationCommandForPlatform(
    command: ValidationCommand,
): Promise<ValidationCommand> {
    if (process.platform !== "win32") {
        return command;
    }
    const name = command.executable.toLowerCase().replace(/\.cmd$/u, "");
    if (name !== "pnpm" && name !== "npm" && name !== "yarn") {
        return command;
    }
    const invocation = await packageManagerInvocation(name);
    if (invocation === undefined) {
        throw new Error(`Unable to locate the Node entry point for ${name}`);
    }
    return {
        executable: invocation.executable,
        args: [...invocation.argsPrefix, ...command.args],
        display:
            command.display ??
            [command.executable, ...command.args].join(" "),
    };
}

async function packageManager(root: string, declared?: unknown): Promise<string> {
    if (typeof declared === "string") {
        const name = declared.split("@")[0];
        if (name === "pnpm" || name === "npm" || name === "yarn") {
            return name;
        }
    }
    if (await exists(join(root, "pnpm-lock.yaml"))) {
        return "pnpm";
    }
    if (await exists(join(root, "yarn.lock"))) {
        return "yarn";
    }
    return "npm";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function nodeCommands(root: string): Promise<{
    commands: ValidationCommand[];
    hasTestAll: boolean;
}> {
    try {
        const parsed = JSON.parse(
            await readFile(join(root, "package.json"), "utf8"),
        ) as unknown;
        if (!isRecord(parsed) || !isRecord(parsed.scripts)) {
            return { commands: [], hasTestAll: false };
        }
        const manager = await packageManager(root, parsed.packageManager);
        const invocation = await packageManagerInvocation(manager);
        if (invocation === undefined) {
            return { commands: [], hasTestAll: false };
        }
        const scripts = parsed.scripts;
        const names = [
            ...(typeof scripts.typecheck === "string" ? ["typecheck"] : []),
            ...(typeof scripts["test:all"] === "string"
                ? ["test:all"]
                : typeof scripts.test === "string"
                  ? ["test"]
                  : []),
            ...(typeof scripts.lint === "string" ? ["lint"] : []),
        ];
        return {
            commands: names.map((name) => ({
                executable: invocation.executable,
                args: [...invocation.argsPrefix, "run", name],
                display: `${manager} run ${name}`,
            })),
            hasTestAll: names.includes("test:all"),
        };
    } catch {
        return { commands: [], hasTestAll: false };
    }
}

async function containsPythonTests(directory: string): Promise<boolean> {
    try {
        return (await readdir(directory)).some(
            (name) => name.startsWith("test_") && name.endsWith(".py"),
        );
    } catch {
        return false;
    }
}

async function pythonCommands(root: string): Promise<ValidationCommand[]> {
    const pyprojectPath = join(root, "pyproject.toml");
    const hasPytestIni = await exists(join(root, "pytest.ini"));
    const pyproject = await readFile(pyprojectPath, "utf8").catch(() => "");
    if (hasPytestIni || /\[tool\.pytest(?:\.|\])/u.test(pyproject)) {
        return [{ executable: "python", args: ["-m", "pytest"] }];
    }
    if (await containsPythonTests(join(root, "python", "tests"))) {
        return [
            {
                executable: "python",
                args: ["-m", "unittest", "discover", "-s", "python/tests", "-t", "python"],
            },
        ];
    }
    if (await containsPythonTests(join(root, "tests"))) {
        return [
            {
                executable: "python",
                args: ["-m", "unittest", "discover", "-s", "tests"],
            },
        ];
    }
    return [];
}

export async function inspectProject(root: string): Promise<ProjectInspection> {
    const node = await nodeCommands(root);
    const commands = [
        ...node.commands,
        ...(node.hasTestAll ? [] : await pythonCommands(root)),
    ];
    const seen = new Set<string>();
    return {
        validationCommands: commands.filter((command) => {
            const key = JSON.stringify([command.executable, ...command.args]);
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        }),
    };
}
