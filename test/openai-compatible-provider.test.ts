import assert from "node:assert/strict";
import test from "node:test";

import type { ModelRequest } from "../src/model.ts";
import { ModelProviderError } from "../src/providers/errors.ts";
import {
    OpenAICompatibleModelProvider,
    type OpenAICompatibleModelProviderOptions,
} from "../src/providers/openai-compatible.ts";

type FetchLike = NonNullable<OpenAICompatibleModelProviderOptions["fetch"]>;

const baseRequest: ModelRequest = {
    messages: [
        { role: "system", content: "Work inside the repository." },
        { role: "user", content: "Read package.json." },
    ],
    availableTools: [
        {
            name: "read_file",
            description: "Read a workspace file.",
            inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
            },
        },
    ],
};

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function completion(message: unknown, usage: unknown = undefined): unknown {
    return {
        choices: [{ message }],
        ...(usage === undefined ? {} : { usage }),
    };
}

test("serializes OpenAI-compatible messages and maps a text response", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetch: FetchLike = async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return jsonResponse(
            completion(
                { role: "assistant", content: "I will inspect the file." },
                { prompt_tokens: 21, completion_tokens: 7 },
            ),
        );
    };
    const provider = new OpenAICompatibleModelProvider({
        baseUrl: "http://localhost:1234/v1/",
        model: "qwen2.5-7b-instruct",
        fetch,
    });

    const response = await provider.generate(baseRequest);
    const requestBody = JSON.parse(String(capturedInit?.body)) as {
        model: string;
        messages: unknown[];
        tools: Array<{ function: { name: string } }>;
        tool_choice: string;
    };

    assert.equal(capturedUrl, "http://localhost:1234/v1/chat/completions");
    assert.equal(requestBody.model, "qwen2.5-7b-instruct");
    assert.deepEqual(requestBody.messages, baseRequest.messages);
    assert.deepEqual(
        requestBody.tools.map((tool) => tool.function.name),
        ["read_file", "finish_task"],
    );
    assert.equal(requestBody.tool_choice, "auto");
    assert.deepEqual(response, {
        kind: "text",
        text: "I will inspect the file.",
        usage: { inputTokens: 21, outputTokens: 7 },
    });
});

test("serializes assistant tool calls before their tool results", async () => {
    let capturedBody = "";
    const fetch: FetchLike = async (_input, init) => {
        capturedBody = String(init?.body);
        return jsonResponse(completion({ role: "assistant", content: "Done." }));
    };
    const provider = new OpenAICompatibleModelProvider({
        baseUrl: "http://localhost:1234/v1",
        model: "qwen2.5-7b-instruct",
        fetch,
    });

    await provider.generate({
        messages: [
            ...baseRequest.messages,
            {
                role: "assistant",
                content: null,
                toolCalls: [
                    {
                        id: "call-1",
                        name: "read_file",
                        input: { path: "package.json" },
                    },
                ],
            },
            {
                role: "tool",
                toolCallId: "call-1",
                content: '{"ok":true}',
            },
        ],
        availableTools: baseRequest.availableTools,
    });
    const body = JSON.parse(capturedBody) as {
        messages: Array<Record<string, unknown>>;
    };

    assert.deepEqual(body.messages.at(-2), {
        role: "assistant",
        content: null,
        tool_calls: [
            {
                id: "call-1",
                type: "function",
                function: {
                    name: "read_file",
                    arguments: '{"path":"package.json"}',
                },
            },
        ],
    });
    assert.deepEqual(body.messages.at(-1), {
        role: "tool",
        tool_call_id: "call-1",
        content: '{"ok":true}',
    });
});

test("maps standard function calls to Agent tool calls", async () => {
    const fetch: FetchLike = async () =>
        jsonResponse(
            completion(
                {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                        {
                            id: "call-read",
                            type: "function",
                            function: {
                                name: "read_file",
                                arguments: '{"path":"README.md"}',
                            },
                        },
                    ],
                },
                { prompt_tokens: 30, completion_tokens: 12 },
            ),
        );
    const provider = new OpenAICompatibleModelProvider({
        baseUrl: "http://localhost:1234/v1",
        model: "qwen2.5-7b-instruct",
        fetch,
    });

    assert.deepEqual(await provider.generate(baseRequest), {
        kind: "tool_calls",
        calls: [
            {
                id: "call-read",
                name: "read_file",
                input: { path: "README.md" },
            },
        ],
        usage: { inputTokens: 30, outputTokens: 12 },
    });
});

test("maps the reserved finish_task function to a terminal response", async () => {
    const fetch: FetchLike = async () =>
        jsonResponse(
            completion({
                role: "assistant",
                content: "",
                tool_calls: [
                    {
                        id: "call-finish",
                        type: "function",
                        function: {
                            name: "finish_task",
                            arguments:
                                '{"outcome":"blocked","message":"Need user input."}',
                        },
                    },
                ],
            }),
        );
    const provider = new OpenAICompatibleModelProvider({
        baseUrl: "http://localhost:1234/v1",
        model: "qwen2.5-7b-instruct",
        fetch,
    });

    assert.deepEqual(await provider.generate(baseRequest), {
        kind: "finish",
        outcome: "blocked",
        message: "Need user input.",
        usage: { inputTokens: 0, outputTokens: 0 },
    });
});

test("rejects malformed tool arguments", async () => {
    const fetch: FetchLike = async () =>
        jsonResponse(
            completion({
                role: "assistant",
                content: "",
                tool_calls: [
                    {
                        id: "bad-call",
                        type: "function",
                        function: {
                            name: "read_file",
                            arguments: "{not-json",
                        },
                    },
                ],
            }),
        );
    const provider = new OpenAICompatibleModelProvider({
        baseUrl: "http://localhost:1234/v1",
        model: "qwen2.5-7b-instruct",
        fetch,
    });

    await assert.rejects(provider.generate(baseRequest), (error: unknown) => {
        assert.ok(error instanceof ModelProviderError);
        assert.equal(error.code, "invalid_tool_call");
        assert.match(error.message, /valid JSON/);
        return true;
    });
});

test("reports model-server HTTP failures without treating them as model text", async () => {
    const fetch: FetchLike = async () =>
        new Response("model failed to load", { status: 503 });
    const provider = new OpenAICompatibleModelProvider({
        baseUrl: "http://localhost:1234/v1",
        model: "qwen2.5-7b-instruct",
        fetch,
    });

    await assert.rejects(provider.generate(baseRequest), (error: unknown) => {
        assert.ok(error instanceof ModelProviderError);
        assert.equal(error.code, "http_error");
        assert.equal(error.status, 503);
        assert.match(error.message, /model failed to load/);
        return true;
    });
});

test("validates provider configuration before making a request", () => {
    assert.throws(
        () =>
            new OpenAICompatibleModelProvider({
                baseUrl: "localhost:1234/v1",
                model: "qwen2.5-7b-instruct",
            }),
        (error: unknown) => {
            assert.ok(error instanceof ModelProviderError);
            assert.equal(error.code, "invalid_configuration");
            return true;
        },
    );
});
