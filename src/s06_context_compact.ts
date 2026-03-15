#!/usr/bin/env node

/**
 * s06_context_compact.ts - Compact
 *
 * Three-layer compression pipeline:
 * 1) micro compact every turn
 * 2) auto compact above threshold
 * 3) manual compact via tool
 */

import { exec as execCallback } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { cwd, stdin as input, stdout as output } from "node:process";
import { dirname, join, relative, resolve } from "node:path";
import readline from "node:readline/promises";
import { promisify } from "node:util";

import { SimpleChatClient, type ChatMessage, type ChatTool } from "./simple_fetch_client.ts";

const exec = promisify(execCallback);
const workdir = cwd();
const client = new SimpleChatClient();
const model = process.env.MODEL_ID ?? process.env.OPENAI_MODEL ?? "deepseek-chat";

const systemPrompt = `You are a coding agent at ${workdir}. Use tools to solve tasks.`;
const threshold = 50_000;
const transcriptDir = join(workdir, ".transcripts");
const keepRecent = 3;

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

function estimateTokens(messages: ChatMessage[]): number {
  return JSON.stringify(messages).length / 4;
}

function microCompact(messages: ChatMessage[]): void {
  const toolMessages = messages.filter((message) => message.role === "tool");
  if (toolMessages.length <= keepRecent) {
    return;
  }

  const oldMessages = toolMessages.slice(0, -keepRecent);
  for (const message of oldMessages) {
    if (typeof message.content === "string" && message.content.length > 100) {
      message.content = "[Previous: used tool]";
    }
  }
}

async function autoCompact(messages: ChatMessage[]): Promise<ChatMessage[]> {
  await mkdir(transcriptDir, { recursive: true });
  const transcriptPath = join(transcriptDir, `transcript_${Math.floor(Date.now() / 1000)}.jsonl`);

  for (const message of messages) {
    await appendFile(transcriptPath, `${JSON.stringify(message)}\n`, "utf8");
  }
  console.log(`[transcript saved: ${transcriptPath}]`);

  const response = await client.createChatCompletion({
    model,
    messages: [
      {
        role: "user",
        content:
          "Summarize this conversation for continuity. Include: " +
          "1) What was accomplished, 2) Current state, 3) Key decisions made. " +
          `Be concise but preserve critical details.\n\n${JSON.stringify(messages).slice(0, 80_000)}`,
      },
    ],
    temperature: 0,
  });

  const summary = response.choices?.[0]?.message?.content ?? "(no summary)";
  return [
    {
      role: "user",
      content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
    },
    {
      role: "assistant",
      content: "Understood. I have the context from the summary. Continuing.",
    },
  ];
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
  toolSchema("compact", "Trigger manual conversation compression.", {
    type: "object",
    properties: { focus: { type: "string", description: "What to preserve in the summary" } },
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
    case "compact":
      return "Manual compression requested.";
    default:
      return `Unknown tool: ${name}`;
  }
}

async function agentLoop(history: ChatMessage[]): Promise<string> {
  while (true) {
    microCompact(history);

    if (estimateTokens(history) > threshold) {
      console.log("[auto_compact triggered]");
      history.splice(0, history.length, ...(await autoCompact(history)));
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

    let manualCompact = false;

    for (const toolCall of assistant.tool_calls) {
      const args = parseJson(toolCall.function.arguments);
      if (toolCall.function.name === "compact") {
        manualCompact = true;
      }

      let result: string;
      try {
        result = await dispatchTool(toolCall.function.name, args);
      } catch (error) {
        result = error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`;
      }

      console.log(`> ${toolCall.function.name}: ${result.slice(0, 200)}`);
      history.push({ role: "tool", tool_call_id: toolCall.id, content: result });
    }

    if (manualCompact) {
      console.log("[manual compact]");
      history.splice(0, history.length, ...(await autoCompact(history)));
    }
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  const history: ChatMessage[] = [];

  try {
    while (true) {
      const query = await rl.question("\x1b[36ms06 >> \x1b[0m");
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
