export type CliCommand = {
    readonly kind: "status";
    readonly sessionId: string;
};

const usage = "Usage: codetau status <session-id>";

export function parseCliArgs(argv: readonly string[]): CliCommand {
    const [command, sessionId, extraArgument] = argv;

    if (
        command === "status" &&
        sessionId !== undefined &&
        sessionId.trim() !== "" &&
        extraArgument === undefined
    ) {
        return {
            kind: "status",
            sessionId,
        };
    }

    throw new Error(usage);
}
