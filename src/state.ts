import type { TaskStatus } from "./types.ts";

const allowedTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
    created: ["analyzing", "failed"],

    analyzing: [
        "awaiting_approval",
        "editing",
        "validating",
        "failed",
        "blocked",
    ],

    awaiting_approval: [
        "analyzing",
        "editing",
        "failed",
        "blocked",
    ],

    editing: [
        "analyzing",
        "awaiting_approval",
        "validating",
        "failed",
        "blocked",
    ],

    validating: [
        "editing",
        "completed",
        "failed",
        "blocked",
    ],

    completed: [],
    failed: [],
    blocked: [],
};

export function canTransition(
    from: TaskStatus,
    to: TaskStatus,
): boolean {
    return allowedTransitions[from].includes(to);
}

export function assertTransition(
    from: TaskStatus,
    to: TaskStatus,
): void {
    if (!canTransition(from, to)) {
        throw new InvalidTaskTransitionError(from, to);
    }
}

export class InvalidTaskTransitionError extends Error {
    readonly code = "invalid_task_transition";
    readonly from: TaskStatus;
    readonly to: TaskStatus;

    constructor(from: TaskStatus, to: TaskStatus) {
        super(`Invalid task transition: ${from} -> ${to}`);
        this.name = "InvalidTaskTransitionError";
        this.from = from;
        this.to = to;
    }
}
