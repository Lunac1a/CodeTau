import { readFileSync } from "node:fs";

import {
    Ajv2020,
    type ErrorObject,
    type ValidateFunction,
} from "ajv/dist/2020.js";

import type { AgentEvent } from "./types.ts";

export type EventValidationIssue = {
    path: string;
    message: string;
    keyword: string;
};

export class EventValidationError extends Error {
    readonly code = "event_schema_invalid";
    readonly issues: readonly EventValidationIssue[];

    constructor(message: string, issues: readonly EventValidationIssue[]) {
        super(message);
        this.name = "EventValidationError";
        this.issues = issues;
    }
}

let validator: ValidateFunction<AgentEvent> | undefined;

function getValidator(): ValidateFunction<AgentEvent> {
    if (validator !== undefined) {
        return validator;
    }

    const specSchema = JSON.parse(
        readFileSync(new URL("../specs/schema.json", import.meta.url), "utf8"),
    ) as object;
    const eventSchema = JSON.parse(
        readFileSync(new URL("../specs/event.schema.json", import.meta.url), "utf8"),
    ) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addSchema(specSchema);
    validator = ajv.compile<AgentEvent>(eventSchema);
    return validator;
}

function issuePath(error: ErrorObject): string {
    if (error.keyword === "required") {
        const missing = (error.params as { missingProperty: string }).missingProperty;
        return `${error.instancePath}/${missing}` || "/";
    }
    if (error.keyword === "additionalProperties") {
        const additional = (error.params as { additionalProperty: string })
            .additionalProperty;
        return `${error.instancePath}/${additional}` || "/";
    }
    if (error.keyword === "unevaluatedProperties") {
        const unevaluated = (error.params as { unevaluatedProperty: string })
            .unevaluatedProperty;
        return `${error.instancePath}/${unevaluated}` || "/";
    }
    return error.instancePath || "/";
}

function escapeJsonPointer(segment: string): string {
    return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function findNonJsonValue(
    value: unknown,
    path: string,
    ancestors: Set<object>,
    depth: number,
): EventValidationIssue | undefined {
    if (depth > 100) {
        return { path, message: "exceeds maximum JSON nesting depth", keyword: "jsonDepth" };
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return undefined;
    }
    if (typeof value === "number") {
        return Number.isFinite(value)
            ? undefined
            : { path, message: "must be a finite JSON number", keyword: "jsonNumber" };
    }
    if (typeof value !== "object") {
        return {
            path,
            message: `contains non-JSON value of type ${typeof value}`,
            keyword: "jsonType",
        };
    }
    if (ancestors.has(value)) {
        return { path, message: "contains a circular reference", keyword: "jsonCycle" };
    }

    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index += 1) {
                const itemPath = `${path}/${index}`;
                if (!(index in value)) {
                    return {
                        path: itemPath,
                        message: "contains a sparse array slot",
                        keyword: "jsonSparseArray",
                    };
                }
                const issue = findNonJsonValue(value[index], itemPath, ancestors, depth + 1);
                if (issue !== undefined) {
                    return issue;
                }
            }
            return undefined;
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            return {
                path,
                message: "must contain only plain JSON objects",
                keyword: "jsonObject",
            };
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
            return {
                path,
                message: "contains symbol-keyed properties",
                keyword: "jsonSymbolKey",
            };
        }

        for (const [key, child] of Object.entries(value)) {
            const childPath = `${path}/${escapeJsonPointer(key)}`;
            const issue = findNonJsonValue(child, childPath, ancestors, depth + 1);
            if (issue !== undefined) {
                return issue;
            }
        }
        return undefined;
    } finally {
        ancestors.delete(value);
    }
}

export function validateAgentEvent(value: unknown): AgentEvent {
    const jsonIssue = findNonJsonValue(value, "", new Set<object>(), 0);
    if (jsonIssue !== undefined) {
        throw new EventValidationError("Event is not JSON-safe", [jsonIssue]);
    }

    const validate = getValidator();
    if (!validate(value)) {
        const issues = (validate.errors ?? []).map((error) => ({
            path: issuePath(error),
            message: error.message ?? "is invalid",
            keyword: error.keyword,
        }));
        throw new EventValidationError(
            `Event failed schema validation (${issues.length} issue${issues.length === 1 ? "" : "s"})`,
            issues,
        );
    }

    return value;
}
