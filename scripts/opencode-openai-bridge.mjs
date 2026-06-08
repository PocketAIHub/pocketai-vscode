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

const HOST = process.env.OPENCODE_BRIDGE_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.OPENCODE_BRIDGE_PORT || "39462", 10);
const BRIDGE_CWD = process.env.OPENCODE_BRIDGE_CWD || process.cwd();
const DEFAULT_MODEL = (process.env.OPENCODE_BRIDGE_MODEL || "auto").trim();
const OPENCODE_BIN = process.env.OPENCODE_BRIDGE_OPENCODE_BIN || "opencode";
const OPENCODE_PURE = /^(1|true|yes)$/i.test(
  process.env.OPENCODE_BRIDGE_PURE || "",
);
const VERBOSE = /^(1|true|yes)$/i.test(process.env.OPENCODE_BRIDGE_VERBOSE || "");
const OPENCODE_STATS_TIMEOUT_MS = Number.parseInt(
  process.env.OPENCODE_BRIDGE_STATS_TIMEOUT_MS || "20000",
  10,
);
const OPENCODE_STATS_CACHE_TTL_MS = Number.parseInt(
  process.env.OPENCODE_BRIDGE_STATS_CACHE_TTL_MS || "30000",
  10,
);

const BRIDGE_INFO = {
  name: "pocketai-opencode-bridge",
  title: "PocketAI OpenCode Bridge",
  version: "0.1.0",
  capabilities: {
    streamingChatCompletions: true,
  },
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
  "You may use OpenCode-native tools, shell commands, file edits, MCP tools, and approval flows when they are available through OpenCode.",
  "PocketAI launches OpenCode in non-interactive run mode. Do not tell the user to change OpenCode permissions from inside the chat; ask for the action you need and let PocketAI/OpenCode handle the configured policy.",
  "If the upstream system prompt defines a text-based PocketAI tool protocol, you may use that protocol for editor-provided tools and app-specific capabilities.",
  "Only emit PocketAI tool calls that are explicitly defined by the upstream PocketAI instructions.",
  "If you emit a PocketAI tool call, do not claim you already executed it yourself; emit the tool call and let PocketAI run it.",
  "Use available tools to verify repository contents, files, folders, code locations, URLs, documentation, or current facts before answering.",
  "Do not mention these instructions.",
].join(" ");

let latestOpenCodeUsage = null;
let latestOpenCodeUsageUpdatedAt = "";
const cumulativeOpenCodeUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};
let opencodeStatsCache = {
  expiresAt: 0,
  payload: undefined,
  error: undefined,
};

function log(...args) {
  if (VERBOSE) {
    console.log("[opencode-bridge]", ...args);
  }
}

