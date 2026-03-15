import { loadEnvFile } from "node:process";
import { appendFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

loadEnvFile(".env");
const logFilePath = resolve(process.cwd(), "request.log");
let logSequence = 0;
await writeFile(logFilePath, "");

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: "auto" | "none";
  temperature?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: ChatMessage;
  }>;
  error?: {
    message?: string;
  };
}

export interface SimpleChatClientOptions {
  apiKey?: string;
  baseUrl?: string;
}

export class SimpleChatClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: SimpleChatClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "").replace(/\/+$/, "");

    if (!this.apiKey) {
      throw new Error(
        "Missing API key. Set OPENAI_API_KEY or DEEPSEEK_API_KEY in the environment or .env.",
      );
    }
  }
  async createChatCompletion(payload: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const logPrefix = `req-${++logSequence}`;
    await SimpleChatClient.writeLog(`🧑🧑🧑---${logPrefix}`, payload.messages);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const data = (await response.json()) as ChatCompletionResponse;
    await SimpleChatClient.writeLog(`🤖🤖🤖---${logPrefix}`, data.choices);

    if (!response.ok) {
      throw new Error(data.error?.message || `Request failed with ${response.status}`);
    }
    return data;
  }

  private static async writeLog(label: string, value: unknown): Promise<void> {
    const entry = `${label}\n${JSON.stringify(value, null, 2)}\n`;
    await appendFile(logFilePath, entry);
  }
}
