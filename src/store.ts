import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent, TaskStatus } from "./types.ts";
import { assertTransition } from "./state.ts";

export class EventStore {
  readonly db: DatabaseSync;
  constructor(path = ".codetau/codetau.db") {
    const full = resolve(path); requireDir(dirname(full));
    this.db = new DatabaseSync(full); this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, spec_id TEXT NOT NULL, spec_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), type TEXT NOT NULL, at TEXT NOT NULL, parent_id INTEGER, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_calls(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL, args_json TEXT NOT NULL, result_json TEXT, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_call_id TEXT, decision TEXT NOT NULL, rule TEXT NOT NULL, request_json TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS patches(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, path TEXT NOT NULL, before_hash TEXT NOT NULL, after_hash TEXT NOT NULL, diff TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS validation_runs(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, command_json TEXT NOT NULL, ok INTEGER NOT NULL, output TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS benchmark_runs(id TEXT PRIMARY KEY, suite TEXT NOT NULL, task_id TEXT NOT NULL, run_index INTEGER NOT NULL, result_json TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);
    `);
  }
  createSession(spec: unknown, specId: string): string {
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)").run(id, specId, JSON.stringify(spec), "created", now, now);
    this.append(id, "session.created", { status: "created", specId }); return id;
  }
  append(sessionId: string, type: string, payload: unknown, parentId?: number): number {
    const at = new Date().toISOString();
    const result = this.db.prepare("INSERT INTO events(session_id,type,at,parent_id,payload_json) VALUES(?,?,?,?,?)").run(sessionId, type, at, parentId ?? null, JSON.stringify(redact(payload)));
    this.db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(at, sessionId); return Number(result.lastInsertRowid);
  }
  status(sessionId: string): TaskStatus { const row = this.db.prepare("SELECT status FROM sessions WHERE id=?").get(sessionId) as any; if (!row) throw new Error("Unknown session"); return row.status; }
  transition(sessionId: string, to: TaskStatus, reason: string, sourceEvent?: number): void {
    const from = this.status(sessionId); assertTransition(from, to); const at = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE sessions SET status=?,updated_at=? WHERE id=?").run(to, at, sessionId);
      this.db.prepare("INSERT INTO events(session_id,type,at,parent_id,payload_json) VALUES(?,?,?,?,?)").run(sessionId, "state.transition", at, sourceEvent ?? null, JSON.stringify({ from, to, reason }));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  events(sessionId: string): AgentEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE session_id=? ORDER BY id").all(sessionId) as any[]).map(r => ({ id:r.id, sessionId:r.session_id, type:r.type, at:r.at, parentId:r.parent_id ?? undefined, payload:JSON.parse(r.payload_json) }));
  }
  session(sessionId: string): any { const row = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId) as any; if (!row) throw new Error("Unknown session"); return { ...row, spec: JSON.parse(row.spec_json) }; }
  async exportJsonl(sessionId: string, path: string): Promise<void> { await mkdir(dirname(resolve(path)), { recursive: true }); await writeFile(path, this.events(sessionId).map(e => JSON.stringify(e)).join("\n") + "\n"); }
  recordTool(id:string, sessionId:string, name:string, args:unknown, result:unknown, status:string):void { this.db.prepare("INSERT OR REPLACE INTO tool_calls VALUES(?,?,?,?,?,?)").run(id,sessionId,name,JSON.stringify(redact(args)),JSON.stringify(redact(result)),status); }
  recordApproval(sessionId:string, callId:string, decision:string, rule:string, request:unknown):void { this.db.prepare("INSERT INTO approvals(session_id,tool_call_id,decision,rule,request_json,at) VALUES(?,?,?,?,?,?)").run(sessionId,callId,decision,rule,JSON.stringify(redact(request)),new Date().toISOString()); }
  recordPatch(sessionId:string,path:string,before:string,after:string,diff:string):void { this.db.prepare("INSERT INTO patches(session_id,path,before_hash,after_hash,diff,at) VALUES(?,?,?,?,?,?)").run(sessionId,path,before,after,diff,new Date().toISOString()); }
  recordValidation(sessionId:string,command:unknown,ok:boolean,output:string):void { this.db.prepare("INSERT INTO validation_runs(session_id,command_json,ok,output,at) VALUES(?,?,?,?,?)").run(sessionId,JSON.stringify(command),ok?1:0,output,new Date().toISOString()); }
  recordBenchmark(suite:string,taskId:string,index:number,result:unknown):void { this.db.prepare("INSERT INTO benchmark_runs VALUES(?,?,?,?,?,?)").run(randomUUID(),suite,taskId,index,JSON.stringify(result),new Date().toISOString()); }
  close():void { this.db.close(); }
}

function requireDir(path:string):void { const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs"); fs.mkdirSync(path,{recursive:true}); }
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [/key|token|secret|authorization/i.test(k) ? k : k, /key|token|secret|authorization/i.test(k) ? "[REDACTED]" : redact(v)]));
  return value;
}