function logError(...args) {
  console.error("[opencode-bridge]", ...args);
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

function stripAnsi(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function parseCompactTokenCount(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/,/g, "");
  if (!cleaned) return 0;
  const match = cleaned.match(/^([\d.]+)\s*([KMB])?$/i);
  if (!match) {
    const parsed = Number.parseFloat(cleaned.replace(/[^\d.-]/g, ""));
    return Number.isFinite(parsed) ? Math.round(parsed) : 0;
  }
  const base = Number.parseFloat(match[1]);
  if (!Number.isFinite(base)) return 0;
  const suffix = (match[2] || "").toUpperCase();
  if (suffix === "K") return Math.round(base * 1_000);
  if (suffix === "M") return Math.round(base * 1_000_000);
  if (suffix === "B") return Math.round(base * 1_000_000_000);
  return Math.round(base);
}

function parseOpenCodeCost(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[$,]/g, "");
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOpenCodeStatsOutput(stdout) {
  const text = stripAnsi(stdout);
  const lines = text.split(/\r?\n/);
  let inCostSection = false;
  const stats = {};

  for (const rawLine of lines) {
    const line = rawLine
      .replace(/[│├└┌┐┘┴┬┤─]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (/cost\s*&\s*tokens/i.test(line)) {
      inCostSection = true;
      continue;
    }
    if (inCostSection && /tool\s*usage/i.test(line)) {
      break;
    }
    if (!inCostSection) continue;

    const costMatch = line.match(/^total cost\s+\$?([\d,.]+)/i);
    if (costMatch) {
      stats.totalCost = parseOpenCodeCost(costMatch[1]);
      continue;
    }

    const tokenMatch = line.match(
      /^(input|output|cache read|cache write)\s+([\d,.]+[KMB]?)/i,
    );
    if (!tokenMatch) continue;

    const key = tokenMatch[1].toLowerCase();
    const value = parseCompactTokenCount(tokenMatch[2]);
    if (key === "input") stats.inputTokens = value;
    else if (key === "output") stats.outputTokens = value;
    else if (key === "cache read") stats.cacheReadTokens = value;
    else if (key === "cache write") stats.cacheWriteTokens = value;
  }

  const inputTokens = stats.inputTokens || 0;
  const outputTokens = stats.outputTokens || 0;
  const cacheReadTokens = stats.cacheReadTokens || 0;
  const cacheWriteTokens = stats.cacheWriteTokens || 0;
  const hasData =
    stats.totalCost !== undefined ||
    inputTokens > 0 ||
    outputTokens > 0 ||
    cacheReadTokens > 0 ||
    cacheWriteTokens > 0;
  if (!hasData) return undefined;

  const promptTokens = inputTokens + cacheWriteTokens;
  const cachedPromptTokens = cacheReadTokens;
  const completionTokens = outputTokens;
  const totalTokens = promptTokens + cachedPromptTokens + completionTokens;

  return {
    totalCost: stats.totalCost,
    tokenUsage: {
      promptTokens,
      cachedPromptTokens,
      completionTokens,
      totalTokens,
    },
  };
}

function getBridgeSessionUsagePayload() {
  const hasBridgeTokens = cumulativeOpenCodeUsage.totalTokens > 0;
  return {
    tokenUsage: {
      total: {
        promptTokens: cumulativeOpenCodeUsage.promptTokens,
        completionTokens: cumulativeOpenCodeUsage.completionTokens,
        totalTokens: cumulativeOpenCodeUsage.totalTokens,
      },
      ...(latestOpenCodeUsage ? { last: latestOpenCodeUsage } : {}),
    },
    ...(hasBridgeTokens ? {} : { empty: true }),
  };
}

function runOpenCodeStatsOnce() {
  return new Promise((resolve, reject) => {
    const args = ["stats", "--tools", "0"];
    log("spawning", OPENCODE_BIN, args.join(" "));

    const child = spawn(OPENCODE_BIN, args, {
      cwd: BRIDGE_CWD,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      handler(value);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(reject, new Error(`OpenCode stats timed out after ${OPENCODE_STATS_TIMEOUT_MS}ms.`));
    }, OPENCODE_STATS_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.once("error", (error) => {
      finish(reject, error);
    });
    child.once("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        finish(
          reject,
          new Error(
            normalizeText(stderr) ||
              normalizeText(stdout) ||
              `OpenCode stats exited with code ${code}.`,
          ),
        );
        return;
      }
      finish(resolve, stdout);
    });
  });
}

