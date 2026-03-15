#!/usr/bin/env node

/**
 * s10_team_protocols.ts - Team Protocols
 *
 * Adds shutdown and plan approval protocols on top of the s09 team inbox model.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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

const systemPrompt = `You are a team lead at ${workdir}. Manage teammates with shutdown and plan approval protocols.`;

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
    void this.teammateLoop(name, role, prompt);
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
      toolSchema("plan_approval", "Submit a plan for lead approval. Provide plan text.", {
        type: "object",
        properties: { plan: { type: "string" } },
        required: ["plan"],
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
        return `Plan submitted (request_id=${requestId}). Waiting for lead approval.`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  }

  private async teammateLoop(name: string, role: string, prompt: string): Promise<void> {
    const sysPrompt = `You are '${name}', role: ${role}, at ${workdir}. Submit plans via plan_approval before major work. Respond to shutdown_request with shutdown_response.`;
    const messages: ChatMessage[] = [{ role: "user", content: prompt }];
    let shouldExit = false;

    for (let index = 0; index < 50; index += 1) {
      const inbox = await bus.readInbox(name);
      for (const message of inbox) {
        messages.push({ role: "user", content: JSON.stringify(message) });
      }
      if (shouldExit) {
        break;
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
        break;
      }

      if (!assistant) {
        break;
      }

      messages.push({
        role: "assistant",
        content: assistant.content ?? "",
        tool_calls: assistant.tool_calls,
      });

      if (!assistant.tool_calls?.length) {
        break;
      }

      for (const toolCall of assistant.tool_calls) {
        const args = parseJson(toolCall.function.arguments);
        const result = await this.teammateExec(name, toolCall.function.name, args);
        console.log(`  [${name}] ${toolCall.function.name}: ${result.slice(0, 120)}`);
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
        if (toolCall.function.name === "shutdown_response" && Boolean(args.approve)) {
          shouldExit = true;
        }
      }
    }

    const member = this.findMember(name);
    if (member) {
      member.status = shouldExit ? "shutdown" : "idle";
      await this.save();
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
  return `Shutdown request ${requestId} sent to '${teammate}' (status: pending)`;
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
  toolSchema("spawn_teammate", "Spawn a persistent teammate.", {
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
  toolSchema(
    "shutdown_request",
    "Request a teammate to shut down gracefully. Returns a request_id for tracking.",
    {
      type: "object",
      properties: { teammate: { type: "string" } },
      required: ["teammate"],
    },
  ),
  toolSchema("shutdown_response", "Check the status of a shutdown request by request_id.", {
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
  await bus.initialize();
  await teammateManager.initialize();

  const rl = readline.createInterface({ input, output });
  const history: ChatMessage[] = [];

  try {
    while (true) {
      const query = await rl.question("\x1b[36ms10 >> \x1b[0m");
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
