type MarkdownRenderOptions = Readonly<{
    color: boolean;
}>;

function paint(text: string, code: string, color: boolean): string {
    return color ? `\u001B[${code}m${text}\u001B[0m` : text;
}

function renderInline(value: string, color: boolean): string {
    return value
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/gu, "$1 ($2)")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, "$1 ($2)")
        .replace(/`([^`]+)`/gu, (_match, code: string) => paint(code, "36", color))
        .replace(/\*\*([^*]+)\*\*/gu, (_match, text: string) => paint(text, "1", color))
        .replace(/__([^_]+)__/gu, (_match, text: string) => paint(text, "1", color))
        .replace(/(?<!\*)\*([^*]+)\*(?!\*)/gu, (_match, text: string) => paint(text, "3", color))
        .replace(/(?<!_)_([^_]+)_(?!_)/gu, (_match, text: string) => paint(text, "3", color));
}

export function renderTerminalMarkdown(
    markdown: string,
    options: MarkdownRenderOptions,
): string {
    const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
    const rendered: string[] = [];
    let inCodeBlock = false;

    for (const sourceLine of lines) {
        const fence = /^\s*```/u.test(sourceLine);
        if (fence) {
            inCodeBlock = !inCodeBlock;
            continue;
        }
        if (inCodeBlock) {
            rendered.push(`  ${paint(sourceLine, "36", options.color)}`);
            continue;
        }

        const heading = sourceLine.match(/^\s{0,3}#{1,6}\s+(.+)$/u);
        if (heading !== null) {
            rendered.push(paint(renderInline(heading[1], options.color), "1", options.color));
            continue;
        }
        const bullet = sourceLine.match(/^(\s*)[-*+]\s+(.+)$/u);
        if (bullet !== null) {
            rendered.push(`${bullet[1]}• ${renderInline(bullet[2], options.color)}`);
            continue;
        }
        const quote = sourceLine.match(/^\s*>\s?(.*)$/u);
        if (quote !== null) {
            rendered.push(`${paint("│", "2", options.color)} ${renderInline(quote[1], options.color)}`);
            continue;
        }
        if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u.test(sourceLine)) {
            rendered.push(paint("─".repeat(48), "2", options.color));
            continue;
        }
        rendered.push(renderInline(sourceLine, options.color));
    }

    return rendered.join("\n");
}