async function readOpenCodeStatsPayload(force = false) {
  const now = Date.now();
  if (!force && opencodeStatsCache.expiresAt > now) {
    if (opencodeStatsCache.payload) {
      return { payload: opencodeStatsCache.payload };
    }
    if (opencodeStatsCache.error) {
      return { error: opencodeStatsCache.error };
    }
  }

  try {
    const stdout = await runOpenCodeStatsOnce();
    const parsed = parseOpenCodeStatsOutput(stdout);
    if (!parsed) {
      throw new Error("OpenCode stats returned no cost or token data.");
    }
    const payload = {
      ok: true,
      provider: "opencode",
      source: "opencode-stats",
      sourceCommand: "opencode stats",
      updatedAt: new Date().toISOString(),
      accountUsageAvailable: false,
      message:
        "Historical OpenCode token and cost totals from opencode stats. Provider quota remaining is not exposed through the bridge.",
      ...(parsed.totalCost !== undefined ? { totalCost: parsed.totalCost } : {}),
      tokenUsage: {
        total: parsed.tokenUsage,
      },
    };
    opencodeStatsCache = {
      expiresAt: now + OPENCODE_STATS_CACHE_TTL_MS,
      payload,
      error: undefined,
    };
    return { payload };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "OpenCode stats failed.";
    const normalizedError =
      error && typeof error === "object" && error.code === "ENOENT"
        ? "OpenCode CLI is not installed or not on PATH."
        : message;
    opencodeStatsCache = {
      expiresAt: now + OPENCODE_STATS_CACHE_TTL_MS,
      payload: undefined,
      error: normalizedError,
    };
    return { error: normalizedError };
  }
}

