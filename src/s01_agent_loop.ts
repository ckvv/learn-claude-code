#!/usr/bin/env node

/**
 * s01_agent_loop.ts - The Agent Loop
 *
 * The core pattern:
 *
 *   while tool_calls:
 *     response = LLM(messages, tools)
 *     execute tools
 *     append tool results
 */

import { cwd } from "node:process";
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { SimpleChatClient, type ChatMessage, type ChatTool } from "./simple_fetch_client.ts";

const exec = promisify(execCallback);
const client = new SimpleChatClient();
const model = process.env.MODEL_ID ?? process.env.OPENAI_MODEL ?? "deepseek-chat";

const systemPrompt = `You are a coding agent at ${cwd()}. Use bash to solve tasks. Act, don't explain.`;

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
];

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

async function runBash(command: string): Promise<string> {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((item) => command.includes(item))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const { stdout, stderr } = await exec(command, {
      cwd: cwd(),
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
      const command = typeof args.command === "string" ? args.command : "";

      console.log(`\x1b[33m$ ${command}\x1b[0m`);
      const result = await runBash(command);
      console.log(result.slice(0, 200));

      history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  const history: ChatMessage[] = [];

  try {
    while (true) {
      const query = await rl.question("\x1b[36ms01 >> \x1b[0m");
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
