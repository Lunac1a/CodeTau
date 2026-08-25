import type { TaskSpecContract } from "../spec/types.ts";

export type ValidationCommand =
    TaskSpecContract["acceptance"]["commands"][number] &
        Readonly<{ display?: string }>;

const FORBIDDEN_OPERATOR = /[|&;<>`]/u;
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

export function parseValidationCommand(source: string): ValidationCommand {
    const trimmed = source.trim();
    if (trimmed === "" || FORBIDDEN_OPERATOR.test(trimmed)) {
        throw new Error(
            "Validation commands must be non-empty and cannot contain shell operators",
        );
    }

    const tokens: string[] = [];
    let current = "";
    let quote: "'" | '"' | undefined;
    for (const character of trimmed) {
        if (quote !== undefined) {
            if (character === quote) {
                quote = undefined;
            } else {
                current += character;
            }
            continue;
        }
        if (character === "'" || character === '"') {
            quote = character;
        } else if (/\s/u.test(character)) {
            if (current !== "") {
                tokens.push(current);
                current = "";
            }
        } else {
            current += character;
        }
    }
    if (quote !== undefined) {
        throw new Error("Validation command contains an unclosed quote");
    }
    if (current !== "") {
        tokens.push(current);
    }
    const [executable, ...args] = tokens;
    if (executable === undefined || ENVIRONMENT_ASSIGNMENT.test(executable)) {
        throw new Error("Validation command must begin with an executable");
    }
    return { executable, args };
}

export function formatValidationCommand(command: ValidationCommand): string {
    if (command.display !== undefined) {
        return command.display;
    }
    return [command.executable, ...command.args]
        .map((token) => (/\s/u.test(token) ? JSON.stringify(token) : token))
        .join(" ");
}
