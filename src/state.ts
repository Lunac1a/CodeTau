import type { TaskStatus } from "./types.ts";

const allowed: Record<TaskStatus, TaskStatus[]> = {
  created: ["analyzing", "failed"], analyzing: ["awaiting_approval", "editing", "validating", "blocked", "failed"],
  awaiting_approval: ["analyzing", "editing", "validating", "blocked", "failed"],
  editing: ["analyzing", "awaiting_approval", "validating", "failed", "blocked"],
  validating: ["analyzing", "editing", "completed", "failed", "blocked"],
  completed: [], failed: [], blocked: ["analyzing", "failed"]
};
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!allowed[from].includes(to)) throw new Error(`Invalid task transition: ${from} -> ${to}`);
}
