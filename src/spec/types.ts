export type ApprovalResponse = "allow-once" | "allow-session" | "deny";

export type TaskSpecContract = {
    version: 1;
    id: string;
    goal: string;
    workspace: {
        root: string;
        allowedPaths: string[];
        deniedPaths?: string[];
    };
    policy: {
        forbiddenActions: string[];
    };
    acceptance: {
        commands: Array<{
            executable: string;
            args: string[];
        }>;
        assertions: string[];
    };
    phases: Array<{
        id: string;
        description: string;
    }>;
    budget: {
        maxModelTurns: number;
        maxToolCalls: number;
        maxRetries: number;
    };
    userInteraction: {
        allowQuestions: boolean;
        approvalResponses: ApprovalResponse[];
    };
    hiddenAssertionsRef?: string;
};

export type SpecSnapshot = {
    contract: TaskSpecContract;
    context: string;
};

export type LoadedSpec = {
    sourcePath: string;
    origin?: "file" | "generated";
    contract: TaskSpecContract;
    context: string;
    digest: string;
};
