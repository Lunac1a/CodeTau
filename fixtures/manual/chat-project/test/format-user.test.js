import assert from "node:assert/strict";
import test from "node:test";

import { formatUser } from "../src/format-user.js";

const user = {
    id: 1,
    name: "Ada",
    email: "ada@example.com",
};

test("formats a user for display", () => {
    assert.equal(formatUser(user), "1: Ada <ada@example.com>");
});
