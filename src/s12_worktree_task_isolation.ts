#!/usr/bin/env node

/**
 * s12_worktree_task_isolation.ts - Worktree + Task Isolation
 *
 * Tasks are the control plane. Worktrees are the execution plane.
 */

import { execFile as execFileCallback, exec as execCallback } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { cwd, stdin as input, stdout as output } from "node:process";
import { dirname, join, relative, resolve } from "node:path";
import readline from "node:readline/promises";
import { promisify } from "node:util";

import { SimpleChatClient, type ChatMessage, type ChatTool } from "./simple_fetch_client.ts";

const exec = promisify(execCallback);
const execFile = promisify(execFileCallback);
const workdir = cwd();
const client = new SimpleChatClient();
const model = process.env.MODEL_ID ?? process.env.OPENAI_MODEL ?? "deepseek-chat";

interface TaskRecord {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  owner: string;
  worktree: string;
  blockedBy: number[];
  created_at: number;
  updated_at: number;
}

interface WorktreeEntry {
  name: string;
  path: string;
  branch: string;
  task_id?: number;
  status: string;
  created_at: number;
  removed_at?: number;
  kept_at?: number;
}

function parseJson(inputText: string): Record<string, unknown> {
  try {
    return JSON.parse(inputText) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function formatExecStream(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sanitizeOutput(value: string): string {
  return value.slice(0, 50_000) || "(no output)";
}

async function detectRepoRoot(start: string): Promise<string> {
  try {
    const { stdout } = await execFile("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      timeout: 10_000,
    });
    const root = stdout.trim();
    return root || start;
  } catch {
    return start;
  }
}

const repoRoot = await detectRepoRoot(workdir);
const tasksDir = join(repoRoot, ".tasks");
const worktreesDir = join(repoRoot, ".worktrees");
const worktreeIndexPath = join(worktreesDir, "index.json");
const eventLogPath = join(worktreesDir, "events.jsonl");

const systemPrompt =
  `You are a coding agent at ${workdir}. ` +
  "Use task + worktree tools for multi-task work. " +
  "For parallel or risky changes: create tasks, allocate worktree lanes, " +
  "run commands in those lanes, then choose keep/remove for closeout. " +
  "Use worktree_events when you need lifecycle visibility.";

function safePath(path: string): string {
  const fullPath = resolve(workdir, path);
  const rel = relative(workdir, fullPath);
  if (rel.startsWith("..") || rel === "") {
    throw new Error(`Path escapes workspace: ${path}`);
  }
  return fullPath;
}

async function runBash(command: string): Promise<string> {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((item) => command.includes(item))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const { stdout, stderr } = await exec(command, {
      cwd: workdir,
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 8,
      shell: "/bin/zsh",
    });
    return sanitizeOutput(`${stdout}${stderr}`.trim());
  } catch (error) {
    if (error instanceof Error && "stdout" in error && "stderr" in error) {
      const stdout = formatExecStream(error.stdout);
      const stderr = formatExecStream(error.stderr);
      return sanitizeOutput(`${stdout}${stderr}`.trim() || error.message);
    }
    return error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`;
  }
}

async function runRead(path: string, limit?: number): Promise<string> {
  try {
    const text = await readFile(safePath(path), "utf8");
    const lines = text.split(/\r?\n/);
    if (limit && limit < lines.length) {
      return sanitizeOutput(
        [...lines.slice(0, limit), `... (${lines.length - limit} more)`].join("\n"),
      );
    }
    return sanitizeOutput(lines.join("\n"));
  } catch (error) {
    return error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`;
  }
}

async function runWrite(path: string, content: string): Promise<string> {
  try {
    const fullPath = safePath(path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    return `Wrote ${content.length} bytes`;
  } catch (error) {
    return error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`;
  }
}

async function runEdit(path: string, oldText: string, newText: string): Promise<string> {
  try {
    const fullPath = safePath(path);
    const content = await readFile(fullPath, "utf8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${path}`;
    }
    await writeFile(fullPath, content.replace(oldText, newText), "utf8");
    return `Edited ${path}`;
  } catch (error) {
    return error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`;
  }
}

class EventBus {
  async initialize(): Promise<void> {
    await mkdir(dirname(eventLogPath), { recursive: true });
    await appendFile(eventLogPath, "", "utf8");
  }

  async emit(
    event: string,
    task: Record<string, unknown> = {},
    worktree: Record<string, unknown> = {},
    error?: string,
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      event,
      ts: Date.now() / 1000,
      task,
      worktree,
    };
    if (error) {
      payload.error = error;
    }
    await appendFile(eventLogPath, `${JSON.stringify(payload)}\n`, "utf8");
  }

  async listRecent(limit = 20): Promise<string> {
    const count = Math.max(1, Math.min(Math.trunc(limit || 20), 200));
    const lines = (await readFile(eventLogPath, "utf8").catch(() => ""))
      .split(/\r?\n/)
      .filter(Boolean);
    const recent = lines.slice(-count).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { event: "parse_error", raw: line };
      }
    });
    return JSON.stringify(recent, null, 2);
  }
}

class TaskManager {
  nextId = 1;

  async initialize(): Promise<void> {
    await mkdir(tasksDir, { recursive: true });
    const entries = (await readdir(tasksDir).catch(() => []))
      .map((entry) => /^task_(\d+)\.json$/.exec(entry))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]));
    this.nextId = (entries.length ? Math.max(...entries) : 0) + 1;
  }

  private taskPath(taskId: number): string {
    return join(tasksDir, `task_${taskId}.json`);
  }

  async exists(taskId: number): Promise<boolean> {
    return Boolean(await readFile(this.taskPath(taskId), "utf8").catch(() => ""));
  }

  async load(taskId: number): Promise<TaskRecord> {
    const text = await readFile(this.taskPath(taskId), "utf8").catch(() => "");
    if (!text) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(text) as TaskRecord;
  }

  async save(task: TaskRecord): Promise<void> {
    await writeFile(this.taskPath(task.id), `${JSON.stringify(task, null, 2)}\n`, "utf8");
  }

  async create(subject: string, description = ""): Promise<string> {
    const now = Date.now() / 1000;
    const task: TaskRecord = {
      id: this.nextId,
      subject,
      description,
      status: "pending",
      owner: "",
      worktree: "",
      blockedBy: [],
      created_at: now,
      updated_at: now,
    };
    await this.save(task);
    this.nextId += 1;
    return JSON.stringify(task, null, 2);
  }

  async get(taskId: number): Promise<string> {
    return JSON.stringify(await this.load(taskId), null, 2);
  }

  async update(taskId: number, status?: string, owner?: string): Promise<string> {
    const task = await this.load(taskId);
    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status as TaskRecord["status"];
    }
    if (owner !== undefined) {
      task.owner = owner;
    }
    task.updated_at = Date.now() / 1000;
    await this.save(task);
    return JSON.stringify(task, null, 2);
  }

  async bindWorktree(taskId: number, worktree: string, owner = ""): Promise<string> {
    const task = await this.load(taskId);
    task.worktree = worktree;
    if (owner) {
      task.owner = owner;
    }
    if (task.status === "pending") {
      task.status = "in_progress";
    }
    task.updated_at = Date.now() / 1000;
    await this.save(task);
    return JSON.stringify(task, null, 2);
  }

  async unbindWorktree(taskId: number): Promise<string> {
    const task = await this.load(taskId);
    task.worktree = "";
    task.updated_at = Date.now() / 1000;
    await this.save(task);
    return JSON.stringify(task, null, 2);
  }

  async listAll(): Promise<string> {
    const entries = (await readdir(tasksDir).catch(() => []))
      .filter((entry) => /^task_\d+\.json$/.test(entry))
      .sort();

    if (entries.length === 0) {
      return "No tasks.";
    }

    const lines: string[] = [];
    for (const entry of entries) {
      const task = JSON.parse(await readFile(join(tasksDir, entry), "utf8")) as TaskRecord;
      const marker = { pending: "[ ]", in_progress: "[>]", completed: "[x]" }[task.status] ?? "[?]";
      const owner = task.owner ? ` owner=${task.owner}` : "";
      const wt = task.worktree ? ` wt=${task.worktree}` : "";
      lines.push(`${marker} #${task.id}: ${task.subject}${owner}${wt}`);
    }
    return lines.join("\n");
  }
}

