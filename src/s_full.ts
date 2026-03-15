#!/usr/bin/env node

/**
 * s_full.ts - Full reference agent
 *
 * Capstone port of agents/s_full.py. This keeps the tutorial structure while
 * adapting the implementation to the OpenAI-compatible client used in src/.
 */

import { exec as execCallback } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { cwd } from "node:process";
import { basename, dirname, join, relative, resolve } from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promisify } from "node:util";

import { SimpleChatClient, type ChatMessage, type ChatTool } from "./simple_fetch_client.ts";

const exec = promisify(execCallback);
const workdir = cwd();
const model = process.env.MODEL_ID ?? process.env.OPENAI_MODEL ?? "deepseek-chat";
const client = new SimpleChatClient();

const teamDir = join(workdir, ".team");
const inboxDir = join(teamDir, "inbox");
const tasksDir = join(workdir, ".tasks");
const skillsDir = join(workdir, "skills");
const transcriptDir = join(workdir, ".transcripts");
const tokenThreshold = 100_000;
const pollIntervalMs = 5_000;
const idleTimeoutMs = 60_000;

const validMessageTypes = [
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
] as const;

type ValidMessageType = (typeof validMessageTypes)[number];

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

interface SkillEntry {
  meta: Record<string, string>;
  body: string;
}

interface TaskRecord {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  owner: string | null;
  blockedBy: number[];
  blocks: number[];
}

interface BackgroundTaskRecord {
  status: "running" | "completed" | "error";
  command: string;
  result: string | null;
}

interface BackgroundNotification {
  task_id: string;
  status: BackgroundTaskRecord["status"];
  result: string;
}

interface BusMessage {
  type: ValidMessageType;
  from: string;
  content: string;
  timestamp: number;
  request_id?: string;
  approve?: boolean;
  feedback?: string;
}

interface TeamMember {
  name: string;
  role: string;
  status: "working" | "idle" | "shutdown";
}

interface TeamConfig {
  team_name: string;
  members: TeamMember[];
}

interface ShutdownRequest {
  target: string;
  status: "pending";
}

interface PlanRequest {
  from: string;
  status: "pending" | "approved" | "rejected";
}

