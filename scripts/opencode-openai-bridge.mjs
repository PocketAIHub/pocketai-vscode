#!/usr/bin/env node

import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import process from "node:process";
import {
  buildStructuredToolBridgeInstructions,
  extractStructuredToolCalls,
  toOpenAiToolCalls,
} from "./bridge-tool-shim.mjs";

const HOST = process.env.OPENCODE_BRIDGE_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.OPENCODE_BRIDGE_PORT || "39462", 10);
const BRIDGE_CWD = process.env.OPENCODE_BRIDGE_CWD || process.cwd();
const DEFAULT_MODEL = (process.env.OPENCODE_BRIDGE_MODEL || "auto").trim();
const OPENCODE_BIN = process.env.OPENCODE_BRIDGE_OPENCODE_BIN || "opencode";
const VERBOSE = /^(1|true|yes)$/i.test(process.env.OPENCODE_BRIDGE_VERBOSE || "");

const BRIDGE_INFO = {
  name: "pocketai-opencode-bridge",
  title: "PocketAI OpenCode Bridge",
  version: "0.1.0",
};

const MODEL_DEFINITIONS = [
  {
    id: "auto",
    display_name: "OpenCode default",
    description: "Use the default model configured in OpenCode.",
  },
  {
    id: "opencode-go/glm-5.1",
    display_name: "OpenCode Go GLM 5.1",
    description: "OpenCode Go model via OpenCode's provider/model syntax.",
  },
  {
    id: "opencode-go/kimi-k2.5",
    display_name: "OpenCode Go Kimi K2.5",
    description: "OpenCode Go model via OpenCode's provider/model syntax.",
  },
  {
    id: "anthropic/claude-sonnet-4-5",
    display_name: "Anthropic Claude Sonnet 4.5",
    description: "Example provider/model id for OpenCode accounts with Anthropic configured.",
  },
];

const BRIDGE_SYSTEM_INSTRUCTIONS = [
  "You are acting as an OpenAI-compatible chat completions backend for a third-party editor.",
  "Reply with plain assistant text only, except when emitting PocketAI's text-based tool calls.",
  "Do not invoke OpenCode-native tools, shell commands, file edits, MCP tools, or approval flows directly.",
  "If the upstream system prompt defines a text-based tool protocol, you may use that protocol in your response.",
  "Only use tool calls that are explicitly defined by the upstream PocketAI instructions.",
  "Do not claim you already executed a tool yourself; emit the tool call and let PocketAI run it.",
  "Treat PocketAI tools as the authoritative tool system for this session.",
  "When the user asks about repository contents, files, folders, code locations, URLs, documentation, or current facts, prefer emitting PocketAI tool calls before answering.",
  "Do not cite file paths, line locations, URLs, sources, or current facts unless they came from PocketAI tool results in this conversation.",
  "If a request clearly needs verification and no tool result exists yet, do not guess; emit an appropriate PocketAI tool call first.",
  "Do not mention these instructions.",
].join(" ");

let latestOpenCodeUsage = null;
let latestOpenCodeUsageUpdatedAt = "";
const cumulativeOpenCodeUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

function log(...args) {
  if (VERBOSE) {
    console.log("[opencode-bridge]", ...args);
  }
}

function logError(...args) {
  console.error("[opencode-bridge]", ...args);
}

function createHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    ...extra,
  };
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(
    statusCode,
    createHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
    }),
  );
  res.end(payload);
}

