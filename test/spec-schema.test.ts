import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("task spec schema is valid JSON and closes unknown fields", async () => {
    const schemaUrl = new URL("../specs/schema.json", import.meta.url);
    const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as {
        additionalProperties?: boolean;
        required?: string[];
    };

    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, [
        "version",
        "id",
        "goal",
        "workspace",
        "policy",
        "acceptance",
        "phases",
        "budget",
    ]);
});
