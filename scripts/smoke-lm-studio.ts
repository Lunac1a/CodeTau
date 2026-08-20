import { OpenAICompatibleModelProvider } from "../src/providers/openai-compatible.ts";

const baseUrl =
    process.env.CODETAU_MODEL_BASE_URL ?? "http://localhost:1234/v1";
const model = process.env.CODETAU_MODEL ?? "qwen2.5-7b-instruct";

const provider = new OpenAICompatibleModelProvider({ baseUrl, model });
const availableTools = [
    {
        name: "get_project_name",
        description: "Return the name of the current project.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: [],
        },
    },
] as const;
const initialMessages = [
    {
        role: "system" as const,
        content:
            "This is a connection test. Call get_project_name before answering. Do not finish the task.",
    },
    {
        role: "user" as const,
        content: "What is the project name?",
    },
];

const toolRequest = await provider.generate({
    messages: initialMessages,
    availableTools,
});
if (toolRequest.kind !== "tool_calls" || toolRequest.calls.length !== 1) {
    throw new Error("LM Studio did not return one structured tool call");
}
const call = toolRequest.calls[0];
if (call.name !== "get_project_name") {
    throw new Error(`LM Studio requested an unexpected tool: ${call.name}`);
}

const finalResponse = await provider.generate({
    messages: [
        ...initialMessages,
        {
            role: "assistant",
            content: null,
            toolCalls: toolRequest.calls,
        },
        {
            role: "tool",
            toolCallId: call.id,
            content: '{"projectName":"CodeTau"}',
        },
    ],
    availableTools,
});
if (
    finalResponse.kind !== "text" ||
    !finalResponse.text.toLowerCase().includes("codetau")
) {
    throw new Error("LM Studio did not use the returned tool result");
}

process.stdout.write(
    `${JSON.stringify(
        {
            ok: true,
            baseUrl,
            model,
            toolCall: call,
            finalText: finalResponse.text,
        },
        null,
        2,
    )}\n`,
);
