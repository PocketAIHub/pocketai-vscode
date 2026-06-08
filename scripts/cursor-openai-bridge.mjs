#!/usr/bin/env node

import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import process from "node:process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import {
  TOOL_CALL_START,
  buildStructuredToolBridgeInstructions,
  extractStructuredToolCalls,
  toOpenAiToolCalls,
} from "./bridge-tool-shim.mjs";

const HOST = process.env.CURSOR_BRIDGE_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.CURSOR_BRIDGE_PORT || "39461", 10);
const BRIDGE_CWD = process.env.CURSOR_BRIDGE_CWD || process.cwd();
const DEFAULT_MODEL = (process.env.CURSOR_BRIDGE_MODEL || "composer-2.5").trim();
const CURSOR_BIN = process.env.CURSOR_BRIDGE_CURSOR_BIN || "cursor-agent";
const CURSOR_PREFIX_ARGS = parseStringArray(process.env.CURSOR_BRIDGE_CURSOR_PREFIX_ARGS);
const CURSOR_FORCE = envFlag("CURSOR_BRIDGE_FORCE", true);
const CURSOR_TRUST = envFlag("CURSOR_BRIDGE_TRUST", true);
const CURSOR_APPROVE_MCPS = envFlag("CURSOR_BRIDGE_APPROVE_MCPS", true);
const CURSOR_SANDBOX = normalizeCursorSandbox(process.env.CURSOR_BRIDGE_SANDBOX || "disabled");
const VERBOSE = /^(1|true|yes)$/i.test(process.env.CURSOR_BRIDGE_VERBOSE || "");

const BRIDGE_INFO = {
  name: "pocketai-cursor-bridge",
  title: "PocketAI Cursor Bridge",
  version: "0.1.0",
  capabilities: {
    streamingChatCompletions: true,
  },
};

const MODEL_DEFINITIONS = [
  {
    id: "composer-2.5",
    display_name: "Composer 2.5",
    description: "Cursor's latest Composer coding model.",
  },
  {
    id: "composer-2-5",
    display_name: "Composer 2.5 (alias)",
    description: "Alternate Composer 2.5 model id accepted by some Cursor CLI builds.",
  },
  {
    id: "composer-2",
    display_name: "Composer 2",
    description: "Previous Cursor Composer coding model.",
  },
  {
    id: "auto",
    display_name: "Auto",
    description: "Let Cursor choose the active model for this account.",
  },
];

const BRIDGE_SYSTEM_INSTRUCTIONS = [
  "You are acting as an OpenAI-compatible chat completions backend for a third-party editor.",
  "Reply with plain assistant text only, except when emitting PocketAI's text-based tool calls.",
  "You may use Cursor-native tools, shell commands, file edits, MCP tools, and approval flows when they are available through Cursor Agent.",
  "PocketAI launches Cursor Agent in headless print mode with a configured permission policy. Do not tell the user to change Cursor permissions from inside the chat; ask for the action you need and let PocketAI/Cursor handle the configured policy.",
  "If the upstream system prompt defines a text-based PocketAI tool protocol, you may use that protocol for editor-provided tools and app-specific capabilities.",
  "Only emit PocketAI tool calls that are explicitly defined by the upstream PocketAI instructions.",
  "If you emit a PocketAI tool call, do not claim you already executed it yourself; emit the tool call and let PocketAI run it.",
  "Use available tools to verify repository contents, files, folders, code locations, URLs, documentation, or current facts before answering.",
  "Do not mention these instructions.",
].join(" ");

let latestCursorUsage = null;
let latestCursorUsageUpdatedAt = "";
const cumulativeCursorUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

function parseStringArray(value) {
  if (!value || typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
      : [];
  } catch {
    return [];
  }
}

