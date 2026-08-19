import assert from "node:assert/strict";
import test from "node:test";

import { applyStructuredEdits } from "../src/workspace/patch.ts";

test("applies ordered exact-text edits", () => {
    assert.deepEqual(
        applyStructuredEdits("const answer = 41;\nconsole.log(answer);\n", [
            { oldText: "answer = 41", newText: "answer = 42" },
            { oldText: "console.log(answer)", newText: "return answer" },
        ]),
        {
            ok: true,
            content: "const answer = 42;\nreturn answer;\n",
            editsApplied: 2,
        },
    );
});

test("rejects missing and ambiguous patch context", () => {
    assert.deepEqual(
        applyStructuredEdits("const value = 1;", [
            { oldText: "const missing = 1;", newText: "const missing = 2;" },
        ]),
        {
            ok: false,
            error: {
                code: "patch_context_missing",
                message: "Edit 0 oldText was not found",
                editIndex: 0,
            },
        },
    );
    assert.equal(
        applyStructuredEdits("value + value", [
            { oldText: "value", newText: "answer" },
        ]).ok,
        false,
    );
});

test("rejects empty and no-op edits", () => {
    assert.equal(applyStructuredEdits("text", []).ok, false);
    assert.equal(
        applyStructuredEdits("text", [{ oldText: "", newText: "new" }]).ok,
        false,
    );
    assert.equal(
        applyStructuredEdits("text", [{ oldText: "text", newText: "text" }]).ok,
        false,
    );
});
