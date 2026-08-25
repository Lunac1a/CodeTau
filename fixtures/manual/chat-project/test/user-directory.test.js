import assert from "node:assert/strict";
import test from "node:test";

import { UserDirectory } from "../src/user-directory.js";

test("normalizes a registered email", () => {
    const directory = new UserDirectory();

    const user = directory.register({
        name: "  Ada Lovelace  ",
        email: "  Ada@Example.COM  ",
    });

    assert.deepEqual(user, {
        id: 1,
        name: "Ada Lovelace",
        email: "ada@example.com",
    });
});

test("rejects the same email with different casing", () => {
    const directory = new UserDirectory();
    directory.register({ name: "Ada", email: "Ada@Example.com" });

    assert.throws(
        () => directory.register({ name: "Another Ada", email: "ada@example.com" }),
        /already registered/u,
    );
});

test("returns defensive copies from list", () => {
    const directory = new UserDirectory();
    directory.register({ name: "Ada", email: "ada@example.com" });

    const users = directory.list();
    users[0].name = "Changed outside";

    assert.equal(directory.list()[0].name, "Ada");
});

test("rejects invalid registration fields", () => {
    const directory = new UserDirectory();

    assert.throws(
        () => directory.register({ name: "   ", email: "ada@example.com" }),
        /Name is required/u,
    );
    assert.throws(
        () => directory.register({ name: "Ada", email: "not-an-email" }),
        /Email is invalid/u,
    );
});
