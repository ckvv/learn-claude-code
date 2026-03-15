#!/usr/bin/env node

/**
 * s08_background_tasks.ts - Background Tasks
 *
 * Run commands asynchronously and inject completed notifications before each
 * LLM call so the agent can keep working meanwhile.
 */

import { exec as execCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cwd, stdin as input, stdout as output } from "node:process";
import { dirname, relative, resolve } from "node:path";
import readline from "node:readline/promises";
import { promisify } from "node:util";

import { SimpleChatClient, type ChatMessage, type ChatTool } from "./simple_fetch_client.ts";

const exec = promisify(execCallback);
const workdir = cwd();
const client = new SimpleChatClient();
const model = process.env.MODEL_ID ?? process.env.OPENAI_MODEL ?? "deepseek-chat";

const systemPrompt = `You are a coding agent at ${workdir}. Use background_run for long-running commands.`;

interface BackgroundTaskRecord {
  status: "running" | "completed" | "timeout" | "error";
  result: string | null;
  command: string;
}

interface BackgroundNotification {
  task_id: string;
  status: BackgroundTaskRecord["status"];
  command: string;
  result: string;
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

function makeTaskId(): string {
  return Math.random().toString(16).slice(2, 10);
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

class BackgroundManager {
  tasks = new Map<string, BackgroundTaskRecord>();
  notifications: BackgroundNotification[] = [];

  run(command: string): string {
    const taskId = makeTaskId();
    this.tasks.set(taskId, { status: "running", result: null, command });
    void this.execute(taskId, command);
    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  private async execute(taskId: string, command: string): Promise<void> {
    let status: BackgroundTaskRecord["status"] = "completed";
    let result = "(no output)";

    try {
      const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
      if (dangerous.some((item) => command.includes(item))) {
        throw new Error("Dangerous command blocked");
      }

      const { stdout, stderr } = await exec(command, {
        cwd: workdir,
        timeout: 300_000,
        maxBuffer: 1024 * 1024 * 8,
        shell: "/bin/zsh",
      });
      result = sanitizeOutput(`${stdout}${stderr}`.trim());
    } catch (error) {
      if (error instanceof Error && error.message.includes("timed out")) {
        status = "timeout";
        result = "Error: Timeout (300s)";
      } else if (error instanceof Error && "stdout" in error && "stderr" in error) {
        status = "completed";
        const stdout = formatExecStream(error.stdout);
        const stderr = formatExecStream(error.stderr);
        result = sanitizeOutput(`${stdout}${stderr}`.trim() || error.message);
      } else {
        status = "error";
        result = error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`;
      }
    }

    this.tasks.set(taskId, { status, result, command });
    this.notifications.push({
      task_id: taskId,
      status,
      command: command.slice(0, 80),
      result: result.slice(0, 500),
    });
  }

  check(taskId?: string): string {
    if (taskId) {
      const task = this.tasks.get(taskId);
      if (!task) {
        return `Error: Unknown task ${taskId}`;
      }
      return `[${task.status}] ${task.command.slice(0, 60)}\n${task.result ?? "(running)"}`;
    }

    const lines = [...this.tasks.entries()].map(([id, task]) => {
      return `${id}: [${task.status}] ${task.command.slice(0, 60)}`;
    });
    return lines.length ? lines.join("\n") : "No background tasks.";
  }

  drainNotifications(): BackgroundNotification[] {
    const items = [...this.notifications];
    this.notifications = [];
    return items;
  }
}

const backgroundManager = new BackgroundManager();

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
  toolSchema("bash", "Run a shell command (blocking).", {
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
  toolSchema("background_run", "Run command in background. Returns task_id immediately.", {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  }),
  toolSchema("check_background", "Check background task status. Omit task_id to list all.", {
    type: "object",
    properties: { task_id: { type: "string" } },
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
    case "background_run":
      return backgroundManager.run(typeof args.command === "string" ? args.command : "");
    case "check_background":
      return backgroundManager.check(typeof args.task_id === "string" ? args.task_id : undefined);
    default:
      return `Unknown tool: ${name}`;
  }
}

async function agentLoop(history: ChatMessage[]): Promise<string> {
  while (true) {
    const notifications = backgroundManager.drainNotifications();
    if (notifications.length && history.length) {
      const notifText = notifications
        .map((item) => `[bg:${item.task_id}] ${item.status}: ${item.result}`)
        .join("\n");
      history.push({
        role: "user",
        content: `<background-results>\n${notifText}\n</background-results>`,
      });
      history.push({ role: "assistant", content: "Noted background results." });
    }

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
  const rl = readline.createInterface({ input, output });
  const history: ChatMessage[] = [];

  try {
    while (true) {
      const query = await rl.question("\x1b[36ms08 >> \x1b[0m");
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