class WorktreeManager {
  gitAvailable = false;
  tasks: TaskManager;
  events: EventBus;

  constructor(tasks: TaskManager, events: EventBus) {
    this.tasks = tasks;
    this.events = events;
  }

  async initialize(): Promise<void> {
    await mkdir(worktreesDir, { recursive: true });
    await writeFile(
      worktreeIndexPath,
      await readFile(worktreeIndexPath, "utf8").catch(() =>
        JSON.stringify({ worktrees: [] }, null, 2),
      ),
      "utf8",
    );
    this.gitAvailable = await this.isGitRepo();
  }

  private async isGitRepo(): Promise<boolean> {
    try {
      await execFile("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: repoRoot,
        timeout: 10_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async runGit(args: string[]): Promise<string> {
    if (!this.gitAvailable) {
      throw new Error("Not in a git repository. worktree tools require git.");
    }
    const { stdout, stderr } = await execFile("git", args, {
      cwd: repoRoot,
      timeout: 120_000,
    });
    return `${stdout}${stderr}`.trim() || "(no output)";
  }

  private async loadIndex(): Promise<{ worktrees: WorktreeEntry[] }> {
    const text = await readFile(worktreeIndexPath, "utf8").catch(() =>
      JSON.stringify({ worktrees: [] }),
    );
    return JSON.parse(text) as { worktrees: WorktreeEntry[] };
  }

  private async saveIndex(data: { worktrees: WorktreeEntry[] }): Promise<void> {
    await writeFile(worktreeIndexPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  private async find(name: string): Promise<WorktreeEntry | undefined> {
    const index = await this.loadIndex();
    return index.worktrees.find((item) => item.name === name);
  }

  private validateName(name: string): void {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name || "")) {
      throw new Error("Invalid worktree name. Use 1-40 chars: letters, numbers, ., _, -");
    }
  }

  async create(name: string, taskId?: number, baseRef = "HEAD"): Promise<string> {
    this.validateName(name);
    if (await this.find(name)) {
      throw new Error(`Worktree '${name}' already exists in index`);
    }
    if (taskId !== undefined && !(await this.tasks.exists(taskId))) {
      throw new Error(`Task ${taskId} not found`);
    }

    const path = join(worktreesDir, name);
    const branch = `wt/${name}`;

    await this.events.emit("worktree.create.before", taskId !== undefined ? { id: taskId } : {}, {
      name,
      base_ref: baseRef,
    });

    try {
      await this.runGit(["worktree", "add", "-b", branch, path, baseRef]);
      const entry: WorktreeEntry = {
        name,
        path,
        branch,
        task_id: taskId,
        status: "active",
        created_at: Date.now() / 1000,
      };

      const index = await this.loadIndex();
      index.worktrees.push(entry);
      await this.saveIndex(index);

      if (taskId !== undefined) {
        await this.tasks.bindWorktree(taskId, name);
      }

      await this.events.emit("worktree.create.after", taskId !== undefined ? { id: taskId } : {}, {
        name,
        path,
        branch,
        status: "active",
      });
      return JSON.stringify(entry, null, 2);
    } catch (error) {
      await this.events.emit(
        "worktree.create.failed",
        taskId !== undefined ? { id: taskId } : {},
        { name, base_ref: baseRef },
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  async listAll(): Promise<string> {
    const index = await this.loadIndex();
    if (index.worktrees.length === 0) {
      return "No worktrees in index.";
    }
    return index.worktrees
      .map((item) => {
        const suffix = item.task_id !== undefined ? ` task=${item.task_id}` : "";
        return `[${item.status}] ${item.name} -> ${item.path} (${item.branch})${suffix}`;
      })
      .join("\n");
  }

  async status(name: string): Promise<string> {
    const worktree = await this.find(name);
    if (!worktree) {
      return `Error: Unknown worktree '${name}'`;
    }
    try {
      const { stdout, stderr } = await execFile("git", ["status", "--short", "--branch"], {
        cwd: worktree.path,
        timeout: 60_000,
      });
      return `${stdout}${stderr}`.trim() || "Clean worktree";
    } catch (error) {
      return error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`;
    }
  }

  async run(name: string, command: string): Promise<string> {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some((item) => command.includes(item))) {
      return "Error: Dangerous command blocked";
    }
    const worktree = await this.find(name);
    if (!worktree) {
      return `Error: Unknown worktree '${name}'`;
    }
    try {
      const { stdout, stderr } = await exec(command, {
        cwd: worktree.path,
        timeout: 300_000,
        maxBuffer: 1024 * 1024 * 8,
        shell: "/bin/zsh",
      });
      return sanitizeOutput(`${stdout}${stderr}`.trim());
    } catch (error) {
      if (error instanceof Error && "stdout" in error && "stderr" in error) {
        const stdout = formatExecStream(error.stdout);
        const stderr = formatExecStream(error.stderr);
        return sanitizeOutput(`${stdout}${stderr}`.trim() || error.message);
      }
      return error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`;
    }
  }

  async remove(name: string, force = false, completeTask = false): Promise<string> {
    const worktree = await this.find(name);
    if (!worktree) {
      return `Error: Unknown worktree '${name}'`;
    }

    await this.events.emit(
      "worktree.remove.before",
      worktree.task_id !== undefined ? { id: worktree.task_id } : {},
      { name, path: worktree.path },
    );

    try {
      const args = ["worktree", "remove"];
      if (force) {
        args.push("--force");
      }
      args.push(worktree.path);
      await this.runGit(args);

      if (completeTask && worktree.task_id !== undefined) {
        const before = JSON.parse(await this.tasks.get(worktree.task_id)) as TaskRecord;
        await this.tasks.update(worktree.task_id, "completed");
        await this.tasks.unbindWorktree(worktree.task_id);
        await this.events.emit(
          "task.completed",
          { id: worktree.task_id, subject: before.subject, status: "completed" },
          { name },
        );
      }

      const index = await this.loadIndex();
      index.worktrees = index.worktrees.map((item) =>
        item.name === name ? { ...item, status: "removed", removed_at: Date.now() / 1000 } : item,
      );
      await this.saveIndex(index);

      await this.events.emit(
        "worktree.remove.after",
        worktree.task_id !== undefined ? { id: worktree.task_id } : {},
        { name, path: worktree.path, status: "removed" },
      );
      return `Removed worktree '${name}'`;
    } catch (error) {
      await this.events.emit(
        "worktree.remove.failed",
        worktree.task_id !== undefined ? { id: worktree.task_id } : {},
        { name, path: worktree.path },
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  async keep(name: string): Promise<string> {
    const worktree = await this.find(name);
    if (!worktree) {
      return `Error: Unknown worktree '${name}'`;
    }

    const index = await this.loadIndex();
    let kept: WorktreeEntry | undefined;
    index.worktrees = index.worktrees.map((item) => {
      if (item.name === name) {
        kept = { ...item, status: "kept", kept_at: Date.now() / 1000 };
        return kept;
      }
      return item;
    });
    await this.saveIndex(index);

    await this.events.emit(
      "worktree.keep",
      worktree.task_id !== undefined ? { id: worktree.task_id } : {},
      { name, path: worktree.path, status: "kept" },
    );

    return kept ? JSON.stringify(kept, null, 2) : `Error: Unknown worktree '${name}'`;
  }
}

const events = new EventBus();
const tasks = new TaskManager();
const worktrees = new WorktreeManager(tasks, events);

function toolSchema(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): ChatTool {
  return {
    type: "function",
    function: { name, description, parameters },
  };
}

const tools: ChatTool[] = [
  toolSchema("bash", "Run a shell command in the current workspace (blocking).", {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  }),
  toolSchema("read_file", "Read file contents.", {
    type: "object",
    properties: { path: { type: "string" }, limit: { type: "integer" } },
    required: ["path"],
  }),
  toolSchema("write_file", "Write content to file.", {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  }),
  toolSchema("edit_file", "Replace exact text in file.", {
    type: "object",
    properties: {
      path: { type: "string" },
      old_text: { type: "string" },
      new_text: { type: "string" },
    },
    required: ["path", "old_text", "new_text"],
  }),
  toolSchema("task_create", "Create a new task on the shared task board.", {
    type: "object",
    properties: { subject: { type: "string" }, description: { type: "string" } },
    required: ["subject"],
  }),
  toolSchema("task_list", "List all tasks with status, owner, and worktree binding.", {
    type: "object",
    properties: {},
  }),
  toolSchema("task_get", "Get task details by ID.", {
    type: "object",
    properties: { task_id: { type: "integer" } },
    required: ["task_id"],
  }),
  toolSchema("task_update", "Update task status or owner.", {
    type: "object",
    properties: {
      task_id: { type: "integer" },
      status: { type: "string", enum: ["pending", "in_progress", "completed"] },
      owner: { type: "string" },
    },
    required: ["task_id"],
  }),
  toolSchema("task_bind_worktree", "Bind a task to a worktree name.", {
    type: "object",
    properties: {
      task_id: { type: "integer" },
      worktree: { type: "string" },
      owner: { type: "string" },
    },
    required: ["task_id", "worktree"],
  }),
  toolSchema("worktree_create", "Create a git worktree and optionally bind it to a task.", {
    type: "object",
    properties: {
      name: { type: "string" },
      task_id: { type: "integer" },
      base_ref: { type: "string" },
    },
    required: ["name"],
  }),
  toolSchema("worktree_list", "List worktrees tracked in .worktrees/index.json.", {
    type: "object",
    properties: {},
  }),
  toolSchema("worktree_status", "Show git status for one worktree.", {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  }),
  toolSchema("worktree_run", "Run a shell command in a named worktree directory.", {
    type: "object",
    properties: { name: { type: "string" }, command: { type: "string" } },
    required: ["name", "command"],
  }),
  toolSchema("worktree_remove", "Remove a worktree and optionally mark its bound task completed.", {
    type: "object",
    properties: {
      name: { type: "string" },
      force: { type: "boolean" },
      complete_task: { type: "boolean" },
    },
    required: ["name"],
  }),
  toolSchema("worktree_keep", "Mark a worktree as kept in lifecycle state without removing it.", {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  }),
  toolSchema(
    "worktree_events",
    "List recent worktree/task lifecycle events from .worktrees/events.jsonl.",
    {
      type: "object",
      properties: { limit: { type: "integer" } },
    },
  ),
];

async function dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "bash":
      return runBash(typeof args.command === "string" ? args.command : "");
    case "read_file":
      return runRead(
        typeof args.path === "string" ? args.path : "",
        typeof args.limit === "number" ? args.limit : undefined,
      );
    case "write_file":
      return runWrite(
        typeof args.path === "string" ? args.path : "",
        typeof args.content === "string" ? args.content : "",
      );
    case "edit_file":
      return runEdit(
        typeof args.path === "string" ? args.path : "",
        typeof args.old_text === "string" ? args.old_text : "",
        typeof args.new_text === "string" ? args.new_text : "",
      );
    case "task_create":
      return tasks.create(
        typeof args.subject === "string" ? args.subject : "",
        typeof args.description === "string" ? args.description : "",
      );
    case "task_list":
      return tasks.listAll();
    case "task_get":
      return tasks.get(typeof args.task_id === "number" ? args.task_id : -1);
    case "task_update":
      return tasks.update(
        typeof args.task_id === "number" ? args.task_id : -1,
        typeof args.status === "string" ? args.status : undefined,
        typeof args.owner === "string" ? args.owner : undefined,
      );
    case "task_bind_worktree":
      return tasks.bindWorktree(
        typeof args.task_id === "number" ? args.task_id : -1,
        typeof args.worktree === "string" ? args.worktree : "",
        typeof args.owner === "string" ? args.owner : "",
      );
    case "worktree_create":
      return worktrees.create(
        typeof args.name === "string" ? args.name : "",
        typeof args.task_id === "number" ? args.task_id : undefined,
        typeof args.base_ref === "string" ? args.base_ref : "HEAD",
      );
    case "worktree_list":
      return worktrees.listAll();
    case "worktree_status":
      return worktrees.status(typeof args.name === "string" ? args.name : "");
    case "worktree_run":
      return worktrees.run(
        typeof args.name === "string" ? args.name : "",
        typeof args.command === "string" ? args.command : "",
      );
    case "worktree_keep":
      return worktrees.keep(typeof args.name === "string" ? args.name : "");
    case "worktree_remove":
      return worktrees.remove(
        typeof args.name === "string" ? args.name : "",
        Boolean(args.force),
        Boolean(args.complete_task),
      );
    case "worktree_events":
      return events.listRecent(typeof args.limit === "number" ? args.limit : 20);
    default:
      return `Unknown tool: ${name}`;
  }
}

async function agentLoop(history: ChatMessage[]): Promise<string> {
  while (true) {
    const response = await client.createChatCompletion({
      model,
      messages: [{ role: "system", content: systemPrompt }, ...history],
      tools,
      tool_choice: "auto",
      temperature: 0,
    });

    const assistant = response.choices?.[0]?.message;
    if (!assistant) {
      return "Error: Empty model response";
    }

    history.push({
      role: "assistant",
      content: assistant.content ?? "",
      tool_calls: assistant.tool_calls,
    });

    if (!assistant.tool_calls?.length) {
      return assistant.content || "";
    }

    for (const toolCall of assistant.tool_calls) {
      const args = parseJson(toolCall.function.arguments);
      let result: string;
      try {
        result = await dispatchTool(toolCall.function.name, args);
      } catch (error) {
        result = error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`;
      }
      console.log(`> ${toolCall.function.name}: ${result.slice(0, 200)}`);
      history.push({ role: "tool", tool_call_id: toolCall.id, content: result });
    }
  }
}

async function main(): Promise<void> {
  await tasks.initialize();
  await events.initialize();
  await worktrees.initialize();

  const rl = readline.createInterface({ input, output });
  const history: ChatMessage[] = [];

  try {
    while (true) {
      const query = await rl.question("\x1b[36ms12 >> \x1b[0m");
      const trimmed = query.trim();
      if (!trimmed || ["q", "exit"].includes(trimmed.toLowerCase())) {
        break;
      }

      history.push({ role: "user", content: query });
      const reply = await agentLoop(history);
      if (reply) {
        console.log(reply);
      }
      console.log();
    }
  } finally {
    rl.close();
  }
}

await main();
