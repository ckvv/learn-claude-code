#!/usr/bin/env node

/**
 * s07_task_system.ts - Tasks
 *
 * Tasks persist as JSON files in .tasks/ so they survive context compression.
 */

import { exec as execCallback } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { cwd, stdin as input, stdout as output } from "node:process";
import { dirname, join, relative, resolve } from "node:path";
import readline from "node:readline/promises";
import { promisify } from "node:util";

import { SimpleChatClient, type ChatMessage, type ChatTool } from "./simple_fetch_client.ts";

const exec = promisify(execCallback);
const workdir = cwd();
const client = new SimpleChatClient();
const model = process.env.MODEL_ID ?? process.env.OPENAI_MODEL ?? "deepseek-chat";
const tasksDir = join(workdir, ".tasks");

const systemPrompt = `You are a coding agent at ${workdir}. Use task tools to plan and track work.`;

interface TaskRecord {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  blockedBy: number[];
  blocks: number[];
  owner: string;
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

class TaskManager {
  nextId = 1;

  async initialize(): Promise<void> {
    await mkdir(tasksDir, { recursive: true });
    this.nextId = (await this.maxId()) + 1;
  }

  private taskPath(taskId: number): string {
    return join(tasksDir, `task_${taskId}.json`);
  }

  private async maxId(): Promise<number> {
    const entries = await readdir(tasksDir).catch(() => []);
    const ids = entries
      .map((entry) => /^task_(\d+)\.json$/.exec(entry))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]));
    return ids.length ? Math.max(...ids) : 0;
  }

  private async load(taskId: number): Promise<TaskRecord> {
    const text = await readFile(this.taskPath(taskId), "utf8").catch(() => "");
    if (!text) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(text) as TaskRecord;
  }

  private async save(task: TaskRecord): Promise<void> {
    await writeFile(this.taskPath(task.id), `${JSON.stringify(task, null, 2)}\n`, "utf8");
  }

  async create(subject: string, description = ""): Promise<string> {
    const task: TaskRecord = {
      id: this.nextId,
      subject,
      description,
      status: "pending",
      blockedBy: [],
      blocks: [],
      owner: "",
    };
    await this.save(task);
    this.nextId += 1;
    return JSON.stringify(task, null, 2);
  }

  async get(taskId: number): Promise<string> {
    return JSON.stringify(await this.load(taskId), null, 2);
  }

  async update(
    taskId: number,
    status?: string,
    addBlockedBy?: number[],
    addBlocks?: number[],
  ): Promise<string> {
    const task = await this.load(taskId);

    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status as TaskRecord["status"];
      if (status === "completed") {
        await this.clearDependency(taskId);
      }
    }

    if (addBlockedBy?.length) {
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    }

    if (addBlocks?.length) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];

      for (const blockedId of addBlocks) {
        try {
          const blocked = await this.load(blockedId);
          if (!blocked.blockedBy.includes(taskId)) {
            blocked.blockedBy.push(taskId);
            await this.save(blocked);
          }
        } catch {
          // Keep Python behavior: ignore missing linked tasks.
        }
      }
    }

    await this.save(task);
    return JSON.stringify(task, null, 2);
  }

  private async clearDependency(completedId: number): Promise<void> {
    const entries = await readdir(tasksDir).catch(() => []);
    for (const entry of entries) {
      if (!/^task_\d+\.json$/.test(entry)) {
        continue;
      }
      const task = JSON.parse(await readFile(join(tasksDir, entry), "utf8")) as TaskRecord;
      if (task.blockedBy.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((item) => item !== completedId);
        await this.save(task);
      }
    }
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
      const blocked = task.blockedBy.length
        ? ` (blocked by: ${JSON.stringify(task.blockedBy)})`
        : "";
      lines.push(`${marker} #${task.id}: ${task.subject}${blocked}`);
    }
    return lines.join("\n");
  }
}

const taskManager = new TaskManager();

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
  toolSchema("bash", "Run a shell command.", {
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
  toolSchema("task_create", "Create a new task.", {
    type: "object",
    properties: { subject: { type: "string" }, description: { type: "string" } },
    required: ["subject"],
  }),
  toolSchema("task_update", "Update a task's status or dependencies.", {
    type: "object",
    properties: {
      task_id: { type: "integer" },
      status: { type: "string", enum: ["pending", "in_progress", "completed"] },
      addBlockedBy: { type: "array", items: { type: "integer" } },
      addBlocks: { type: "array", items: { type: "integer" } },
    },
    required: ["task_id"],
  }),
  toolSchema("task_list", "List all tasks with status summary.", {
    type: "object",
    properties: {},
  }),
  toolSchema("task_get", "Get full details of a task by ID.", {
    type: "object",
    properties: { task_id: { type: "integer" } },
    required: ["task_id"],
  }),
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
      return taskManager.create(
        typeof args.subject === "string" ? args.subject : "",
        typeof args.description === "string" ? args.description : "",
      );
    case "task_update":
      return taskManager.update(
        typeof args.task_id === "number" ? args.task_id : -1,
        typeof args.status === "string" ? args.status : undefined,
        Array.isArray(args.addBlockedBy)
          ? args.addBlockedBy.filter((item): item is number => typeof item === "number")
          : undefined,
        Array.isArray(args.addBlocks)
          ? args.addBlocks.filter((item): item is number => typeof item === "number")
          : undefined,
      );
    case "task_list":
      return taskManager.listAll();
    case "task_get":
      return taskManager.get(typeof args.task_id === "number" ? args.task_id : -1);
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
  await taskManager.initialize();

  const rl = readline.createInterface({ input, output });
  const history: ChatMessage[] = [];

  try {
    while (true) {
      const query = await rl.question("\x1b[36ms07 >> \x1b[0m");
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
