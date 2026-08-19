import { assertTransition, InvalidTaskTransitionError } from "./state.ts";
import { computeSpecDigest } from "./spec/digest.ts";
import type { AgentEvent, TaskStatus } from "./types.ts";

export type TerminalStatus = "completed" | "failed" | "blocked";

export type TaskState = Readonly<{
    sessionId: string;
    specId: string;
    specPath: string;
    specDigest: string;
    status: TaskStatus;
    revision: number;
    lastSequence: number;
    lastEventId: string;
    pendingApproval?: Readonly<{
        toolCallId: string;
        toolName: string;
    }>;
    final?: Readonly<{
        status: TerminalStatus;
        message: string;
    }>;
}>;

export type EventReplayErrorCode =
    | "event_stream_empty"
    | "event_sequence_invalid"
    | "event_id_duplicate"
    | "event_first_invalid"
    | "event_session_mismatch"
    | "event_session_restarted"
    | "session_spec_digest_invalid"
    | "event_after_final"
    | "event_after_terminal_state"
    | "state_source_invalid"
    | "state_reason_missing"
    | "state_from_mismatch"
    | "state_transition_invalid"
    | "approval_source_invalid"
    | "approval_state_invalid"
    | "approval_call_mismatch"
    | "final_state_mismatch"
    | "final_message_missing";

export class EventReplayError extends Error {
    readonly code: EventReplayErrorCode;
    readonly eventId?: string;
    readonly sequence?: number;

    constructor(options: {
        code: EventReplayErrorCode;
        message: string;
        event?: AgentEvent;
        cause?: unknown;
    }) {
        super(options.message, { cause: options.cause });
        this.name = "EventReplayError";
        this.code = options.code;
        this.eventId = options.event?.id;
        this.sequence = options.event?.sequence;
    }
}

function freezeState(state: TaskState): TaskState {
    if (state.pendingApproval !== undefined) {
        Object.freeze(state.pendingApproval);
    }
    if (state.final !== undefined) {
        Object.freeze(state.final);
    }
    return Object.freeze(state);
}

function advanceState(
    state: TaskState,
    event: AgentEvent,
    changes: Partial<TaskState> = {},
): TaskState {
    const nextState = {
        ...state,
        ...changes,
        lastSequence: event.sequence,
        lastEventId: event.id,
    };
    if (nextState.pendingApproval === undefined) {
        delete nextState.pendingApproval;
    }
    return freezeState(nextState);
}

function applyStateChange(
    state: TaskState,
    event: Extract<AgentEvent, { type: "state_changed" }>,
    priorEvents: ReadonlyMap<string, AgentEvent>,
): TaskState {
    const sourceEvent = priorEvents.get(event.sourceEventId);
    if (sourceEvent === undefined) {
        throw new EventReplayError({
            code: "state_source_invalid",
            message: `State change source must reference an earlier event: ${event.sourceEventId}`,
            event,
        });
    }

    if (event.reason.trim() === "") {
        throw new EventReplayError({
            code: "state_reason_missing",
            message: "State change reason must not be empty",
            event,
        });
    }

    if (event.from !== state.status) {
        throw new EventReplayError({
            code: "state_from_mismatch",
            message: `State event expected ${event.from}, but replay state is ${state.status}`,
            event,
        });
    }

    try {
        assertTransition(event.from, event.to);
    } catch (error) {
        if (error instanceof InvalidTaskTransitionError) {
            throw new EventReplayError({
                code: "state_transition_invalid",
                message: error.message,
                event,
                cause: error,
            });
        }
        throw error;
    }

    const changes: {
        status: TaskStatus;
        revision: number;
        pendingApproval?: TaskState["pendingApproval"];
    } = {
        status: event.to,
        revision: state.revision + 1,
    };
    if (event.to === "awaiting_approval") {
        if (sourceEvent.type !== "model_tool_call") {
            throw new EventReplayError({
                code: "approval_source_invalid",
                message: "Approval state must reference a model_tool_call event",
                event,
            });
        }
        changes.pendingApproval = {
            toolCallId: sourceEvent.toolCall.id,
            toolName: sourceEvent.toolCall.name,
        };
    } else if (state.pendingApproval !== undefined) {
        changes.pendingApproval = undefined;
    }

    return advanceState(state, event, changes);
}