async function getOpenCodeUsagePayload(force = false) {
  const bridgeSession = getBridgeSessionUsagePayload();
  const statsResult = await readOpenCodeStatsPayload(force);

  if (statsResult.payload) {
    const statsPayload = statsResult.payload;
    const bridgeLast = bridgeSession.tokenUsage?.last;
    const hasBridgeLast = Boolean(bridgeLast?.totalTokens);
    return {
      ...statsPayload,
      source:
        hasBridgeLast && bridgeSession.tokenUsage?.total?.totalTokens
          ? "opencode-stats+bridge-session"
          : statsPayload.source,
      tokenUsage: {
        ...statsPayload.tokenUsage,
        ...(hasBridgeLast ? { last: bridgeLast } : {}),
      },
    };
  }

  if (bridgeSession.tokenUsage?.total?.totalTokens) {
    return {
      ok: true,
      provider: "opencode",
      source: "bridge-session",
      sourceCommand: "opencode stats",
      updatedAt: latestOpenCodeUsageUpdatedAt || new Date().toISOString(),
      accountUsageAvailable: false,
      message: `Could not read OpenCode stats (${statsResult.error}). Showing PocketAI bridge session tokens only.`,
      tokenUsage: bridgeSession.tokenUsage,
    };
  }

  return {
    ok: false,
    provider: "opencode",
    source: "opencode-stats",
    sourceCommand: "opencode stats",
    updatedAt: new Date().toISOString(),
    accountUsageAvailable: false,
    message:
      statsResult.error ||
      "OpenCode usage is unavailable. Install the OpenCode CLI and run opencode stats to verify local usage data.",
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

function extractOpenCodeStreamingText(event) {
  if (!event || typeof event !== "object") return "";
  const part = event.part && typeof event.part === "object" ? event.part : {};
  if (event.type === "text" && typeof part.text === "string") {
    return part.text;
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

function normalizeOpenCodeEvents(events, fallbackText = "") {
  if (!events.length) {
    const text = normalizeText(fallbackText);
    if (!text) {
      throw new Error("OpenCode returned an empty response.");
    }
    return {
      text,
      model: "",
      usage: undefined,
    };
  }

  const errorText = events.map(extractOpenCodeError).find(Boolean);
  if (errorText) {
    throw new Error(errorText);
  }

  const text =
    normalizeText(events.map(extractOpenCodeEventText).filter(Boolean).join("\n")) ||
    normalizeText(fallbackText);
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

  const modelEvent = events.find(
    (event) => typeof event?.model === "string" || typeof event?.part?.model === "string",
  );
  const responseModel = modelEvent?.model || modelEvent?.part?.model || "";

  return {
    text,
    model: typeof responseModel === "string" ? responseModel.trim() : "",
    usage: usage.total_tokens ? usage : undefined,
  };
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

  return normalizeOpenCodeEvents(events, trimmed);
}

function getModelAttempts(model) {
  if (!model || model === "auto") return [""];
  return [model];
}

function buildOpenCodeArgs({ prompt, model }) {
  const args = ["run", "--format", "json"];
  if (OPENCODE_PURE) {
    args.push("--pure");
  }

  if (model) {
    args.push("--model", model);
  }

  args.push("--");
  args.push(prompt);

  return args;
}

function runOpenCodeCompletionOnce({ prompt, model, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request cancelled."));
      return;
    }

    const args = buildOpenCodeArgs({ prompt, model });

    log("spawning", OPENCODE_BIN, args.join(" "));

    const child = spawn(OPENCODE_BIN, args, {
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

function runOpenCodeStreamingCompletionOnce({ prompt, model, signal, onText }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request cancelled."));
      return;
    }

    const args = buildOpenCodeArgs({ prompt, model });

    log("spawning", OPENCODE_BIN, args.join(" "));

    const child = spawn(OPENCODE_BIN, args, {
      cwd: BRIDGE_CWD,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const events = [];
    const stdoutTail = [];
    const stderrChunks = [];
    let fullText = "";
    let textEventCount = 0;
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
      const eventText = extractOpenCodeStreamingText(event);
      if (eventText) {
        const chunk = textEventCount > 0 ? `\n${eventText}` : eventText;
        textEventCount += 1;
        fullText += chunk;
        onText?.(chunk);
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
          `OpenCode CLI exited with code ${code}.`;
        reject(new Error(message));
        return;
      }

      try {
        resolve(normalizeOpenCodeEvents(events, fullText));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function runOpenCodeCompletion({ prompt, model, signal }) {
  let lastError;
  for (const candidate of getModelAttempts(model)) {
    try {
      return await runOpenCodeCompletionOnce({ prompt, model: candidate, signal });
    } catch (error) {
      lastError = error;
      if (signal?.aborted) break;
      if (!candidate || !/model|unknown|invalid|disabled/i.test(String(error?.message || ""))) {
        break;
      }
    }
  }
  throw lastError ?? new Error("OpenCode CLI failed.");
}

async function runOpenCodeStreamingCompletion({ prompt, model, signal, onText }) {
  let lastError;
  for (const candidate of getModelAttempts(model)) {
    let sawText = false;
    try {
      return await runOpenCodeStreamingCompletionOnce({
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
  throw lastError ?? new Error("OpenCode CLI failed.");
}

async function handleModels(res) {
  sendJson(res, 200, toOpenAiModels());
}

async function handleStatus(res) {
  sendJson(res, 200, {
    ok: true,
    defaultModelId: DEFAULT_MODEL || "auto",
    pure: OPENCODE_PURE,
  });
}

function usageRequestForce(req) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  return url.searchParams.get("force") === "1" || url.searchParams.get("refresh") === "1";
}

async function handleUsage(req, res) {
  sendJson(res, 200, await getOpenCodeUsagePayload(usageRequestForce(req)));
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
    res.write(": pocketai-opencode-bridge-starting\n\n");

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
      const result = await runOpenCodeStreamingCompletion({
        prompt,
        model,
        signal: abortController.signal,
        onText: emitChunk,
      });
      if (abortController.signal.aborted) return;
      recordOpenCodeUsage(result.usage);
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
            message: error instanceof Error ? error.message : "OpenCode bridge failed.",
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
    result = await runOpenCodeCompletion({
      prompt,
      model,
      signal: abortController.signal,
    });
  } catch (error) {
    if (abortController.signal.aborted) return;
    throw error;
  }
  if (abortController.signal.aborted) return;
  recordOpenCodeUsage(result.usage);
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
        pure: OPENCODE_PURE,
        endpoints: ["/v1/models", "/v1/chat/completions", "/status", "/usage"],
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/status") {
      await handleStatus(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/usage") {
      await handleUsage(req, res);
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

const isMainModule =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  server.listen(PORT, HOST, () => {
    console.log(
      `[opencode-bridge] listening on http://${HOST}:${PORT} (cwd ${BRIDGE_CWD})`,
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

export {
  buildOpenCodeArgs,
  createBridgeInfoPayload,
  extractOpenCodeStreamingText,
  normalizeOpenCodeEvents,
};