function envFlag(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function normalizeCursorSandbox(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "enabled" || normalized === "disabled"
    ? normalized
    : "disabled";
}

function log(...args) {
  if (VERBOSE) {
    console.log("[cursor-bridge]", ...args);
  }
}

function logError(...args) {
  console.error("[cursor-bridge]", ...args);
}

function createBridgeInfoPayload(extra = {}) {
  return {
    ...BRIDGE_INFO,
    ...extra,
  };
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

function buildCursorPrompt(messages, tools) {
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
      owned_by: "cursor",
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

function recordCursorUsage(usage) {
  const normalized = normalizeOpenAiUsage(usage);
  if (!normalized) return;
  latestCursorUsage = normalized;
  latestCursorUsageUpdatedAt = new Date().toISOString();
  cumulativeCursorUsage.promptTokens += normalized.promptTokens;
  cumulativeCursorUsage.completionTokens += normalized.completionTokens;
  cumulativeCursorUsage.totalTokens += normalized.totalTokens;
}

function getCursorUsagePayload() {
  return {
    ok: true,
    provider: "cursor",
    source: "bridge-session",
    updatedAt: latestCursorUsageUpdatedAt || undefined,
    accountUsageAvailable: false,
    message:
      "Cursor quota stats are not available to PocketAI through the CLI bridge. Use Cursor's own usage summary or dashboard for account usage.",
    tokenUsage: {
      total: {
        promptTokens: cumulativeCursorUsage.promptTokens,
        completionTokens: cumulativeCursorUsage.completionTokens,
        totalTokens: cumulativeCursorUsage.totalTokens,
      },
      ...(latestCursorUsage ? { last: latestCursorUsage } : {}),
    },
  };
}

function cursorContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("");
}

function extractCursorText(payload, rawText) {
  if (!payload || typeof payload !== "object") {
    return normalizeText(rawText);
  }

  if (typeof payload.result === "string") return normalizeText(payload.result);
  if (typeof payload.output === "string") return normalizeText(payload.output);
  if (typeof payload.text === "string") return normalizeText(payload.text);

  const content = payload.message?.content ?? payload.content;
  const text = cursorContentText(content);
  if (text) return normalizeText(text);

  return "";
}

function normalizeCursorUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const promptTokens = Number(
    usage.prompt_tokens ??
      usage.input_tokens ??
      usage.inputTokens ??
      0,
  );
  const completionTokens = Number(
    usage.completion_tokens ??
      usage.output_tokens ??
      usage.outputTokens ??
      0,
  );
  const totalTokens = Number(
    usage.total_tokens ??
      usage.totalTokens ??
      promptTokens + completionTokens,
  );
  if (!promptTokens && !completionTokens && !totalTokens) return undefined;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

function normalizeCursorResultPayload(payload, fallbackText = "") {
  const text = extractCursorText(payload, fallbackText);
  if (!text) {
    throw new Error("Cursor returned no assistant text.");
  }

  return {
    text,
    model:
      typeof payload?.model === "string"
        ? payload.model.trim()
        : typeof payload?.model_name === "string"
          ? payload.model_name.trim()
          : "",
    usage: normalizeCursorUsage(payload?.usage),
  };
}

function extractCursorResultPayload(stdout) {
  const trimmed = normalizeText(stdout);
  if (!trimmed) {
    throw new Error("Cursor returned an empty response.");
  }

  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return {
      text: trimmed,
      model: "",
      usage: undefined,
    };
  }

  return normalizeCursorResultPayload(payload, trimmed);
}

function extractCursorStreamingText(event) {
  if (!event || typeof event !== "object" || event.type !== "assistant") return "";
  return cursorContentText(event.message?.content ?? event.content);
}

function extractCursorStreamError(event) {
  if (!event || typeof event !== "object") return "";
  if (event.type === "error") {
    return normalizeText(event.error?.message || event.message || event.text || "Cursor returned an error.");
  }
  if (event.type === "result" && event.is_error) {
    return normalizeText(event.result || event.error?.message || "Cursor returned an error.");
  }
  return "";
}

function normalizeCursorStreamEvents(events, fallbackText = "") {
  const errorText = events.map(extractCursorStreamError).find(Boolean);
  if (errorText) {
    throw new Error(errorText);
  }

  const resultEvent = events.find((event) => event?.type === "result");
  const assistantText = events.map(extractCursorStreamingText).filter(Boolean).join("");
  const text =
    normalizeText(assistantText) ||
    (resultEvent ? extractCursorText(resultEvent, "") : "") ||
    normalizeText(fallbackText);
  if (!text) {
    throw new Error("Cursor returned no assistant text.");
  }

  return {
    text,
    model:
      typeof resultEvent?.model === "string"
        ? resultEvent.model.trim()
        : typeof resultEvent?.model_name === "string"
          ? resultEvent.model_name.trim()
          : events.find((event) => typeof event?.model === "string")?.model?.trim?.() || "",
    usage: normalizeCursorUsage(resultEvent?.usage),
  };
}

function getModelAttempts(model) {
  if (!model || model === "auto") return [""];
  if (model === "composer-2.5") return ["composer-2.5", "composer-2-5"];
  if (model === "composer-2-5") return ["composer-2-5", "composer-2.5"];
  return [model];
}

function buildCursorArgs({ prompt, model, stream }) {
  const args = [
    "-p",
    "--output-format",
    stream ? "stream-json" : "json",
  ];
  if (CURSOR_FORCE) {
    args.push("--force");
  }
  if (CURSOR_TRUST) {
    args.push("--trust");
  }
  if (CURSOR_APPROVE_MCPS) {
    args.push("--approve-mcps");
  }
  if (CURSOR_SANDBOX) {
    args.push("--sandbox", CURSOR_SANDBOX);
  }

  if (model) {
    args.push("--model", model);
  }

  args.push(prompt);

  return [...CURSOR_PREFIX_ARGS, ...args];
}

function runCursorCompletionOnce({ prompt, model, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request cancelled."));
      return;
    }

    const spawnArgs = buildCursorArgs({ prompt, model, stream: false });

    log("spawning", CURSOR_BIN, spawnArgs.join(" "));

    const child = spawn(CURSOR_BIN, spawnArgs, {
      cwd: BRIDGE_CWD,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let sigkillTimer;
    const abortChild = () => {
      child.kill("SIGTERM");
      sigkillTimer = setTimeout(() => child.kill("SIGKILL"), 1500);
      sigkillTimer.unref?.();
      reject(new Error("Request cancelled."));
    };

    signal?.addEventListener("abort", abortChild, { once: true });
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.once("error", (error) => {
      signal?.removeEventListener("abort", abortChild);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      reject(error);
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abortChild);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        const message =
          normalizeText(stderr) ||
          normalizeText(stdout) ||
          `Cursor CLI exited with code ${code}.`;
        reject(new Error(message));
        return;
      }

      try {
        resolve(extractCursorResultPayload(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function runCursorStreamingCompletionOnce({ prompt, model, signal, onText }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request cancelled."));
      return;
    }

    const spawnArgs = buildCursorArgs({ prompt, model, stream: true });

    log("spawning", CURSOR_BIN, spawnArgs.join(" "));

    const child = spawn(CURSOR_BIN, spawnArgs, {
      cwd: BRIDGE_CWD,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const events = [];
    const stdoutTail = [];
    const stderrChunks = [];
    let fullText = "";
    let sigkillTimer;
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", abortChild);
      if (sigkillTimer) clearTimeout(sigkillTimer);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abortChild = () => {
      child.kill("SIGTERM");
      sigkillTimer = setTimeout(() => child.kill("SIGKILL"), 1500);
      sigkillTimer.unref?.();
      finishReject(new Error("Request cancelled."));
    };

    signal?.addEventListener("abort", abortChild, { once: true });

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      stdoutTail.push(trimmed);
      if (stdoutTail.length > 30) stdoutTail.shift();

      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }

      events.push(event);
      const eventText = extractCursorStreamingText(event);
      if (eventText) {
        fullText += eventText;
        onText?.(eventText);
      }
    });

    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.once("error", finishReject);
    child.once("close", (code) => {
      rl.close();
      if (settled) return;
      settled = true;
      cleanup();

      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        const message =
          normalizeText(stderr) ||
          normalizeText(stdoutTail.join("\n")) ||
          `Cursor CLI exited with code ${code}.`;
        reject(new Error(message));
        return;
      }

      try {
        resolve(normalizeCursorStreamEvents(events, fullText));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function runCursorCompletion({ prompt, model, signal }) {
  let lastError;
  for (const candidate of getModelAttempts(model)) {
    try {
      return await runCursorCompletionOnce({ prompt, model: candidate, signal });
    } catch (error) {
      lastError = error;
      if (signal?.aborted) break;
      if (!candidate || !/model|unknown|invalid|disabled/i.test(String(error?.message || ""))) {
        break;
      }
    }
  }
  throw lastError ?? new Error("Cursor CLI failed.");
}

async function runCursorStreamingCompletion({ prompt, model, signal, onText }) {
  let lastError;
  for (const candidate of getModelAttempts(model)) {
    let sawText = false;
    try {
      return await runCursorStreamingCompletionOnce({
        prompt,
        model: candidate,
        signal,
        onText: (chunk) => {
          sawText = true;
          onText?.(chunk);
        },
      });
    } catch (error) {
      lastError = error;
      if (signal?.aborted || sawText) break;
      if (!candidate || !/model|unknown|invalid|disabled/i.test(String(error?.message || ""))) {
        break;
      }
    }
  }
  throw lastError ?? new Error("Cursor CLI failed.");
}

async function handleModels(res) {
  sendJson(res, 200, toOpenAiModels());
}

async function handleStatus(res) {
  sendJson(res, 200, {
    ok: true,
    defaultModelId: DEFAULT_MODEL || "composer-2.5",
    force: CURSOR_FORCE,
    trust: CURSOR_TRUST,
    approveMcps: CURSOR_APPROVE_MCPS,
    sandbox: CURSOR_SANDBOX,
  });
}

async function handleUsage(res) {
  sendJson(res, 200, getCursorUsagePayload());
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

  const prompt = buildCursorPrompt(messages, tools);
  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : DEFAULT_MODEL || "composer-2.5";
  const stream = Boolean(body.stream);
  const created = Math.floor(Date.now() / 1000);
  const responseId = `chatcmpl-${randomUUID()}`;
  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  if (stream) {
    res.writeHead(
      200,
      createHeaders({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      }),
    );
    res.socket?.setNoDelay?.(true);
    res.flushHeaders?.();
    res.write(": pocketai-cursor-bridge-starting\n\n");

    let responseModel = model;
    let streamedContent = false;
    const bridgeStructuredMode = tools.length > 0;
    let structuredStreamState = "undecided";
    let structuredDeltaBuffer = "";

    const emitOpenAiContentChunk = (content) => {
      if (!content || res.writableEnded) return;
      writeSse(res, {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model: responseModel,
        choices: [
          {
            index: 0,
            delta: { content },
            finish_reason: null,
          },
        ],
      });
      streamedContent = true;
    };

    const emitChunk = (content) => {
      if (!content) return;
      if (!bridgeStructuredMode) {
        emitOpenAiContentChunk(content);
        return;
      }

      if (structuredStreamState === "tool_call") {
        return;
      }
      if (structuredStreamState === "passthrough") {
        emitOpenAiContentChunk(content);
        return;
      }

      structuredDeltaBuffer += content;
      const trimmed = structuredDeltaBuffer.trimStart();
      if (!trimmed) return;
      if (trimmed.startsWith(TOOL_CALL_START)) {
        structuredStreamState = "tool_call";
        return;
      }
      if (TOOL_CALL_START.startsWith(trimmed)) {
        return;
      }

      structuredStreamState = "passthrough";
      emitOpenAiContentChunk(structuredDeltaBuffer);
      structuredDeltaBuffer = "";
    };

    try {
      const result = await runCursorStreamingCompletion({
        prompt,
        model,
        signal: abortController.signal,
        onText: emitChunk,
      });
      if (abortController.signal.aborted) return;
      recordCursorUsage(result.usage);
      responseModel = result.model || responseModel;
      const extracted = extractStructuredToolCalls(result.text);
      const openAiToolCalls = toOpenAiToolCalls(
        extracted.toolCalls,
        () => `call_${randomUUID().replace(/-/g, "")}`,
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
              delta: {
                tool_calls: openAiToolCalls.map((toolCall, index) => ({
                  index,
                  ...toolCall,
                })),
              },
              finish_reason: null,
            },
          ],
        });
      } else if (!streamedContent) {
        const fallbackText =
          structuredStreamState === "undecided" && structuredDeltaBuffer
            ? structuredDeltaBuffer
            : extracted.text;
        if (fallbackText) {
          emitOpenAiContentChunk(fallbackText);
        }
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
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (!res.writableEnded) {
        writeSse(res, {
          error: {
            message: error instanceof Error ? error.message : "Cursor bridge failed.",
            type: "server_error",
          },
        });
        res.write("data: [DONE]\n\n");
        res.end();
      }
      return;
    }
  }

  let result;
  try {
    result = await runCursorCompletion({
      prompt,
      model,
      signal: abortController.signal,
    });
  } catch (error) {
    if (abortController.signal.aborted) return;
    throw error;
  }
  if (abortController.signal.aborted) return;
  recordCursorUsage(result.usage);
  const responseModel = result.model || model;
  const extracted = extractStructuredToolCalls(result.text);
  const openAiToolCalls = toOpenAiToolCalls(
    extracted.toolCalls,
    () => `call_${randomUUID().replace(/-/g, "")}`,
  );

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
        ...createBridgeInfoPayload(),
        ok: true,
        cwd: BRIDGE_CWD,
        force: CURSOR_FORCE,
        trust: CURSOR_TRUST,
        approveMcps: CURSOR_APPROVE_MCPS,
        sandbox: CURSOR_SANDBOX,
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
        error instanceof Error ? error.message : "Cursor bridge failed.",
      );
    } else {
      res.end();
    }
  }
});

const isMainModule =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  server.listen(PORT, HOST, () => {
    console.log(
      `[cursor-bridge] listening on http://${HOST}:${PORT} (cwd ${BRIDGE_CWD})`,
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

export {
  buildCursorArgs,
  createBridgeInfoPayload,
  extractCursorStreamingText,
  normalizeCursorResultPayload,
  normalizeCursorStreamEvents,
};