function parseJson(inputText: string): Record<string, unknown> {
  try {
    return JSON.parse(inputText) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function safePath(path: string): string {
  const fullPath = resolve(workdir, path);
  const rel = relative(workdir, fullPath);
  if (rel.startsWith("..") || rel === "") {
    throw new Error(`Path escapes workspace: ${path}`);
  }
  return fullPath;
}

function formatExecStream(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sanitizeOutput(value: string): string {
  return value.slice(0, 50_000) || "(no output)";
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
      const combined = `${stdout}${stderr}`.trim();
      return sanitizeOutput(combined || error.message);
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
        [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`].join("\n"),
      );
    }
    return sanitizeOutput(text);
  } catch (error) {
    return error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`;
  }
}

async function runWrite(path: string, content: string): Promise<string> {
  try {
    const fullPath = safePath(path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    return `Wrote ${content.length} bytes to ${path}`;
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

class TodoManager {
  private items: TodoItem[] = [];

  update(items: unknown[]): string {
    const validated: TodoItem[] = [];
    let inProgress = 0;

    items.forEach((item, index) => {
      const record = item as Partial<TodoItem>;
      const content = String(record.content ?? "").trim();
      const status = String(record.status ?? "pending").toLowerCase() as TodoItem["status"];
      const activeForm = String(record.activeForm ?? "").trim();

      if (!content) {
        throw new Error(`Item ${index}: content required`);
      }
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${index}: invalid status '${status}'`);
      }
      if (!activeForm) {
        throw new Error(`Item ${index}: activeForm required`);
      }
      if (status === "in_progress") {
        inProgress += 1;
      }

      validated.push({ content, status, activeForm });
    });

    if (validated.length > 20) {
      throw new Error("Max 20 todos");
    }
    if (inProgress > 1) {
      throw new Error("Only one in_progress allowed");
    }

    this.items = validated;
    return this.render();
  }

  render(): string {
    if (!this.items.length) {
      return "No todos.";
    }

    const lines = this.items.map((item) => {
      const marker = {
        completed: "[x]",
        in_progress: "[>]",
        pending: "[ ]",
      }[item.status];
      const suffix = item.status === "in_progress" ? ` <- ${item.activeForm}` : "";
      return `${marker} ${item.content}${suffix}`;
    });

    const done = this.items.filter((item) => item.status === "completed").length;
    return `${lines.join("\n")}\n\n(${done}/${this.items.length} completed)`;
  }

  hasOpenItems(): boolean {
    return this.items.some((item) => item.status !== "completed");
  }
}

function toolSchema(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): ChatTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters,
    },
  };
}

async function runSubagent(prompt: string, agentType = "Explore"): Promise<string> {
  const subTools: ChatTool[] = [
    toolSchema("bash", "Run command.", {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    }),
    toolSchema("read_file", "Read file.", {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    }),
  ];

  if (agentType !== "Explore") {
    subTools.push(
      toolSchema("write_file", "Write file.", {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      }),
      toolSchema("edit_file", "Edit file.", {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
      }),
    );
  }

  const messages: ChatMessage[] = [{ role: "user", content: prompt }];

  for (let round = 0; round < 30; round += 1) {
    const response = await client.createChatCompletion({
      model,
      messages,
      tools: subTools,
      tool_choice: "auto",
      temperature: 0,
    });

    const assistant = response.choices?.[0]?.message;
    if (!assistant) {
      return "Error: Empty model response";
    }

    messages.push({
      role: "assistant",
      content: assistant.content ?? "",
      tool_calls: assistant.tool_calls,
    });

    if (!assistant.tool_calls?.length) {
      return assistant.content || "(no summary)";
    }

    for (const toolCall of assistant.tool_calls) {
      const args = parseJson(toolCall.function.arguments);
      let result = `Unknown tool: ${toolCall.function.name}`;

      switch (toolCall.function.name) {
        case "bash":
          result = await runBash(typeof args.command === "string" ? args.command : "");
          break;
        case "read_file":
          result = await runRead(typeof args.path === "string" ? args.path : "");
          break;
        case "write_file":
          result = await runWrite(
            typeof args.path === "string" ? args.path : "",
            typeof args.content === "string" ? args.content : "",
          );
          break;
        case "edit_file":
          result = await runEdit(
            typeof args.path === "string" ? args.path : "",
            typeof args.old_text === "string" ? args.old_text : "",
            typeof args.new_text === "string" ? args.new_text : "",
          );
          break;
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  return "(subagent failed)";
}

class SkillLoader {
  private readonly root: string;
  private readonly skills = new Map<string, SkillEntry>();
  private readonly ready: Promise<void>;

  constructor(root: string) {
    this.root = root;
    this.ready = this.loadAll();
  }

  async initialize(): Promise<void> {
    await this.ready;
  }

  descriptions(): string {
    if (!this.skills.size) {
      return "(no skills)";
    }

    return [...this.skills.entries()]
      .map(([name, skill]) => `  - ${name}: ${skill.meta.description ?? "-"}`)
      .join("\n");
  }

  load(name: string): string {
    const skill = this.skills.get(name);
    if (!skill) {
      return `Error: Unknown skill '${name}'. Available: ${[...this.skills.keys()].join(", ")}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }

  private async loadAll(): Promise<void> {
    try {
      await stat(this.root);
    } catch {
      return;
    }

    const files = await this.findSkillFiles(this.root);
    for (const file of files.sort()) {
      const text = await readFile(file, "utf8");
      const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      const meta: Record<string, string> = {};
      let body = text.trim();

      if (match) {
        for (const line of match[1].trim().split("\n")) {
          const separator = line.indexOf(":");
          if (separator >= 0) {
            meta[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
          }
        }
        body = match[2].trim();
      }

      const name = meta.name ?? basename(dirname(file));
      this.skills.set(name, { meta, body });
    }
  }

  private async findSkillFiles(root: string): Promise<string[]> {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.findSkillFiles(fullPath)));
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        files.push(fullPath);
      }
    }

    return files;
  }
}

function estimateTokens(messages: ChatMessage[]): number {
  return JSON.stringify(messages).length / 4;
}

function microcompact(messages: ChatMessage[]): void {
  const toolMessages = messages.filter((message) => message.role === "tool");
  if (toolMessages.length <= 3) {
    return;
  }

  for (const message of toolMessages.slice(0, -3)) {
    if (message.content.length > 100) {
      message.content = "[cleared]";
    }
  }
}

async function autoCompact(messages: ChatMessage[]): Promise<ChatMessage[]> {
  await mkdir(transcriptDir, { recursive: true });
  const path = join(transcriptDir, `transcript_${Date.now()}.jsonl`);
  await writeFile(path, messages.map((message) => JSON.stringify(message)).join("\n"), "utf8");

  const conversationText = JSON.stringify(messages).slice(0, 80_000);
  const response = await client.createChatCompletion({
    model,
    messages: [
      {
        role: "user",
        content: `Summarize this conversation for continuity:\n${conversationText}`,
      },
    ],
    temperature: 0,
  });

  const summary = response.choices?.[0]?.message?.content ?? "Summary unavailable.";
  const relativePath = relative(workdir, path);

  return [
    {
      role: "user",
      content: `[Compressed. Transcript: ${relativePath}]\n${summary}`,
    },
    {
      role: "assistant",
      content: "Understood. Continuing with summary context.",
    },
  ];
}

class TaskManager {
  async initialize(): Promise<void> {
    await mkdir(tasksDir, { recursive: true });
  }

  async create(subject: string, description = ""): Promise<string> {
    const task: TaskRecord = {
      id: await this.nextId(),
      subject,
      description,
      status: "pending",
      owner: null,
      blockedBy: [],
      blocks: [],
    };
    await this.save(task);
    return JSON.stringify(task, null, 2);
  }

  async get(taskId: number): Promise<string> {
    return JSON.stringify(await this.load(taskId), null, 2);
  }

  async update(
    taskId: number,
    status?: TaskRecord["status"],
    addBlockedBy?: number[],
    addBlocks?: number[],
  ): Promise<string> {
    const task = await this.load(taskId);

    if (status) {
      task.status = status;

      if (status === "completed") {
        for (const other of await this.loadAllRecords()) {
          if (other.blockedBy.includes(taskId)) {
            other.blockedBy = other.blockedBy.filter((value) => value !== taskId);
            await this.save(other);
          }
        }
      }

      if (status === "deleted") {
        await rm(this.fileFor(taskId), { force: true });
        return `Task ${taskId} deleted`;
      }
    }

    if (addBlockedBy?.length) {
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    }
    if (addBlocks?.length) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];
    }

    await this.save(task);
    return JSON.stringify(task, null, 2);
  }

  async listAll(): Promise<string> {
    const tasks = await this.loadAllRecords();
    if (!tasks.length) {
      return "No tasks.";
    }

    return tasks
      .map((task) => {
        const marker = {
          pending: "[ ]",
          in_progress: "[>]",
          completed: "[x]",
          deleted: "[?]",
        }[task.status];
        const owner = task.owner ? ` @${task.owner}` : "";
        const blocked = task.blockedBy.length
          ? ` (blocked by: ${JSON.stringify(task.blockedBy)})`
          : "";
        return `${marker} #${task.id}: ${task.subject}${owner}${blocked}`;
      })
      .join("\n");
  }

  async claim(taskId: number, owner: string): Promise<string> {
    const task = await this.load(taskId);
    task.owner = owner;
    task.status = "in_progress";
    await this.save(task);
    return `Claimed task #${taskId} for ${owner}`;
  }

  async firstUnclaimedTask(): Promise<TaskRecord | null> {
    const tasks = await this.loadAllRecords();
    return (
      tasks.find(
        (task) => task.status === "pending" && !task.owner && task.blockedBy.length === 0,
      ) ?? null
    );
  }

  private async nextId(): Promise<number> {
    const entries = await readdir(tasksDir);
    const ids = entries
      .map((entry) => entry.match(/^task_(\d+)\.json$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => Number(match[1]));
    return (ids.length ? Math.max(...ids) : 0) + 1;
  }

  private fileFor(taskId: number): string {
    return join(tasksDir, `task_${taskId}.json`);
  }

  private async load(taskId: number): Promise<TaskRecord> {
    const path = this.fileFor(taskId);
    try {
      const text = await readFile(path, "utf8");
      return JSON.parse(text) as TaskRecord;
    } catch {
      throw new Error(`Task ${taskId} not found`);
    }
  }

  private async save(task: TaskRecord): Promise<void> {
    await writeFile(this.fileFor(task.id), `${JSON.stringify(task, null, 2)}\n`, "utf8");
  }

  private async loadAllRecords(): Promise<TaskRecord[]> {
    const entries = (await readdir(tasksDir))
      .filter((entry) => entry.startsWith("task_") && entry.endsWith(".json"))
      .sort();
    const tasks = await Promise.all(
      entries.map(
        async (entry) => JSON.parse(await readFile(join(tasksDir, entry), "utf8")) as TaskRecord,
      ),
    );
    return tasks;
  }
}

class BackgroundManager {
  private readonly tasks = new Map<string, BackgroundTaskRecord>();
  private readonly notifications: BackgroundNotification[] = [];

  run(command: string, timeout = 120): string {
    const taskId = Math.random().toString(16).slice(2, 10);
    this.tasks.set(taskId, { status: "running", command, result: null });

    void (async () => {
      try {
        const { stdout, stderr } = await exec(command, {
          cwd: workdir,
          timeout: timeout * 1000,
          maxBuffer: 1024 * 1024 * 8,
          shell: "/bin/zsh",
        });
        const result = sanitizeOutput(`${stdout}${stderr}`.trim());
        this.tasks.set(taskId, { status: "completed", command, result });
      } catch (error) {
        const result = error instanceof Error ? error.message : String(error);
        this.tasks.set(taskId, { status: "error", command, result });
      }

      const record = this.tasks.get(taskId);
      if (record) {
        this.notifications.push({
          task_id: taskId,
          status: record.status,
          result: sanitizeOutput(record.result ?? "(no output)").slice(0, 500),
        });
      }
    })();

    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  check(taskId?: string): string {
    if (taskId) {
      const task = this.tasks.get(taskId);
      return task ? `[${task.status}] ${task.result ?? "(running)"}` : `Unknown: ${taskId}`;
    }

    return (
      [...this.tasks.entries()]
        .map(([id, task]) => `${id}: [${task.status}] ${task.command.slice(0, 60)}`)
        .join("\n") || "No bg tasks."
    );
  }

  drain(): BackgroundNotification[] {
    return this.notifications.splice(0, this.notifications.length);
  }
}

class MessageBus {
  async initialize(): Promise<void> {
    await mkdir(inboxDir, { recursive: true });
  }

  async send(
    sender: string,
    to: string,
    content: string,
    type: ValidMessageType = "message",
    extra: Partial<BusMessage> = {},
  ): Promise<string> {
    const message: BusMessage = {
      type,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
      ...extra,
    };
    await appendFile(join(inboxDir, `${to}.jsonl`), `${JSON.stringify(message)}\n`, "utf8");
    return `Sent ${type} to ${to}`;
  }

  async readInbox(name: string): Promise<BusMessage[]> {
    const path = join(inboxDir, `${name}.jsonl`);
    try {
      const text = await readFile(path, "utf8");
      await writeFile(path, "", "utf8");
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as BusMessage);
    } catch {
      return [];
    }
  }

  async broadcast(sender: string, content: string, names: string[]): Promise<string> {
    let count = 0;
    for (const name of names) {
      if (name !== sender) {
        await this.send(sender, name, content, "broadcast");
        count += 1;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

const shutdownRequests = new Map<string, ShutdownRequest>();
const planRequests = new Map<string, PlanRequest>();

class TeammateManager {
  private readonly bus: MessageBus;
  private readonly taskManager: TaskManager;
  private configPath = join(teamDir, "config.json");
  private config: TeamConfig = { team_name: "default", members: [] };
  private readonly workers = new Map<string, Promise<void>>();

  constructor(bus: MessageBus, taskManager: TaskManager) {
    this.bus = bus;
    this.taskManager = taskManager;
  }

  async initialize(): Promise<void> {
    await mkdir(teamDir, { recursive: true });
    this.config = await this.load();
  }

  async spawn(name: string, role: string, prompt: string): Promise<string> {
    const member = this.find(name);
    if (member) {
      if (!["idle", "shutdown"].includes(member.status)) {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      this.config.members.push({ name, role, status: "working" });
    }

    await this.save();
    const worker = this.loop(name, role, prompt).catch(() => undefined);
    this.workers.set(name, worker);
    return `Spawned '${name}' (role: ${role})`;
  }

  listAll(): string {
    if (!this.config.members.length) {
      return "No teammates.";
    }

    return [
      `Team: ${this.config.team_name}`,
      ...this.config.members.map((member) => `  ${member.name} (${member.role}): ${member.status}`),
    ].join("\n");
  }

  memberNames(): string[] {
    return this.config.members.map((member) => member.name);
  }

  private async loop(name: string, role: string, prompt: string): Promise<void> {
    const systemPrompt = `You are '${name}', role: ${role}, team: ${this.config.team_name}, at ${workdir}. Use idle when done with current work. You may auto-claim tasks.`;
    const tools = this.workerTools();
    const messages: ChatMessage[] = [{ role: "user", content: prompt }];

    while (true) {
      for (let round = 0; round < 50; round += 1) {
        for (const message of await this.bus.readInbox(name)) {
          if (message.type === "shutdown_request") {
            await this.setStatus(name, "shutdown");
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(message) });
        }

        const response = await client.createChatCompletion({
          model,
          messages: [{ role: "system", content: systemPrompt }, ...messages],
          tools,
          tool_choice: "auto",
          temperature: 0,
        });

        const assistant = response.choices?.[0]?.message;
        if (!assistant) {
          await this.setStatus(name, "shutdown");
          return;
        }

        messages.push({
          role: "assistant",
          content: assistant.content ?? "",
          tool_calls: assistant.tool_calls,
        });

        if (!assistant.tool_calls?.length) {
          break;
        }

        let idleRequested = false;
        for (const toolCall of assistant.tool_calls) {
          const args = parseJson(toolCall.function.arguments);
          let result = `Unknown tool: ${toolCall.function.name}`;

          switch (toolCall.function.name) {
            case "idle":
              idleRequested = true;
              result = "Entering idle phase.";
              break;
            case "claim_task":
              result = await this.taskManager.claim(Number(args.task_id ?? 0), name);
              break;
            case "send_message":
              result = await this.bus.send(
                name,
                typeof args.to === "string" ? args.to : "",
                typeof args.content === "string" ? args.content : "",
              );
              break;
            case "bash":
              result = await runBash(typeof args.command === "string" ? args.command : "");
              break;
            case "read_file":
              result = await runRead(typeof args.path === "string" ? args.path : "");
              break;
            case "write_file":
              result = await runWrite(
                typeof args.path === "string" ? args.path : "",
                typeof args.content === "string" ? args.content : "",
              );
              break;
            case "edit_file":
              result = await runEdit(
                typeof args.path === "string" ? args.path : "",
                typeof args.old_text === "string" ? args.old_text : "",
                typeof args.new_text === "string" ? args.new_text : "",
              );
              break;
          }

          console.log(`  [${name}] ${toolCall.function.name}: ${result.slice(0, 120)}`);
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result,
          });
        }

        if (idleRequested) {
          break;
        }
      }

      await this.setStatus(name, "idle");
      let resume = false;

      for (let elapsed = 0; elapsed < idleTimeoutMs; elapsed += pollIntervalMs) {
        await new Promise((resolveTimer) => setTimeout(resolveTimer, pollIntervalMs));

        const inbox = await this.bus.readInbox(name);
        if (inbox.length) {
          for (const message of inbox) {
            if (message.type === "shutdown_request") {
              await this.setStatus(name, "shutdown");
              return;
            }
            messages.push({ role: "user", content: JSON.stringify(message) });
          }
          resume = true;
          break;
        }

        const task = await this.taskManager.firstUnclaimedTask();
        if (task) {
          await this.taskManager.claim(task.id, name);
          if (messages.length <= 3) {
            messages.unshift({
              role: "assistant",
              content: `I am ${name}. Continuing.`,
            });
            messages.unshift({
              role: "user",
              content: `<identity>You are '${name}', role: ${role}, team: ${this.config.team_name}.</identity>`,
            });
          }
          messages.push({
            role: "user",
            content: `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description}</auto-claimed>`,
          });
          messages.push({
            role: "assistant",
            content: `Claimed task #${task.id}. Working on it.`,
          });
          resume = true;
          break;
        }
      }

      if (!resume) {
        await this.setStatus(name, "shutdown");
        return;
      }

      await this.setStatus(name, "working");
    }
  }

  private workerTools(): ChatTool[] {
    return [
      toolSchema("bash", "Run command.", {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      }),
      toolSchema("read_file", "Read file.", {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      }),
      toolSchema("write_file", "Write file.", {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      }),
      toolSchema("edit_file", "Edit file.", {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
      }),
      toolSchema("send_message", "Send message.", {
        type: "object",
        properties: { to: { type: "string" }, content: { type: "string" } },
        required: ["to", "content"],
      }),
      toolSchema("idle", "Signal no more work.", {
        type: "object",
        properties: {},
      }),
      toolSchema("claim_task", "Claim task by ID.", {
        type: "object",
        properties: { task_id: { type: "integer" } },
        required: ["task_id"],
      }),
    ];
  }

  private find(name: string): TeamMember | undefined {
    return this.config.members.find((member) => member.name === name);
  }

  private async setStatus(name: string, status: TeamMember["status"]): Promise<void> {
    const member = this.find(name);
    if (member) {
      member.status = status;
      await this.save();
    }
  }

  private async load(): Promise<TeamConfig> {
    try {
      return JSON.parse(await readFile(this.configPath, "utf8")) as TeamConfig;
    } catch {
      return { team_name: "default", members: [] };
    }
  }

  private async save(): Promise<void> {
    await writeFile(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`, "utf8");
  }
}

const todo = new TodoManager();
const skills = new SkillLoader(skillsDir);
const taskManager = new TaskManager();
const backgroundManager = new BackgroundManager();
const messageBus = new MessageBus();
const teammateManager = new TeammateManager(messageBus, taskManager);

function buildSystemPrompt(): string {
  return `You are a coding agent at ${workdir}. Use tools to solve tasks.
Prefer task_create/task_update/task_list for multi-step work. Use TodoWrite for short checklists.
Use task for subagent delegation. Use load_skill for specialized knowledge.
Skills: ${skills.descriptions()}`;
}

async function handleShutdownRequest(teammate: string): Promise<string> {
  const requestId = Math.random().toString(16).slice(2, 10);
  shutdownRequests.set(requestId, { target: teammate, status: "pending" });
  await messageBus.send("lead", teammate, "Please shut down.", "shutdown_request", {
    request_id: requestId,
  });
  return `Shutdown request ${requestId} sent to '${teammate}'`;
}

async function handlePlanReview(
  requestId: string,
  approve: boolean,
  feedback = "",
): Promise<string> {
  const request = planRequests.get(requestId);
  if (!request) {
    return `Error: Unknown plan request_id '${requestId}'`;
  }

  request.status = approve ? "approved" : "rejected";
  await messageBus.send("lead", request.from, feedback, "plan_approval_response", {
    request_id: requestId,
    approve,
    feedback,
  });
  return `Plan ${request.status} for '${request.from}'`;
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
    case "TodoWrite":
      return todo.update(Array.isArray(args.items) ? args.items : []);
    case "task":
      return runSubagent(
        typeof args.prompt === "string" ? args.prompt : "",
        typeof args.agent_type === "string" ? args.agent_type : "Explore",
      );
    case "load_skill":
      return skills.load(typeof args.name === "string" ? args.name : "");
    case "compress":
      return "Compressing...";
    case "background_run":
      return backgroundManager.run(
        typeof args.command === "string" ? args.command : "",
        typeof args.timeout === "number" ? args.timeout : 120,
      );
    case "check_background":
      return backgroundManager.check(typeof args.task_id === "string" ? args.task_id : undefined);
    case "task_create":
      return taskManager.create(
        typeof args.subject === "string" ? args.subject : "",
        typeof args.description === "string" ? args.description : "",
      );
    case "task_get":
      return taskManager.get(Number(args.task_id ?? 0));
    case "task_update":
      return taskManager.update(
        Number(args.task_id ?? 0),
        typeof args.status === "string" ? (args.status as TaskRecord["status"]) : undefined,
        Array.isArray(args.add_blocked_by)
          ? args.add_blocked_by.map((value) => Number(value))
          : undefined,
        Array.isArray(args.add_blocks) ? args.add_blocks.map((value) => Number(value)) : undefined,
      );
    case "task_list":
      return taskManager.listAll();
    case "spawn_teammate":
      return teammateManager.spawn(
        typeof args.name === "string" ? args.name : "",
        typeof args.role === "string" ? args.role : "",
        typeof args.prompt === "string" ? args.prompt : "",
      );
    case "list_teammates":
      return Promise.resolve(teammateManager.listAll());
    case "send_message":
      return messageBus.send(
        "lead",
        typeof args.to === "string" ? args.to : "",
        typeof args.content === "string" ? args.content : "",
        validMessageTypes.includes(args.msg_type as ValidMessageType)
          ? (args.msg_type as ValidMessageType)
          : "message",
      );
    case "read_inbox":
      return JSON.stringify(await messageBus.readInbox("lead"), null, 2);
    case "broadcast":
      return messageBus.broadcast(
        "lead",
        typeof args.content === "string" ? args.content : "",
        teammateManager.memberNames(),
      );
    case "shutdown_request":
      return handleShutdownRequest(typeof args.teammate === "string" ? args.teammate : "");
    case "plan_approval":
      return handlePlanReview(
        typeof args.request_id === "string" ? args.request_id : "",
        Boolean(args.approve),
        typeof args.feedback === "string" ? args.feedback : "",
      );
    case "idle":
      return Promise.resolve("Lead does not idle.");
    case "claim_task":
      return taskManager.claim(Number(args.task_id ?? 0), "lead");
    default:
      return `Unknown tool: ${name}`;
  }
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
  toolSchema("TodoWrite", "Update task tracking list.", {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            activeForm: { type: "string" },
          },
          required: ["content", "status", "activeForm"],
        },
      },
    },
    required: ["items"],
  }),
  toolSchema("task", "Spawn a subagent for isolated exploration or work.", {
    type: "object",
    properties: {
      prompt: { type: "string" },
      agent_type: { type: "string", enum: ["Explore", "general-purpose"] },
    },
    required: ["prompt"],
  }),
  toolSchema("load_skill", "Load specialized knowledge by name.", {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  }),
  toolSchema("compress", "Manually compress conversation context.", {
    type: "object",
    properties: {},
  }),
  toolSchema("background_run", "Run command in background thread.", {
    type: "object",
    properties: { command: { type: "string" }, timeout: { type: "integer" } },
    required: ["command"],
  }),
  toolSchema("check_background", "Check background task status.", {
    type: "object",
    properties: { task_id: { type: "string" } },
  }),
  toolSchema("task_create", "Create a persistent file task.", {
    type: "object",
    properties: { subject: { type: "string" }, description: { type: "string" } },
    required: ["subject"],
  }),
  toolSchema("task_get", "Get task details by ID.", {
    type: "object",
    properties: { task_id: { type: "integer" } },
    required: ["task_id"],
  }),
  toolSchema("task_update", "Update task status or dependencies.", {
    type: "object",
    properties: {
      task_id: { type: "integer" },
      status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
      add_blocked_by: { type: "array", items: { type: "integer" } },
      add_blocks: { type: "array", items: { type: "integer" } },
    },
    required: ["task_id"],
  }),
  toolSchema("task_list", "List all tasks.", {
    type: "object",
    properties: {},
  }),
  toolSchema("spawn_teammate", "Spawn a persistent autonomous teammate.", {
    type: "object",
    properties: {
      name: { type: "string" },
      role: { type: "string" },
      prompt: { type: "string" },
    },
    required: ["name", "role", "prompt"],
  }),
  toolSchema("list_teammates", "List all teammates.", {
    type: "object",
    properties: {},
  }),
  toolSchema("send_message", "Send a message to a teammate.", {
    type: "object",
    properties: {
      to: { type: "string" },
      content: { type: "string" },
      msg_type: { type: "string", enum: [...validMessageTypes] },
    },
    required: ["to", "content"],
  }),
  toolSchema("read_inbox", "Read and drain the lead's inbox.", {
    type: "object",
    properties: {},
  }),
  toolSchema("broadcast", "Send message to all teammates.", {
    type: "object",
    properties: { content: { type: "string" } },
    required: ["content"],
  }),
  toolSchema("shutdown_request", "Request a teammate to shut down.", {
    type: "object",
    properties: { teammate: { type: "string" } },
    required: ["teammate"],
  }),
  toolSchema("plan_approval", "Approve or reject a teammate's plan.", {
    type: "object",
    properties: {
      request_id: { type: "string" },
      approve: { type: "boolean" },
      feedback: { type: "string" },
    },
    required: ["request_id", "approve"],
  }),
  toolSchema("idle", "Enter idle state.", {
    type: "object",
    properties: {},
  }),
  toolSchema("claim_task", "Claim a task from the board.", {
    type: "object",
    properties: { task_id: { type: "integer" } },
    required: ["task_id"],
  }),
];

async function agentLoop(messages: ChatMessage[]): Promise<void> {
  let roundsWithoutTodo = 0;

  while (true) {
    microcompact(messages);

    if (estimateTokens(messages) > tokenThreshold) {
      console.log("[auto-compact triggered]");
      messages.splice(0, messages.length, ...(await autoCompact(messages)));
    }

    const notifications = backgroundManager.drain();
    if (notifications.length) {
      const text = notifications
        .map(
          (notification) =>
            `[bg:${notification.task_id}] ${notification.status}: ${notification.result}`,
        )
        .join("\n");
      messages.push({
        role: "user",
        content: `<background-results>\n${text}\n</background-results>`,
      });
      messages.push({
        role: "assistant",
        content: "Noted background results.",
      });
    }

    const inbox = await messageBus.readInbox("lead");
    if (inbox.length) {
      messages.push({
        role: "user",
        content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
      });
      messages.push({
        role: "assistant",
        content: "Noted inbox messages.",
      });
    }

    const response = await client.createChatCompletion({
      model,
      messages: [{ role: "system", content: buildSystemPrompt() }, ...messages],
      tools,
      tool_choice: "auto",
      temperature: 0,
    });

    const assistant = response.choices?.[0]?.message;
    if (!assistant) {
      console.log("Error: Empty model response");
      return;
    }

    messages.push({
      role: "assistant",
      content: assistant.content ?? "",
      tool_calls: assistant.tool_calls,
    });

    if (!assistant.tool_calls?.length) {
      if (assistant.content) {
        console.log(assistant.content);
      }
      return;
    }

    let usedTodo = false;
    let manualCompress = false;

    for (const toolCall of assistant.tool_calls) {
      const args = parseJson(toolCall.function.arguments);
      if (toolCall.function.name === "compress") {
        manualCompress = true;
      }

      let result: string;
      try {
        result = await dispatchTool(toolCall.function.name, args);
      } catch (error) {
        result = error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`;
      }

      console.log(`> ${toolCall.function.name}: ${result.slice(0, 200)}`);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });

      if (toolCall.function.name === "TodoWrite") {
        usedTodo = true;
      }
    }

    roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
    if (todo.hasOpenItems() && roundsWithoutTodo >= 3) {
      messages.push({
        role: "user",
        content: "<reminder>Update your todos.</reminder>",
      });
    }

    if (manualCompress) {
      console.log("[manual compact]");
      messages.splice(0, messages.length, ...(await autoCompact(messages)));
    }
  }
}

async function main(): Promise<void> {
  await Promise.all([
    taskManager.initialize(),
    messageBus.initialize(),
    teammateManager.initialize(),
    skills.initialize(),
  ]);

  const rl = readline.createInterface({ input, output });
  const history: ChatMessage[] = [];

  try {
    while (true) {
      const query = await rl.question("\x1b[36ms_full >> \x1b[0m");
      const trimmed = query.trim();

      if (!trimmed || ["q", "exit"].includes(trimmed.toLowerCase())) {
        break;
      }

      if (trimmed === "/compact") {
        if (history.length) {
          console.log("[manual compact via /compact]");
          history.splice(0, history.length, ...(await autoCompact(history)));
        }
        continue;
      }

      if (trimmed === "/tasks") {
        console.log(await taskManager.listAll());
        continue;
      }

      if (trimmed === "/team") {
        console.log(teammateManager.listAll());
        continue;
      }

      if (trimmed === "/inbox") {
        console.log(JSON.stringify(await messageBus.readInbox("lead"), null, 2));
        continue;
      }

      history.push({ role: "user", content: query });
      await agentLoop(history);
      console.log();
    }
  } finally {
    rl.close();
  }
}

await main();
