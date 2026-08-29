import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigLoadError } from "../src/config/errors.ts";
import { loadCodeTauConfig } from "../src/config/loader.ts";

test("loads configuration and resolves its database from the config directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-config-"));
    const path = join(directory, "codetau.config.json");
    try {
        await writeFile(
            path,
            JSON.stringify({
                database: ".codetau/session.db",
                model: "qwen2.5-7b-instruct",
                baseUrl: "http://localhost:1234/v1",
                commandAllowlist: ["node"],
                commandTimeoutMs: 2_000,
                maxOutputBytes: 10_000,
            }),
            "utf8",
        );

        const config = await loadCodeTauConfig(path);

        assert.equal(config.rootDirectory, directory);
        assert.equal(config.databasePath, join(directory, ".codetau", "session.db"));
        assert.equal(config.model, "qwen2.5-7b-instruct");
        assert.deepEqual(config.contextManagement, {
            maxContextTokens: 16_384,
            reservedOutputTokens: 2_048,
            safetyMarginPercent: 10,
            recentConversationTurns: 4,
            recentToolExchanges: 6,
            maxSummaryTokens: 1_200,
            maxToolResultTokens: 2_048,
        });
        assert.deepEqual(config.naturalLanguage, {
            maxModelTurns: 20,
            maxToolCalls: 60,
            maxRetries: 3,
            additionalProtectedPaths: [],
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("loads and validates context-management overrides", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-config-context-"));
    const path = join(directory, "codetau.config.json");
    const base = {
        database: "db.sqlite",
        model: "model",
        baseUrl: "http://localhost:1234/v1",
        commandAllowlist: ["node"],
        commandTimeoutMs: 1000,
        maxOutputBytes: 1000,
    };
    try {
        await writeFile(
            path,
            JSON.stringify({
                ...base,
                contextManagement: {
                    maxContextTokens: 8_192,
                    reservedOutputTokens: 1_024,
                },
            }),
            "utf8",
        );
        const config = await loadCodeTauConfig(path);
        assert.equal(config.contextManagement.maxContextTokens, 8_192);
        assert.equal(config.contextManagement.reservedOutputTokens, 1_024);
        assert.equal(config.contextManagement.recentConversationTurns, 4);

        await writeFile(
            path,
            JSON.stringify({
                ...base,
                contextManagement: {
                    maxContextTokens: 1_000,
                    reservedOutputTokens: 1_000,
                },
            }),
            "utf8",
        );
        await assert.rejects(loadCodeTauConfig(path), ConfigLoadError);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("loads natural-language task defaults from configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-config-natural-"));
    const path = join(directory, "codetau.config.json");
    try {
        await writeFile(
            path,
            JSON.stringify({
                database: "db.sqlite",
                model: "model",
                baseUrl: "http://localhost:1234/v1",
                commandAllowlist: ["node"],
                commandTimeoutMs: 1000,
                maxOutputBytes: 1000,
                naturalLanguage: {
                    maxModelTurns: 8,
                    maxToolCalls: 12,
                    maxRetries: 1,
                    additionalProtectedPaths: ["secrets/**"],
                },
            }),
            "utf8",
        );
        const config = await loadCodeTauConfig(path);
        assert.deepEqual(config.naturalLanguage, {
            maxModelTurns: 8,
            maxToolCalls: 12,
            maxRetries: 1,
            additionalProtectedPaths: ["secrets/**"],
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("rejects unknown or invalid configuration fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codetau-config-invalid-"));
    const path = join(directory, "codetau.config.json");
    try {
        await writeFile(
            path,
            JSON.stringify({
                database: "db.sqlite",
                model: "model",
                baseUrl: "http://localhost:1234/v1",
                commandAllowlist: [],
                commandTimeoutMs: 0,
                maxOutputBytes: 10,
                surprise: true,
            }),
            "utf8",
        );

        await assert.rejects(loadCodeTauConfig(path), (error: unknown) => {
            assert.ok(error instanceof ConfigLoadError);
            assert.equal(error.code, "config_shape_invalid");
            return true;
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
