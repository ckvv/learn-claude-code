#!/usr/bin/env node

/**
 * s11_autonomous_agents.ts - Autonomous Agents
 *
 * Adds an idle phase where teammates poll inboxes and auto-claim tasks.
 */

import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { cwd, stdin as input, stdout as output } from "node:process";
import { dirname, join, relative, resolve } from "node:path";
import { exec as execCallback } from "node:child_process";
import readline from "node:readline/promises";
import { promisify } from "node:util";

import { SimpleChatClient, type ChatMessage, type ChatTool } from "./simple_fetch_client.ts";

const exec = promisify(execCallback);
const workdir = cwd();
const client = new SimpleChatClient();
const model = process.env.MODEL_ID ?? process.env.OPENAI_MODEL ?? "deepseek-chat";
const teamDir = join(workdir, ".team");
const inboxDir = join(teamDir, "inbox");
const tasksDir = join(workdir, ".tasks");
const pollIntervalMs = 5_000;
const idleTimeoutMs = 60_000;

const systemPrompt = `You are a team lead at ${workdir}. Teammates are autonomous -- they find work themselves.`;

const validMessageTypes = [
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
] as const;

type ValidMessageType = (typeof validMessageTypes)[number];

interface BusMessage {
  type: ValidMessageType;
  from: string;
  content: string;
  timestamp: number;
  request_id?: string;
  approve?: boolean;
  feedback?: string;
  plan?: string;
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

interface TaskRecord {
  id: number;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed";
  owner?: string;
  blockedBy?: number[];
}

interface ShutdownRequest {
  target: string;
  status: "pending" | "approved" | "rejected";
}

interface PlanRequest {
  from: string;
  plan: string;
  status: "pending" | "approved" | "rejected";
}

const shutdownRequests = new Map<string, ShutdownRequest>();
const planRequests = new Map<string, PlanRequest>();

function makeRequestId(): string {
  return Math.random().toString(16).slice(2, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
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
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot"];
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

class MessageBus {
  async initialize(): Promise<void> {
    await mkdir(inboxDir, { recursive: true });
  }

  async send(
    sender: string,
    to: string,
    content: string,
    msgType: string = "message",
    extra?: Record<string, unknown>,
  ): Promise<string> {
    if (!validMessageTypes.includes(msgType as ValidMessageType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${validMessageTypes.join(", ")}`;
    }
    const message: BusMessage & Record<string, unknown> = {
      type: msgType as ValidMessageType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
      ...extra,
    };
    await appendFile(join(inboxDir, `${to}.jsonl`), `${JSON.stringify(message)}\n`, "utf8");
    return `Sent ${msgType} to ${to}`;
  }

  async readInbox(name: string): Promise<BusMessage[]> {
    const inboxPath = join(inboxDir, `${name}.jsonl`);
    const text = await readFile(inboxPath, "utf8").catch(() => "");
    if (!text.trim()) {
      return [];
    }
    const messages = text
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BusMessage);
    await writeFile(inboxPath, "", "utf8");
    return messages;
  }

  async broadcast(sender: string, content: string, teammates: string[]): Promise<string> {
    let count = 0;
    for (const teammate of teammates) {
      if (teammate !== sender) {
        await this.send(sender, teammate, content, "broadcast");
        count += 1;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

const bus = new MessageBus();

async function scanUnclaimedTasks(): Promise<TaskRecord[]> {
  await mkdir(tasksDir, { recursive: true });
  const entries = (await readdir(tasksDir).catch(() => []))
    .filter((entry) => /^task_\d+\.json$/.test(entry))
    .sort();

  const tasks: TaskRecord[] = [];
  for (const entry of entries) {
    const task = JSON.parse(await readFile(join(tasksDir, entry), "utf8")) as TaskRecord;
    if (
      task.status === "pending" &&
      !task.owner &&
      (!task.blockedBy || task.blockedBy.length === 0)
    ) {
      tasks.push(task);
    }
  }
  return tasks;
}

async function claimTask(taskId: number, owner: string): Promise<string> {
  const taskPath = join(tasksDir, `task_${taskId}.json`);
  const text = await readFile(taskPath, "utf8").catch(() => "");
  if (!text) {
    return `Error: Task ${taskId} not found`;
  }
  const task = JSON.parse(text) as TaskRecord;
  task.owner = owner;
  task.status = "in_progress";
  await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  return `Claimed task #${taskId} for ${owner}`;
}

function makeIdentityBlock(name: string, role: string, teamName: string): ChatMessage {
  return {
    role: "user",
    content: `<identity>You are '${name}', role: ${role}, team: ${teamName}. Continue your work.</identity>`,
  };
}

class TeammateManager {
  configPath = join(teamDir, "config.json");
  config: TeamConfig = { team_name: "default", members: [] };

  async initialize(): Promise<void> {
    await mkdir(teamDir, { recursive: true });
    const text = await readFile(this.configPath, "utf8").catch(() => "");
    this.config = text ? (JSON.parse(text) as TeamConfig) : { team_name: "default", members: [] };
  }

  private async save(): Promise<void> {
    await writeFile(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`, "utf8");
  }

  private findMember(name: string): TeamMember | undefined {
    return this.config.members.find((member) => member.name === name);
  }

  private async setStatus(name: string, status: TeamMember["status"]): Promise<void> {
    const member = this.findMember(name);
    if (member) {
      member.status = status;
      await this.save();
    }
  }

  async spawn(name: string, role: string, prompt: string): Promise<string> {
    const member = this.findMember(name);
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
    void this.loop(name, role, prompt);
    return `Spawned '${name}' (role: ${role})`;
  }

  private teammateTools(): ChatTool[] {
    return [
      toolSchema("bash", "Run a shell command.", {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      }),
      toolSchema("read_file", "Read file contents.", {
        type: "object",
        properties: { path: { type: "string" } },
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
      toolSchema("send_message", "Send message to a teammate.", {
        type: "object",
        properties: {
          to: { type: "string" },
          content: { type: "string" },
          msg_type: { type: "string", enum: [...validMessageTypes] },
        },
        required: ["to", "content"],
      }),
      toolSchema("read_inbox", "Read and drain your inbox.", {
        type: "object",
        properties: {},
      }),
      toolSchema("shutdown_response", "Respond to a shutdown request.", {
        type: "object",
        properties: {
          request_id: { type: "string" },
          approve: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["request_id", "approve"],
      }),
      toolSchema("plan_approval", "Submit a plan for lead approval.", {
        type: "object",
        properties: { plan: { type: "string" } },
        required: ["plan"],
      }),
      toolSchema("idle", "Signal that you have no more work. Enters idle polling phase.", {
        type: "object",
        properties: {},
      }),
      toolSchema("claim_task", "Claim a task from the task board by ID.", {
        type: "object",
        properties: { task_id: { type: "integer" } },
        required: ["task_id"],
      }),
    ];
  }

  private async teammateExec(
    sender: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    switch (name) {
      case "bash":
        return runBash(typeof args.command === "string" ? args.command : "");
      case "read_file":
        return runRead(typeof args.path === "string" ? args.path : "");
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
      case "send_message":
        return bus.send(
          sender,
          typeof args.to === "string" ? args.to : "",
          typeof args.content === "string" ? args.content : "",
          typeof args.msg_type === "string" ? args.msg_type : "message",
        );
      case "read_inbox":
        return JSON.stringify(await bus.readInbox(sender), null, 2);
      case "shutdown_response": {
        const requestId = typeof args.request_id === "string" ? args.request_id : "";
        const approve = Boolean(args.approve);
        const request = shutdownRequests.get(requestId);
        if (request) {
          request.status = approve ? "approved" : "rejected";
        }
        await bus.send(
          sender,
          "lead",
          typeof args.reason === "string" ? args.reason : "",
          "shutdown_response",
          {
            request_id: requestId,
            approve,
          },
        );
        return `Shutdown ${approve ? "approved" : "rejected"}`;
      }
      case "plan_approval": {
        const requestId = makeRequestId();
        const plan = typeof args.plan === "string" ? args.plan : "";
        planRequests.set(requestId, { from: sender, plan, status: "pending" });
        await bus.send(sender, "lead", plan, "plan_approval_response", {
          request_id: requestId,
          plan,
        });
        return `Plan submitted (request_id=${requestId}). Waiting for approval.`;
      }
      case "claim_task":
        return claimTask(typeof args.task_id === "number" ? args.task_id : -1, sender);
      default:
        return `Unknown tool: ${name}`;
    }
  }

  private async loop(name: string, role: string, prompt: string): Promise<void> {
    const teamName = this.config.team_name;
    const sysPrompt = `You are '${name}', role: ${role}, team: ${teamName}, at ${workdir}. Use idle tool when you have no more work. You will auto-claim new tasks.`;
    const messages: ChatMessage[] = [{ role: "user", content: prompt }];

    while (true) {
      for (let index = 0; index < 50; index += 1) {
        const inbox = await bus.readInbox(name);
        for (const message of inbox) {
          if (message.type === "shutdown_request") {
            await this.setStatus(name, "shutdown");
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(message) });
        }

        let assistant;
        try {
          const response = await client.createChatCompletion({
            model,
            messages: [{ role: "system", content: sysPrompt }, ...messages],
            tools: this.teammateTools(),
            tool_choice: "auto",
            temperature: 0,
          });
          assistant = response.choices?.[0]?.message;
        } catch {
          await this.setStatus(name, "idle");
          return;
        }

        if (!assistant) {
          await this.setStatus(name, "idle");
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
          let result: string;
          if (toolCall.function.name === "idle") {
            idleRequested = true;
            result = "Entering idle phase. Will poll for new tasks.";
          } else {
            result = await this.teammateExec(name, toolCall.function.name, args);
          }
          console.log(`  [${name}] ${toolCall.function.name}: ${result.slice(0, 120)}`);
          messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
        }

        if (idleRequested) {
          break;
        }
      }

      await this.setStatus(name, "idle");
      let resume = false;

      // Keep the Python phase split: work loop ends, then polling loop decides
      // whether the teammate wakes back up or shuts down.
      const polls = Math.floor(idleTimeoutMs / Math.max(pollIntervalMs, 1));
      for (let index = 0; index < polls; index += 1) {
        await sleep(pollIntervalMs);

        const inbox = await bus.readInbox(name);
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

        const unclaimed = await scanUnclaimedTasks();
        if (unclaimed.length) {
          const task = unclaimed[0];
          await claimTask(task.id, name);
          if (messages.length <= 3) {
            messages.unshift(makeIdentityBlock(name, role, teamName));
            messages.splice(1, 0, { role: "assistant", content: `I am ${name}. Continuing.` });
          }
          messages.push({
            role: "user",
            content: `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description ?? ""}</auto-claimed>`,
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

  listAll(): string {
    if (this.config.members.length === 0) {
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
}

const teammateManager = new TeammateManager();

async function handleShutdownRequest(teammate: string): Promise<string> {
  const requestId = makeRequestId();
  shutdownRequests.set(requestId, { target: teammate, status: "pending" });
  await bus.send("lead", teammate, "Please shut down gracefully.", "shutdown_request", {
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
  await bus.send("lead", request.from, feedback, "plan_approval_response", {
    request_id: requestId,
    approve,
    feedback,
  });
  return `Plan ${request.status} for '${request.from}'`;
}

function checkShutdownStatus(requestId: string): string {
  return JSON.stringify(shutdownRequests.get(requestId) ?? { error: "not found" });
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
  toolSchema("spawn_teammate", "Spawn an autonomous teammate.", {
    type: "object",
    properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } },
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
  toolSchema("broadcast", "Send a message to all teammates.", {
    type: "object",
    properties: { content: { type: "string" } },
    required: ["content"],
  }),
  toolSchema("shutdown_request", "Request a teammate to shut down.", {
    type: "object",
    properties: { teammate: { type: "string" } },
    required: ["teammate"],
  }),
  toolSchema("shutdown_response", "Check shutdown request status.", {
    type: "object",
    properties: { request_id: { type: "string" } },
    required: ["request_id"],
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
  toolSchema("idle", "Enter idle state (for lead -- rarely used).", {
    type: "object",
    properties: {},
  }),
  toolSchema("claim_task", "Claim a task from the board by ID.", {
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
    case "spawn_teammate":
      return teammateManager.spawn(
        typeof args.name === "string" ? args.name : "",
        typeof args.role === "string" ? args.role : "",
        typeof args.prompt === "string" ? args.prompt : "",
      );
    case "list_teammates":
      return teammateManager.listAll();
    case "send_message":
      return bus.send(
        "lead",
        typeof args.to === "string" ? args.to : "",
        typeof args.content === "string" ? args.content : "",
        typeof args.msg_type === "string" ? args.msg_type : "message",
      );
    case "read_inbox":
      return JSON.stringify(await bus.readInbox("lead"), null, 2);
    case "broadcast":
      return bus.broadcast(
        "lead",
        typeof args.content === "string" ? args.content : "",
        teammateManager.memberNames(),
      );
    case "shutdown_request":
      return handleShutdownRequest(typeof args.teammate === "string" ? args.teammate : "");
    case "shutdown_response":
      return checkShutdownStatus(typeof args.request_id === "string" ? args.request_id : "");
    case "plan_approval":
      return handlePlanReview(
        typeof args.request_id === "string" ? args.request_id : "",
        Boolean(args.approve),
        typeof args.feedback === "string" ? args.feedback : "",
      );
    case "idle":
      return "Lead does not idle.";
    case "claim_task":
      return claimTask(typeof args.task_id === "number" ? args.task_id : -1, "lead");
    default:
      return `Unknown tool: ${name}`;
  }
}

async function agentLoop(history: ChatMessage[]): Promise<string> {
  while (true) {
    const inbox = await bus.readInbox("lead");
    if (inbox.length) {
      history.push({ role: "user", content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>` });
      history.push({ role: "assistant", content: "Noted inbox messages." });
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
  await mkdir(tasksDir, { recursive: true });
  await bus.initialize();
  await teammateManager.initialize();

  const rl = readline.createInterface({ input, output });
  const history: ChatMessage[] = [];

  try {
    while (true) {
      const query = await rl.question("\x1b[36ms11 >> \x1b[0m");
      const trimmed = query.trim();
      if (!trimmed || ["q", "exit"].includes(trimmed.toLowerCase())) {
        break;
      }
      if (trimmed === "/team") {
        console.log(teammateManager.listAll());
        continue;
      }
      if (trimmed === "/inbox") {
        console.log(JSON.stringify(await bus.readInbox("lead"), null, 2));
        continue;
      }
      if (trimmed === "/tasks") {
        const tasks = await scanUnclaimedTasks();
        for (const task of tasks) {
          const owner = task.owner ? ` @${task.owner}` : "";
          console.log(`  [ ] #${task.id}: ${task.subject}${owner}`);
        }
        continue;
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