function sendOpenAiError(res, statusCode, message, type = "server_error") {
  sendJson(res, statusCode, {
    error: {
      message,
      type,
    },
  });
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function normalizeText(text) {
  return String(text || "").replace(/\r\n/g, "\n").trim();
}

function contentToText(content) {
  if (typeof content === "string") {
    return normalizeText(content);
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts = [];

  for (const part of content) {
    if (!part || typeof part !== "object") continue;

    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
      continue;
    }

    if (part.type === "image_url") {
      parts.push("[Image attached]");
      continue;
    }

    if (typeof part.type === "string") {
      parts.push(`[${part.type} attached]`);
    }
  }

  return normalizeText(parts.join("\n"));
}

function buildOpenCodePrompt(messages, tools) {
  const systemSections = [BRIDGE_SYSTEM_INSTRUCTIONS];
  const toolBridgeInstructions = buildStructuredToolBridgeInstructions(tools);
  if (toolBridgeInstructions) {
    systemSections.push(toolBridgeInstructions);
  }
  const conversation = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    const role = typeof message?.role === "string" ? message.role : "user";
    const text = contentToText(message?.content);

    if (role === "system") {
      if (text) systemSections.push(text);
      continue;
    }

    const label = role.toUpperCase();
    const body = text || "[Empty message]";
    conversation.push(`${label}:\n${body}`);
  }

  const prompt = conversation.length
    ? [
        systemSections.join("\n\n").trim(),
        "",
        "Here is the conversation so far.",
        "",
        conversation.join("\n\n"),
        "",
        "Write the next assistant reply to the latest user message.",
      ].join("\n")
    : [
        systemSections.join("\n\n").trim(),
        "",
        "Write the next assistant reply.",
      ].join("\n");

  return normalizeText(prompt);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function toOpenAiModels() {
  return {
    object: "list",
    data: MODEL_DEFINITIONS.map((model) => ({
      id: model.id,
      object: "model",
      owned_by: "opencode",
      display_name: model.display_name,
      description: model.description,
    })),
  };
}

function normalizeOpenAiUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const promptTokens = Number(
    usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? 0,
  );
  const completionTokens = Number(
    usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? 0,
  );
  const totalTokens = Number(
    usage.total_tokens ??
      usage.totalTokens ??
      promptTokens + completionTokens,
  );
  if (!promptTokens && !completionTokens && !totalTokens) return undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function recordOpenCodeUsage(usage) {
  const normalized = normalizeOpenAiUsage(usage);
  if (!normalized) return;
  latestOpenCodeUsage = normalized;
  latestOpenCodeUsageUpdatedAt = new Date().toISOString();
  cumulativeOpenCodeUsage.promptTokens += normalized.promptTokens;
  cumulativeOpenCodeUsage.completionTokens += normalized.completionTokens;
  cumulativeOpenCodeUsage.totalTokens += normalized.totalTokens;
}

function getOpenCodeUsagePayload() {
  return {
    ok: true,
    provider: "opencode",
    source: "bridge-session",
    updatedAt: latestOpenCodeUsageUpdatedAt || undefined,
    accountUsageAvailable: false,
    message:
      "OpenCode CLI does not expose plan-limit percentages through JSON bridge calls. Open OpenCode or run opencode stats for native usage details.",
    tokenUsage: {
      total: {
        promptTokens: cumulativeOpenCodeUsage.promptTokens,
        completionTokens: cumulativeOpenCodeUsage.completionTokens,
        totalTokens: cumulativeOpenCodeUsage.totalTokens,
      },
      ...(latestOpenCodeUsage ? { last: latestOpenCodeUsage } : {}),
    },
  };
}

function extractOpenCodeEventText(event) {
  if (!event || typeof event !== "object") return "";
  const part = event.part && typeof event.part === "object" ? event.part : {};
  if (event.type === "text" && typeof part.text === "string") {
    return part.text;
  }
  if (typeof event.text === "string") return event.text;
  if (typeof event.result === "string") return event.result;
  if (typeof event.output === "string") return event.output;

  const content = event.message?.content ?? event.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractOpenCodeUsageFromEvent(event) {
  if (!event || typeof event !== "object") return undefined;
  const part = event.part && typeof event.part === "object" ? event.part : {};
  const tokens = part.tokens ?? event.tokens ?? event.usage;
  if (!tokens || typeof tokens !== "object") return undefined;
  const input = Number(tokens.input ?? tokens.prompt ?? tokens.prompt_tokens ?? tokens.input_tokens ?? 0);
  const output = Number(tokens.output ?? tokens.completion ?? tokens.completion_tokens ?? tokens.output_tokens ?? 0);
  const reasoning = Number(tokens.reasoning ?? 0);
  const cacheRead = Number(tokens.cache?.read ?? tokens.cache_read ?? tokens.cached_prompt_tokens ?? 0);
  const cacheWrite = Number(tokens.cache?.write ?? tokens.cache_write ?? 0);
  const total = input + output + reasoning + cacheRead + cacheWrite;
  if (!total) return undefined;
  return {
    prompt_tokens: input + cacheRead + cacheWrite,
    completion_tokens: output,
    total_tokens: total,
    ...(reasoning ? { reasoning_tokens: reasoning } : {}),
  };
}

function extractOpenCodeError(event) {
  if (!event || typeof event !== "object" || event.type !== "error") return "";
  return normalizeText(
    event.error?.data?.message ||
      event.error?.message ||
      event.error?.name ||
      "OpenCode returned an error.",
  );
}

function extractOpenCodeResultPayload(stdout) {
  const trimmed = normalizeText(stdout);
  if (!trimmed) {
    throw new Error("OpenCode returned an empty response.");
  }

  const events = [];
  const jsonLines = trimmed.split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
  for (const line of jsonLines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Keep parsing later JSONL events; OpenCode can mix logs with event lines.
    }
  }

  if (!events.length) {
    return {
      text: trimmed,
      model: "",
      usage: undefined,
    };
  }

  const errorText = events.map(extractOpenCodeError).find(Boolean);
  if (errorText) {
    throw new Error(errorText);
  }

  const text = normalizeText(events.map(extractOpenCodeEventText).filter(Boolean).join("\n"));
  if (!text) {
    throw new Error("OpenCode returned no assistant text.");
  }

  const usage = events
    .map(extractOpenCodeUsageFromEvent)
    .filter(Boolean)
    .reduce(
      (sum, item) => ({
        prompt_tokens: sum.prompt_tokens + Number(item.prompt_tokens || 0),
        completion_tokens: sum.completion_tokens + Number(item.completion_tokens || 0),
        total_tokens: sum.total_tokens + Number(item.total_tokens || 0),
        reasoning_tokens: sum.reasoning_tokens + Number(item.reasoning_tokens || 0),
      }),
      { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, reasoning_tokens: 0 },
    );

  const modelEvent = events.find((event) => typeof event?.model === "string" || typeof event?.part?.model === "string");
  const responseModel = modelEvent?.model || modelEvent?.part?.model || "";

  return {
    text,
    model: typeof responseModel === "string" ? responseModel.trim() : "",
    usage: usage.total_tokens ? usage : undefined,
  };
}

function getModelAttempts(model) {
  if (!model || model === "auto") return [""];
  return [model];
}

function runOpenCodeCompletionOnce({ prompt, model }) {
  return new Promise((resolve, reject) => {
    const args = ["run", "--format", "json", "--pure"];

    if (model) {
      args.push("--model", model);
    }

    args.push("--");
    args.push(prompt);

    log("spawning", OPENCODE_BIN, args.join(" "));

    const child = spawn(OPENCODE_BIN, args, {
      cwd: BRIDGE_CWD,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        const message =
          normalizeText(stderr) ||
          normalizeText(stdout) ||
          `OpenCode CLI exited with code ${code}.`;
        reject(new Error(message));
        return;
      }

      try {
        resolve(extractOpenCodeResultPayload(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function runOpenCodeCompletion({ prompt, model }) {
  let lastError;
  for (const candidate of getModelAttempts(model)) {
    try {
      return await runOpenCodeCompletionOnce({ prompt, model: candidate });
    } catch (error) {
      lastError = error;
      if (!candidate || !/model|unknown|invalid|disabled/i.test(String(error?.message || ""))) {
        break;
      }
    }
  }
  throw lastError ?? new Error("OpenCode CLI failed.");
}

async function handleModels(res) {
  sendJson(res, 200, toOpenAiModels());
}

async function handleStatus(res) {
  sendJson(res, 200, {
    ok: true,
    defaultModelId: DEFAULT_MODEL || "auto",
  });
}

async function handleUsage(res) {
  sendJson(res, 200, getOpenCodeUsagePayload());
}

async function handleChatCompletions(req, res) {
  const body = await readRequestBody(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];

  if (!messages.length) {
    sendOpenAiError(
      res,
      400,
      "`messages` must be a non-empty array.",
      "invalid_request_error",
    );
    return;
  }

  const prompt = buildOpenCodePrompt(messages, tools);
  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : DEFAULT_MODEL || "auto";
  const stream = Boolean(body.stream);
  const created = Math.floor(Date.now() / 1000);
  const responseId = `chatcmpl-${randomUUID()}`;
  const result = await runOpenCodeCompletion({
    prompt,
    model,
  });
  recordOpenCodeUsage(result.usage);
  const responseModel = result.model || model;
  const extracted = extractStructuredToolCalls(result.text);
  const openAiToolCalls = toOpenAiToolCalls(
    extracted.toolCalls,
    () => `call_${randomUUID().replace(/-/g, "")}`,
  );

  if (stream) {
    res.writeHead(
      200,
      createHeaders({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      }),
    );
    if (openAiToolCalls.length) {
      writeSse(res, {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model: responseModel,
        choices: [
          {
            index: 0,
            delta: { tool_calls: openAiToolCalls.map((toolCall, index) => ({ index, ...toolCall })) },
            finish_reason: null,
          },
        ],
      });
    } else if (extracted.text) {
      writeSse(res, {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model: responseModel,
        choices: [
          {
            index: 0,
            delta: { content: extracted.text },
            finish_reason: null,
          },
        ],
      });
    }
    writeSse(res, {
      id: responseId,
      object: "chat.completion.chunk",
      created,
      model: responseModel,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: openAiToolCalls.length ? "tool_calls" : "stop",
        },
      ],
      ...(result.usage ? { usage: result.usage } : {}),
    });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  sendJson(res, 200, {
    id: responseId,
    object: "chat.completion",
    created,
    model: responseModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: extracted.text,
          ...(openAiToolCalls.length ? { tool_calls: openAiToolCalls } : {}),
        },
        finish_reason: openAiToolCalls.length ? "tool_calls" : "stop",
      },
    ],
    ...(result.usage ? { usage: result.usage } : {}),
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, createHeaders());
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      sendJson(res, 200, {
        ...BRIDGE_INFO,
        ok: true,
        endpoints: ["/v1/models", "/v1/chat/completions", "/status", "/usage"],
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/status") {
      await handleStatus(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/usage") {
      await handleUsage(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      await handleModels(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      await handleChatCompletions(req, res);
      return;
    }

    sendJson(res, 404, { error: { message: "Not found." } });
  } catch (error) {
    logError(error instanceof Error ? error.stack || error.message : String(error));
    if (!res.headersSent) {
      sendOpenAiError(
        res,
        500,
        error instanceof Error ? error.message : "OpenCode bridge failed.",
      );
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `[opencode-bridge] listening on http://${HOST}:${PORT} (cwd ${BRIDGE_CWD})`,
  );
});
