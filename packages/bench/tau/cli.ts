export type TauModelMode = "deterministic" | "lmstudio";

export type TauCliOptions = Readonly<{
    taskIds: readonly string[];
    runsPerTask: number;
    baseSeed: number;
    modelMode: TauModelMode;
    model: string;
    baseUrl: string;
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
    let model = process.env.CODETAU_MODEL ?? "qwen2.5-7b-instruct";
    let baseUrl = process.env.CODETAU_MODEL_BASE_URL ?? "http://localhost:1234/v1";
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
        } else if (option === "--model") {
            model = value(args, index, option);
            index += 1;
        } else if (option === "--base-url") {
            baseUrl = value(args, index, option);
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
    return {
        taskIds: selectedTasks,
        runsPerTask,
        baseSeed,
        modelMode,
        model,
        baseUrl,
        ...(outputDirectory === undefined ? {} : { outputDirectory }),
    };
}
