import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseDocument } from "yaml";

import { SpecLoadError } from "./errors.ts";
import type { LoadedSpec } from "./types.ts";
import { validateSpecContract } from "./validator.ts";

type DocumentParts = {
    frontmatter: string;
    context: string;
};

function splitDocument(source: string, sourcePath: string): DocumentParts {
    const withoutBom = source.startsWith("\uFEFF") ? source.slice(1) : source;
    const opening = /^---[ \t]*\r?\n/.exec(withoutBom);

    if (opening === null) {
        throw new SpecLoadError({
            code: "spec_frontmatter_missing",
            message: "Spec must begin with a YAML frontmatter delimiter (---)",
            sourcePath,
        });
    }

    const afterOpening = withoutBom.slice(opening[0].length);
    const closing = /^---[ \t]*\r?$/m.exec(afterOpening);

    if (closing === null) {
        throw new SpecLoadError({
            code: "spec_frontmatter_missing",
            message: "Spec YAML frontmatter is missing its closing delimiter (---)",
            sourcePath,
        });
    }

    const frontmatter = afterOpening.slice(0, closing.index);
    let contextStart = closing.index + closing[0].length;

    if (afterOpening.startsWith("\r\n", contextStart)) {
        contextStart += 2;
    } else if (afterOpening.startsWith("\n", contextStart)) {
        contextStart += 1;
    }

    return {
        frontmatter,
        context: afterOpening.slice(contextStart),
    };
}

export async function parseSpecText(
    source: string,
    sourcePath = "<memory>",
): Promise<LoadedSpec> {
    const { frontmatter, context } = splitDocument(source, sourcePath);
    const document = parseDocument(frontmatter, {
        prettyErrors: false,
        uniqueKeys: true,
    });

    if (document.errors.length > 0) {
        throw new SpecLoadError({
            code: "spec_yaml_invalid",
            message: document.errors.map((error) => error.message).join("; "),
            sourcePath,
            cause: document.errors[0],
        });
    }

    let value: unknown;
    try {
        value = document.toJS({ maxAliasCount: 100 });
    } catch (error) {
        throw new SpecLoadError({
            code: "spec_yaml_invalid",
            message: error instanceof Error ? error.message : "Unable to decode YAML frontmatter",
            sourcePath,
            cause: error,
        });
    }

    return {
        sourcePath,
        contract: await validateSpecContract(value, sourcePath),
        context,
    };
}

export async function loadSpec(path: string): Promise<LoadedSpec> {
    const sourcePath = resolve(path);
    let source: string;

    try {
        source = await readFile(sourcePath, "utf8");
    } catch (error) {
        throw new SpecLoadError({
            code: "spec_read_failed",
            message: `Unable to read Spec: ${sourcePath}`,
            sourcePath,
            cause: error,
        });
    }

    return parseSpecText(source, sourcePath);
}
