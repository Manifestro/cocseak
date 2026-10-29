/** The wire format shared by the provider, the agent loop, and the session log. */

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string exactly as the model produced it. */
  arguments: string;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Returned by reasoning models; never sent back to the API. */
  reasoning_content?: string;
}

export interface AssistantTurn {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: Usage | undefined;
  finishReason: string | undefined;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type JsonResult = Record<string, unknown>;
