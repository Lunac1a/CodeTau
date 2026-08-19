import { createHash } from "node:crypto";

import type { SpecSnapshot, TaskSpecContract } from "./types.ts";

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
        .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
        .join(",")}}`;
}

export function createSpecSnapshot(
    contract: TaskSpecContract,
    context: string,
): SpecSnapshot {
    return structuredClone({ contract, context });
}

export function computeSpecDigest(snapshot: SpecSnapshot): string {
    return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}
