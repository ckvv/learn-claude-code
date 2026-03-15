#!/usr/bin/env node

/**
 * s03_todo_write.ts - TodoWrite
 *
 * The model tracks its own progress through a todo tool.
 * If it forgets to update todos for too many rounds, we inject
 * a reminder back into the conversation.
 */

import { exec as execCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { cwd, stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { promisify } from "node:util";

import { SimpleChatClient, type ChatMessage, type ChatTool } from "./simple_fetch_client.ts";

const exec = promisify(execCallback);
const workdir = cwd();
const client = new SimpleChatClient();
const model = process.env.MODEL_ID ?? process.env.OPENAI_MODEL ?? "deepseek-chat";

const systemPrompt = `You are a coding agent at ${workdir}.
Use the todo tool to plan multi-step tasks. Mark in_progress before starting, completed when done.
Prefer tools over prose.`;

type TodoStatus = "pending" | "in_progress" | "completed";

interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

class TodoManager {
  private items: TodoItem[] = [];

  update(items: unknown[]): string {
    if (items.length > 20) {
      throw new Error("Max 20 todos allowed");
    }

    let inProgressCount = 0;
    const validated = items.map((item, index) => {
      const record = isRecord(item) ? item : {};
      const text = readString(record.text).trim();
      const status = readString(record.status, "pending").toLowerCase();
      const id = readString(record.id, String(index + 1));

      if (!text) {
        throw new Error(`Item ${id}: text required`);
      }

      if (!isTodoStatus(status)) {
        throw new Error(`Item ${id}: invalid status '${status}'`);
      }

      if (status === "in_progress") {
        inProgressCount += 1;
      }

      return { id, text, status };
    });

    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }

    this.items = validated;
    return this.render();
  }

  private render(): string {
    if (this.items.length === 0) {
      return "No todos.";
    }

    const lines = this.items.map((item) => {
      const marker = {
        pending: "[ ]",
        in_progress: "[>]",
        completed: "[x]",
      }[item.status];
      return `${marker} #${item.id}: ${item.text}`;
    });

    const done = this.items.filter((item) => item.status === "completed").length;
    lines.push(``, `(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }
}

const todoManager = new TodoManager();

const tools: ChatTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read file contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          limit: { type: "integer" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace exact text in file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo",
      description: "Update task list. Track progress on multi-step tasks.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                text: { type: "string" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                },
              },
              required: ["id", "text", "status"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTodoStatus(value: string): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
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

function safePath(path: string): string {
  const fullPath = resolve(workdir, path);
  const relativePrefix = `${workdir}/`;
  if (fullPath !== workdir && !fullPath.startsWith(relativePrefix)) {
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
    const combined = `${stdout}${stderr}`.trim();
    return combined.slice(0, 50_000) || "(no output)";
  } catch (error) {
    if (error instanceof Error && "stdout" in error && "stderr" in error) {
      const stdout = formatExecStream(error.stdout);
      const stderr = formatExecStream(error.stderr);
      const combined = `${stdout}${stderr}`.trim();
      return combined.slice(0, 50_000) || error.message;
    }
    return error instanceof Error ? error.message : String(error);
  }
}

async function runRead(path: string, limit?: number): Promise<string> {
  try {
    const text = await readFile(safePath(path), "utf8");
    const lines = text.split(/\r?\n/);
    if (limit && limit < lines.length) {
      return [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`]
        .join("\n")
        .slice(0, 50_000);
    }
    return text.slice(0, 50_000);
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
    case "todo":
      return todoManager.update(Array.isArray(args.items) ? args.items : []);
    default:
      return `Unknown tool: ${name}`;
  }
}

async function agentLoop(history: ChatMessage[]): Promise<string> {
  let roundsSinceTodo = 0;

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

    let usedTodo = false;

    for (const toolCall of assistant.tool_calls) {
      const args = parseJson(toolCall.function.arguments);
      const result = await dispatchTool(toolCall.function.name, args);
      console.log(`\x1b[33m> ${toolCall.function.name}\x1b[0m ${result.slice(0, 200)}`);

      history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });

      if (toolCall.function.name === "todo") {
        usedTodo = true;
      }
    }

    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
    if (roundsSinceTodo >= 3) {
      history.push({
        role: "user",
        content: "<reminder>Update your todos.</reminder>",
      });
    }
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  const history: ChatMessage[] = [];

  try {
    while (true) {
      const query = await rl.question("\x1b[36ms03 >> \x1b[0m");
      if (!query.trim() || ["q", "exit"].includes(query.trim().toLowerCase())) {
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
