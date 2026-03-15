#!/usr/bin/env node

/**
 * s05_skill_loading.ts - Skills
 *
 * Two-layer skill injection:
 * 1) cheap metadata in the system prompt
 * 2) full skill body loaded on demand through a tool.
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
const model = process.env.MODEL_ID ?? process.env.OPENAI_MODEL ?? "deepseek-chat";
const client = new SimpleChatClient();
const skillsDir = join(workdir, "skills");

interface SkillEntry {
  meta: Record<string, string>;
  body: string;
  path: string;
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

class SkillLoader {
  skills = new Map<string, SkillEntry>();

  async loadAll(): Promise<void> {
    this.skills.clear();
    await this.walk(skillsDir);
  }

  private async walk(directory: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = (await readdir(directory, {
        withFileTypes: true,
        encoding: "utf8",
      })) as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await this.walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        const text = await readFile(fullPath, "utf8");
        const { meta, body } = this.parseFrontmatter(text);
        const name = meta.name || entry.name.replace(/\.md$/, "") || "unknown";
        this.skills.set(name, { meta, body, path: fullPath });
      }
    }
  }

  private parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/m.exec(text);
    if (!match) {
      return { meta: {}, body: text };
    }

    const meta: Record<string, string> = {};
    for (const line of match[1].split(/\r?\n/)) {
      const index = line.indexOf(":");
      if (index < 0) {
        continue;
      }
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      meta[key] = value;
    }

    return { meta, body: match[2].trim() };
  }

  getDescriptions(): string {
    if (this.skills.size === 0) {
      return "(no skills available)";
    }

    return [...this.skills.entries()]
      .map(([name, skill]) => {
        const description = skill.meta.description || "No description";
        const tags = skill.meta.tags ? ` [${skill.meta.tags}]` : "";
        return `  - ${name}: ${description}${tags}`;
      })
      .join("\n");
  }

  getContent(name: string): string {
    const skill = this.skills.get(name);
    if (!skill) {
      return `Error: Unknown skill '${name}'. Available: ${[...this.skills.keys()].join(", ")}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

const skillLoader = new SkillLoader();

function buildSystemPrompt(): string {
  return `You are a coding agent at ${workdir}.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${skillLoader.getDescriptions()}`;
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
  toolSchema("load_skill", "Load specialized knowledge by name.", {
    type: "object",
    properties: { name: { type: "string", description: "Skill name to load" } },
    required: ["name"],
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
    case "load_skill":
      return skillLoader.getContent(typeof args.name === "string" ? args.name : "");
    default:
      return `Unknown tool: ${name}`;
  }
}

async function agentLoop(history: ChatMessage[]): Promise<string> {
  while (true) {
    const response = await client.createChatCompletion({
      model,
      messages: [{ role: "system", content: buildSystemPrompt() }, ...history],
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
  await skillLoader.loadAll();

  const rl = readline.createInterface({ input, output });
  const history: ChatMessage[] = [];

  try {
    while (true) {
      const query = await rl.question("\x1b[36ms05 >> \x1b[0m");
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
