export type AgentLoopErrorCode =
    | "session_already_exists"
    | "session_not_found"
    | "session_terminal"
    | "session_spec_mismatch"
    | "session_state_unsupported";

export class AgentLoopError extends Error {
    readonly code: AgentLoopErrorCode;
    readonly sessionId: string;

    constructor(options: {
        code: AgentLoopErrorCode;
        message: string;
        sessionId: string;
    }) {
        super(options.message);
        this.name = "AgentLoopError";
        this.code = options.code;
        this.sessionId = options.sessionId;
    }
}
