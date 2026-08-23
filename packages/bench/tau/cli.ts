export type TauModelMode = "deterministic" | "lmstudio";
export type TauDomain = "mock" | "airline";
export type TauUserMode = "scripted" | "official";
export type TauEvaluationMode = "env" | "all";
export type TauPolicyVerifierMode = "off" | "model";

export type TauCliOptions = Readonly<{
    taskIds: readonly string[];
    runsPerTask: number;
    baseSeed: number;
    modelMode: TauModelMode;
    domain: TauDomain;
    userMode: TauUserMode;
    evaluation: TauEvaluationMode;
    policyVerifier: TauPolicyVerifierMode;
    model: string;
    baseUrl: string;
    userModel: string;
    userBaseUrl: string;
    outputDirectory?: string;
}>;

function integer(value: string | undefined, option: string, minimum: number): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
        throw new Error(`${option} must be an integer >= ${minimum}`);
    }
    return parsed;
}

function value(args: readonly string[], index: number, option: string): string {
    const result = args[index + 1];
    if (result === undefined || result.startsWith("--")) {
        throw new Error(`${option} requires a value`);
    }
    return result;
}

export function parseTauCliArgs(rawArgs: readonly string[]): TauCliOptions {
    const args = rawArgs.filter((argument) => argument !== "--");
    const taskIds: string[] = [];
    let runsPerTask = 1;
    let baseSeed = 42;
    let modelMode: TauModelMode = "deterministic";
    let domain: TauDomain = "mock";
    let userMode: TauUserMode = "scripted";
    let evaluation: TauEvaluationMode = "env";
    let policyVerifier: TauPolicyVerifierMode = "off";
    let model = process.env.CODETAU_MODEL ?? "qwen2.5-7b-instruct";
    let baseUrl = process.env.CODETAU_MODEL_BASE_URL ?? "http://localhost:1234/v1";
    let userModel = process.env.CODETAU_TAU_USER_MODEL ?? "";
    let userBaseUrl = process.env.CODETAU_TAU_USER_BASE_URL ?? "";
    let outputDirectory: string | undefined;

    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        if (option === "--task") {
            taskIds.push(value(args, index, option));
            index += 1;
        } else if (option === "--runs") {
            runsPerTask = integer(value(args, index, option), option, 1);
            if (runsPerTask > 100) {
                throw new Error("--runs must be <= 100");
            }
            index += 1;
        } else if (option === "--seed") {
            baseSeed = integer(value(args, index, option), option, 0);
            index += 1;
        } else if (option === "--model-mode") {
            const mode = value(args, index, option);
            if (mode !== "deterministic" && mode !== "lmstudio") {
                throw new Error("--model-mode must be deterministic or lmstudio");
            }
            modelMode = mode;
            index += 1;
        } else if (option === "--domain") {
            const selectedDomain = value(args, index, option);
            if (selectedDomain !== "mock" && selectedDomain !== "airline") {
                throw new Error("--domain must be mock or airline");
            }
            domain = selectedDomain;
            index += 1;
        } else if (option === "--user-mode") {
            const selectedMode = value(args, index, option);
            if (selectedMode !== "scripted" && selectedMode !== "official") {
                throw new Error("--user-mode must be scripted or official");
            }
            userMode = selectedMode;
            index += 1;
        } else if (option === "--evaluation") {
            const selectedEvaluation = value(args, index, option);
            if (selectedEvaluation !== "env" && selectedEvaluation !== "all") {
                throw new Error("--evaluation must be env or all");
            }
            evaluation = selectedEvaluation;
            index += 1;
        } else if (option === "--policy-verifier") {
            const selectedVerifier = value(args, index, option);
            if (selectedVerifier !== "off" && selectedVerifier !== "model") {
                throw new Error("--policy-verifier must be off or model");
            }
            policyVerifier = selectedVerifier;
            index += 1;
        } else if (option === "--model") {
            model = value(args, index, option);
            index += 1;
        } else if (option === "--base-url") {
            baseUrl = value(args, index, option);
            index += 1;
        } else if (option === "--user-model") {
            userModel = value(args, index, option);
            index += 1;
        } else if (option === "--user-base-url") {
            userBaseUrl = value(args, index, option);
            index += 1;
        } else if (option === "--output") {
            outputDirectory = value(args, index, option);
            index += 1;
        } else {
            throw new Error(`Unknown tau option: ${option}`);
        }
    }

    const selectedTasks = taskIds.length === 0 ? ["create_task_1"] : taskIds;
    if (selectedTasks.some((taskId) => !/^[A-Za-z0-9_-]+$/u.test(taskId))) {
        throw new Error("Tau task ids may contain only letters, numbers, _ and -");
    }
    if (new Set(selectedTasks).size !== selectedTasks.length) {
        throw new Error("Tau task ids must be unique");
    }
    if (userModel === "") {
        userModel = `openai/${model}`;
    }
    if (userBaseUrl === "") {
        userBaseUrl = baseUrl;
    }
    if (domain === "airline" && (userMode !== "official" || evaluation !== "all")) {
        throw new Error("Airline runs require --user-mode official and --evaluation all");
    }
    if (modelMode === "deterministic" && (domain !== "mock" || userMode !== "scripted")) {
        throw new Error("Deterministic mode supports only mock with scripted user mode");
    }
    if (policyVerifier === "model" && modelMode !== "lmstudio") {
        throw new Error("Model policy verifier requires LM Studio model mode");
    }
    return {
        taskIds: selectedTasks,
        runsPerTask,
        baseSeed,
        modelMode,
        domain,
        userMode,
        evaluation,
        policyVerifier,
        model,
        baseUrl,
        userModel,
        userBaseUrl,
        ...(outputDirectory === undefined ? {} : { outputDirectory }),
    };
}