function applyApprovalResolved(
    state: TaskState,
    event: Extract<AgentEvent, { type: "approval_resolved" }>,
): TaskState {
    if (state.status !== "awaiting_approval" || state.pendingApproval === undefined) {
        throw new EventReplayError({
            code: "approval_state_invalid",
            message: "An approval can only be resolved while approval is pending",
            event,
        });
    }
    if (event.toolCallId !== state.pendingApproval.toolCallId) {
        throw new EventReplayError({
            code: "approval_call_mismatch",
            message: `Approval resolved ${event.toolCallId}, expected ${state.pendingApproval.toolCallId}`,
            event,
        });
    }
    return advanceState(state, event);
}

function applyFinalEvent(
    state: TaskState,
    event: Extract<AgentEvent, { type: "final" }>,
): TaskState {
    if (event.status !== state.status) {
        throw new EventReplayError({
            code: "final_state_mismatch",
            message: `Final event says ${event.status}, but replay state is ${state.status}`,
            event,
        });
    }

    if (event.message.trim() === "") {
        throw new EventReplayError({
            code: "final_message_missing",
            message: "Final event message must not be empty",
            event,
        });
    }

    return advanceState(state, event, {
        final: {
            status: event.status,
            message: event.message,
        },
    });
}

export function rebuildTaskState(events: readonly AgentEvent[]): TaskState {
    if (events.length === 0) {
        throw new EventReplayError({
            code: "event_stream_empty",
            message: "Cannot rebuild task state from an empty event stream",
        });
    }

    const first = events[0];
    if (first.type !== "session_started") {
        throw new EventReplayError({
            code: "event_first_invalid",
            message: "The first event must be session_started",
            event: first,
        });
    }

    const computedSpecDigest = computeSpecDigest(first.specSnapshot);
    if (computedSpecDigest !== first.specDigest) {
        throw new EventReplayError({
            code: "session_spec_digest_invalid",
            message: "Session Spec snapshot does not match its recorded digest",
            event: first,
        });
    }

    let state = freezeState({
        sessionId: first.sessionId,
        specId: first.specId,
        specPath: first.specPath,
        specDigest: first.specDigest,
        status: "created",
        revision: 0,
        lastSequence: first.sequence,
        lastEventId: first.id,
    });
    const eventsById = new Map<string, AgentEvent>();

    for (const [index, event] of events.entries()) {
        const expectedSequence = index + 1;

        if (event.sequence !== expectedSequence) {
            throw new EventReplayError({
                code: "event_sequence_invalid",
                message: `Expected event sequence ${expectedSequence}, received ${event.sequence}`,
                event,
            });
        }

        if (eventsById.has(event.id)) {
            throw new EventReplayError({
                code: "event_id_duplicate",
                message: `Duplicate event id: ${event.id}`,
                event,
            });
        }

        if (event.sessionId !== first.sessionId) {
            throw new EventReplayError({
                code: "event_session_mismatch",
                message: `Event belongs to session ${event.sessionId}, expected ${first.sessionId}`,
                event,
            });
        }

        if (index === 0) {
            eventsById.set(event.id, event);
            continue;
        }

        if (event.type === "session_started") {
            throw new EventReplayError({
                code: "event_session_restarted",
                message: "A session_started event may only appear first",
                event,
            });
        }

        if (state.final !== undefined) {
            throw new EventReplayError({
                code: "event_after_final",
                message: "No events are allowed after the final event",
                event,
            });
        }

        const isTerminal =
            state.status === "completed" ||
            state.status === "failed" ||
            state.status === "blocked";
        if (isTerminal && event.type !== "final") {
            throw new EventReplayError({
                code: "event_after_terminal_state",
                message: "A terminal state change must be followed by a final event",
                event,
            });
        }

        if (event.type === "state_changed") {
            state = applyStateChange(state, event, eventsById);
        } else if (event.type === "approval_resolved") {
            state = applyApprovalResolved(state, event);
        } else if (event.type === "final") {
            state = applyFinalEvent(state, event);
        } else {
            state = advanceState(state, event);
        }

        eventsById.set(event.id, event);
    }

    return state;
}
