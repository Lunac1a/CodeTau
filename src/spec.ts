import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { TaskSpec } from "./types.ts";

function scalar(raw: string): unknown {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) return JSON.parse(value);
  return value.replace(/^['"]|['"]$/g, "");
}

export function parseSpec(text: string, sourcePath = process.cwd()): TaskSpec {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error("Spec must contain YAML frontmatter delimited by ---");
  const data: Record<string, unknown> = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const i = rawLine.indexOf(":");
    if (i < 1 || /^\s/.test(rawLine)) throw new Error(`Unsupported frontmatter line: ${rawLine}`);
    data[rawLine.slice(0, i).trim()] = scalar(rawLine.slice(i + 1));
  }
  const required = ["id", "title", "goal"];
  for (const key of required) if (typeof data[key] !== "string" || !data[key]) throw new Error(`Spec field '${key}' is required`);
  const workspace = resolve(dirname(sourcePath), String(data.workspace ?? "."));
  const validation = Array.isArray(data.validation) ? data.validation : [];
  const spec: TaskSpec = {
    id: String(data.id), title: String(data.title), goal: String(data.goal), workspace,
    allowedPaths: asStrings(data.allowedPaths, ["."]), forbiddenTools: asStrings(data.forbiddenTools),
    policy: asStrings(data.policy), finalAssertions: asStrings(data.finalAssertions),
    validation: validation.map((v) => {
      if (!v || typeof v !== "object" || typeof (v as any).executable !== "string" || !Array.isArray((v as any).args)) throw new Error("Each validation must contain executable and args");
      return { executable: (v as any).executable, args: (v as any).args.map(String) };
    }),
    budget: {
      maxTurns: positive(data.maxTurns, 30), maxToolCalls: positive(data.maxToolCalls, 80), maxRetries: positive(data.maxRetries, 3)
    },
    allowQuestions: data.allowQuestions !== false,
    hiddenAssertions: typeof data.hiddenAssertions === "string" ? data.hiddenAssertions : undefined,
    body: match[2].trim()
  };
  return spec;
}

function asStrings(value: unknown, fallback: string[] = []): string[] { return Array.isArray(value) ? value.map(String) : fallback; }
function positive(value: unknown, fallback: number): number { return typeof value === "number" && value > 0 ? value : fallback; }
export async function loadSpec(path: string): Promise<TaskSpec> { return parseSpec(await readFile(path, "utf8"), resolve(path)); }
