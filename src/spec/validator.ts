import { readFile } from "node:fs/promises";

import {
    Ajv2020,
    type ErrorObject,
    type ValidateFunction,
} from "ajv/dist/2020.js";

import { SpecLoadError, type SpecValidationIssue } from "./errors.ts";
import type { TaskSpecContract } from "./types.ts";

let validatorPromise: Promise<ValidateFunction<TaskSpecContract>> | undefined;

async function createValidator(): Promise<ValidateFunction<TaskSpecContract>> {
    const schemaUrl = new URL("../../specs/schema.json", import.meta.url);
    const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true });

    return ajv.compile<TaskSpecContract>(schema);
}

function getValidator(): Promise<ValidateFunction<TaskSpecContract>> {
    validatorPromise ??= createValidator();
    return validatorPromise;
}

function issuePath(error: ErrorObject): string {
    if (error.keyword === "required") {
        const missingProperty = (error.params as { missingProperty: string }).missingProperty;
        return `${error.instancePath}/${missingProperty}` || "/";
    }

    if (error.keyword === "additionalProperties") {
        const additionalProperty = (error.params as { additionalProperty: string })
            .additionalProperty;
        return `${error.instancePath}/${additionalProperty}` || "/";
    }

    return error.instancePath || "/";
}

function toIssue(error: ErrorObject): SpecValidationIssue {
    return {
        path: issuePath(error),
        message: error.message ?? "is invalid",
        keyword: error.keyword,
    };
}

export async function validateSpecContract(
    value: unknown,
    sourcePath: string,
): Promise<TaskSpecContract> {
    const validate = await getValidator();

    if (!validate(value)) {
        const issues = (validate.errors ?? []).map(toIssue);
        throw new SpecLoadError({
            code: "spec_schema_invalid",
            message: `Spec contract failed schema validation (${issues.length} issue${issues.length === 1 ? "" : "s"})`,
            sourcePath,
            issues,
        });
    }

    return value;
}
