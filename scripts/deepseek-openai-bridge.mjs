#!/usr/bin/env node

import http from "node:http";
import { randomUUID } from "node:crypto";
import process from "node:process";

const HOST = process.env.DEEPSEEK_BRIDGE_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.DEEPSEEK_BRIDGE_PORT || "39464", 10);
const UPSTREAM_BASE_URL = trimTrailingSlash(
  process.env.DEEPSEEK_API_BASE_URL || "https://api.deepseek.com",
);
const DEFAULT_MODEL = (process.env.DEEPSEEK_BRIDGE_MODEL || "deepseek-v4-pro").trim();
const VERBOSE = /^(1|true|yes)$/i.test(process.env.DEEPSEEK_BRIDGE_VERBOSE || "");

const BRIDGE_INFO = {
  name: "pocketai-deepseek-bridge",
  title: "PocketAI DeepSeek Bridge",
  version: "0.1.0",
};

const MODEL_DEFINITIONS = [
  {
    id: "deepseek-v4-pro",
    display_name: "DeepSeek V4 Pro",
    description: "DeepSeek V4 Pro through the OpenAI-compatible API.",
  },
  {
    id: "deepseek-v4-flash",
    display_name: "DeepSeek V4 Flash",
    description: "DeepSeek V4 Flash through the OpenAI-compatible API.",
  },
];

let latestDeepSeekUsage = null;
let latestDeepSeekUsageUpdatedAt = "";
const cumulativeDeepSeekUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

function log(...args) {
  if (VERBOSE) {
    console.log("[deepseek-bridge]", ...args);
  }
}

function logError(...args) {
  console.error("[deepseek-bridge]", ...args);
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
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

function extractBearerToken(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() || "";
  if (!token || token === "local-pocketai" || token === "test-key") {
    return "";
  }
  return token;
}

function getApiKey(req) {
  return (
    extractBearerToken(req) ||
    process.env.DEEPSEEK_API_KEY?.trim() ||
    process.env.DEEPSEEK_BRIDGE_API_KEY?.trim() ||
    ""
  );
}

function toOpenAiModels() {
  return {
    object: "list",
    data: MODEL_DEFINITIONS.map((model) => ({
      id: model.id,
      object: "model",
      owned_by: "deepseek",
      display_name: model.display_name,
      description: model.description,
    })),
  };
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    if (message.role === "developer") {
      return { ...message, role: "system" };
    }
    return message;
  });
}

function normalizeChatBody(body) {
  const next = {
    ...body,
    model: String(body?.model || "").trim() || DEFAULT_MODEL,
    messages: normalizeMessages(body?.messages),
  };

  if (next.reasoning_effort && !next.thinking) {
    next.thinking = { type: "enabled" };
  }

  return next;
}

function normalizeUsage(usage) {
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

function recordDeepSeekUsage(usage) {
  const normalized = normalizeUsage(usage);
  if (!normalized) return;
  latestDeepSeekUsage = normalized;
  latestDeepSeekUsageUpdatedAt = new Date().toISOString();
  cumulativeDeepSeekUsage.promptTokens += normalized.promptTokens;
  cumulativeDeepSeekUsage.completionTokens += normalized.completionTokens;
  cumulativeDeepSeekUsage.totalTokens += normalized.totalTokens;
}

function getDeepSeekUsagePayload() {
  return {
    ok: true,
    provider: "deepseek",
    source: "bridge-session",
    updatedAt: latestDeepSeekUsageUpdatedAt || undefined,
    accountUsageAvailable: false,
    message:
      "DeepSeek API account limit percentages are not exposed by this bridge. Token totals are counted for this bridge process.",
    tokenUsage: {
      total: {
        promptTokens: cumulativeDeepSeekUsage.promptTokens,
        completionTokens: cumulativeDeepSeekUsage.completionTokens,
        totalTokens: cumulativeDeepSeekUsage.totalTokens,
      },
      ...(latestDeepSeekUsage ? { last: latestDeepSeekUsage } : {}),
    },
  };
}

function upstreamHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

function writeProxyHeaders(res, upstreamResponse) {
  const contentType =
    upstreamResponse.headers.get("content-type") ||
    "application/json; charset=utf-8";
  res.writeHead(
    upstreamResponse.status,
    createHeaders({
      "Content-Type": contentType,
    }),
  );
}

function inspectSseUsageText(text, state) {
  state.buffer += text;
  const lines = state.buffer.split("\n");
  state.buffer = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ")) continue;
    const data = trimmed.slice(6);
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed.usage) recordDeepSeekUsage(parsed.usage);
    } catch {}
  }
}

async function proxyUpstreamResponse(res, upstreamResponse) {
  const contentType = upstreamResponse.headers.get("content-type") || "";
  writeProxyHeaders(res, upstreamResponse);

  if (!upstreamResponse.body) {
    res.end();
    return;
  }

  if (!contentType.includes("text/event-stream")) {
    const text = await upstreamResponse.text();
    if (contentType.includes("application/json")) {
      try {
        const payload = JSON.parse(text);
        if (payload.usage) recordDeepSeekUsage(payload.usage);
      } catch {}
    }
    res.end(text);
    return;
  }

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  const usageState = { buffer: "" };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    inspectSseUsageText(decoder.decode(value, { stream: true }), usageState);
    res.write(Buffer.from(value));
  }

  const trailing = decoder.decode();
  if (trailing) {
    inspectSseUsageText(trailing, usageState);
  }
  res.end();
}

async function handleChatCompletion(req, res) {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    sendOpenAiError(
      res,
      401,
      "DeepSeek API key is required. Save a key for the DeepSeek Bridge endpoint or set DEEPSEEK_API_KEY.",
      "invalid_request_error",
    );
    return;
  }

  const body = normalizeChatBody(await readRequestBody(req));
  const upstreamUrl = `${UPSTREAM_BASE_URL}/chat/completions`;

  log("proxy", body.model, upstreamUrl);
  const upstreamResponse = await fetch(upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders(apiKey),
    body: JSON.stringify(body),
  });

  await proxyUpstreamResponse(res, upstreamResponse);
}

const server = http.createServer(async (req, res) => {
  const method = req.method || "GET";
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (method === "OPTIONS") {
    res.writeHead(204, createHeaders());
    res.end();
    return;
  }

  try {
    if (method === "GET" && pathname === "/") {
      sendJson(res, 200, {
        ...BRIDGE_INFO,
        upstreamBaseUrl: UPSTREAM_BASE_URL,
      });
      return;
    }

    if (method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
      if (!getApiKey(req)) {
        sendOpenAiError(
          res,
          401,
          "DeepSeek API key is required to use this endpoint.",
          "invalid_request_error",
        );
        return;
      }
      sendJson(res, 200, toOpenAiModels());
      return;
    }

    if (method === "GET" && pathname === "/usage") {
      sendJson(res, 200, getDeepSeekUsagePayload());
      return;
    }

    if (
      method === "POST" &&
      (pathname === "/v1/chat/completions" || pathname === "/chat/completions")
    ) {
      await handleChatCompletion(req, res);
      return;
    }

    sendOpenAiError(
      res,
      404,
      `Unsupported server request in deepseek-openai-bridge: ${method} ${url.pathname}`,
      "not_found",
    );
  } catch (error) {
    logError(error);
    sendOpenAiError(
      res,
      502,
      error instanceof Error ? error.message : "DeepSeek bridge failed.",
    );
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `[deepseek-bridge] listening on http://${HOST}:${PORT} (upstream ${UPSTREAM_BASE_URL}, default ${DEFAULT_MODEL})`,
  );
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
