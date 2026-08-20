import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { BenchManifest, BenchTask } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTask(value: unknown, index: number): BenchTask {
    if (!isRecord(value)) {
        throw new Error(`Bench task ${index} must be an object`);
    }
    const keys = Object.keys(value);
    if (keys.some((key) => key !== "id" && key !== "specPath")) {
        throw new Error(`Bench task ${index} contains an unknown field`);
    }
    if (
        typeof value.id !== "string" ||
        !/^[a-z][a-z0-9_-]*$/u.test(value.id)
    ) {
        throw new Error(`Bench task ${index} has an invalid id`);
    }
    if (typeof value.specPath !== "string" || value.specPath.trim() === "") {
        throw new Error(`Bench task ${index} has an invalid specPath`);
    }
    return { id: value.id, specPath: value.specPath };
}

export async function loadBenchManifest(path: string): Promise<BenchManifest> {
    const sourcePath = resolve(path);
    let value: unknown;
    try {
        value = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
    } catch (error) {
        throw new Error(`Unable to read Bench manifest: ${sourcePath}`, {
            cause: error,
        });
    }
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tasks)) {
        throw new Error("Bench manifest must contain version 1 and a tasks array");
    }
    if (value.tasks.length === 0) {
        throw new Error("Bench manifest must contain at least one task");
    }
    const tasks = value.tasks.map(parseTask);
    if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
        throw new Error("Bench task ids must be unique");
    }
    return { version: 1, tasks };
}
