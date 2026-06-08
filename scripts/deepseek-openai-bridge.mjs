#!/usr/bin/env node

import http from "node:http";
import process from "node:process";
import { pathToFileURL } from "node:url";

const HOST = process.env.DEEPSEEK_BRIDGE_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.DEEPSEEK_BRIDGE_PORT || "39464", 10);
const BRIDGE_CWD = process.env.DEEPSEEK_BRIDGE_CWD || process.cwd();
const UPSTREAM_BASE_URL = trimTrailingSlash(
  process.env.DEEPSEEK_API_BASE_URL || "https://api.deepseek.com",
);
const ACCOUNT_BASE_URL = UPSTREAM_BASE_URL.replace(/\/(?:v1|beta)$/i, "");
const DEFAULT_MODEL = (process.env.DEEPSEEK_BRIDGE_MODEL || "deepseek-v4-pro").trim() || "deepseek-v4-pro";
const DEFAULT_REASONING = (process.env.DEEPSEEK_BRIDGE_REASONING || "").trim();
const DEEPSEEK_API_KEY = (
  process.env.DEEPSEEK_API_KEY ||
  process.env.DEEPSEEK_BRIDGE_API_KEY ||
  ""
).trim();
const VERBOSE = /^(1|true|yes)$/i.test(process.env.DEEPSEEK_BRIDGE_VERBOSE || "");
const BALANCE_REFRESH_MS = 60_000;
const BALANCE_TIMEOUT_MS = 3_500;
const IS_MAIN = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

const BRIDGE_INFO = {
  name: "pocketai-deepseek-bridge",
  title: "PocketAI DeepSeek Bridge",
  version: "0.1.0",
  capabilities: {
    streamingChatCompletions: true,
  },
};

const MODEL_DEFINITIONS = [
  {
    id: "deepseek-v4-pro",
    display_name: "DeepSeek V4 Pro",
    description: "DeepSeek V4 Pro through the OpenAI-compatible API.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [
      { reasoningEffort: "high" },
      { reasoningEffort: "max" },
    ],
  },
  {
    id: "deepseek-v4-flash",
    display_name: "DeepSeek V4 Flash",
    description: "DeepSeek V4 Flash through the OpenAI-compatible API.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [
      { reasoningEffort: "high" },
      { reasoningEffort: "max" },
    ],
  },
];

const MODEL_PRICING_PER_MILLION = {
  "deepseek-v4-flash": {
    promptCacheHit: 0.0028,
    promptCacheMiss: 0.14,
    completion: 0.28,
  },
  "deepseek-v4-pro": {
    promptCacheHit: 0.003625,
    promptCacheMiss: 0.435,
    completion: 0.87,
  },
};

let latestDeepSeekUsage = null;
let latestDeepSeekUsageUpdatedAt = "";
let latestDeepSeekModelId = DEFAULT_MODEL;
const cumulativeDeepSeekUsage = {
  promptTokens: 0,
  cachedPromptTokens: 0,
  promptCacheMissTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
};
let cumulativeDeepSeekCost = 0;
let latestBalance = null;
let latestBalanceCheckedAt = "";
let latestBalanceError = "";

function log(...args) {
  if (VERBOSE) {
    console.log("[deepseek-bridge]", ...args);
  }
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

function createBridgeInfoPayload() {
  return {
    ...BRIDGE_INFO,
    upstreamBaseUrl: UPSTREAM_BASE_URL,
    cwd: BRIDGE_CWD,
  };
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
  return extractBearerToken(req) || DEEPSEEK_API_KEY;
}

function toOpenAiModels() {
  return {
    object: "list",
    data: MODEL_DEFINITIONS.map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: "deepseek",
      display_name: model.display_name,
      displayName: model.display_name,
      description: model.description,
      defaultReasoningEffort: model.defaultReasoningEffort,
      supportedReasoningEfforts: model.supportedReasoningEfforts,
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

  const camelReasoning = typeof next.reasoningEffort === "string" ? next.reasoningEffort.trim() : "";
  if (!next.reasoning_effort && camelReasoning) {
    next.reasoning_effort = camelReasoning;
  }
  delete next.reasoningEffort;

  if (!next.reasoning_effort && DEFAULT_REASONING) {
    next.reasoning_effort = DEFAULT_REASONING;
  }
  if (next.reasoning_effort && !next.thinking) {
    next.thinking = { type: "enabled" };
  }
  if (next.stream === true) {
    const streamOptions =
      next.stream_options && typeof next.stream_options === "object" && !Array.isArray(next.stream_options)
        ? { ...next.stream_options }
        : {};
    if (streamOptions.include_usage === undefined) {
      streamOptions.include_usage = true;
    }
    next.stream_options = streamOptions;
  }

  return next;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const promptTokens = Number(
    usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? 0,
  );
  const promptCacheHitTokens = Number(
    usage.prompt_cache_hit_tokens ?? usage.promptCacheHitTokens ?? usage.cached_prompt_tokens ?? 0,
  );
  const promptCacheMissTokens = Number(
    usage.prompt_cache_miss_tokens ?? usage.promptCacheMissTokens ?? Math.max(0, promptTokens - promptCacheHitTokens),
  );
  const completionTokens = Number(
    usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? 0,
  );
  const reasoningTokens = Number(
    usage.completion_tokens_details?.reasoning_tokens ??
      usage.completionTokensDetails?.reasoningTokens ??
      usage.reasoning_tokens ??
      0,
  );
  const totalTokens = Number(
    usage.total_tokens ??
      usage.totalTokens ??
      promptTokens + completionTokens,
  );
  if (!promptTokens && !completionTokens && !totalTokens) return undefined;
  return {
    promptTokens,
    cachedPromptTokens: promptCacheHitTokens,
    promptCacheMissTokens,
    completionTokens,
    reasoningTokens,
    totalTokens,
  };
}

function estimateDeepSeekCost(modelId, usage) {
  const pricing = MODEL_PRICING_PER_MILLION[modelId] || MODEL_PRICING_PER_MILLION[DEFAULT_MODEL];
  if (!pricing || !usage) return 0;
  const cacheHitTokens = usage.cachedPromptTokens || 0;
  const knownMissTokens = usage.promptCacheMissTokens || 0;
  const hasCacheBreakdown = cacheHitTokens > 0 || knownMissTokens > 0;
  const inferredMissTokens = hasCacheBreakdown ? knownMissTokens : usage.promptTokens || 0;
  return (
    (cacheHitTokens / 1_000_000) * pricing.promptCacheHit +
    (inferredMissTokens / 1_000_000) * pricing.promptCacheMiss +
    ((usage.completionTokens || 0) / 1_000_000) * pricing.completion
  );
}

function recordDeepSeekUsage(modelId, usage) {
  const normalized = normalizeUsage(usage);
  if (!normalized) return;
  const resolvedModelId = modelId || DEFAULT_MODEL;
  const cost = estimateDeepSeekCost(resolvedModelId, normalized);
  latestDeepSeekModelId = resolvedModelId;
  latestDeepSeekUsage = normalized;
  latestDeepSeekUsageUpdatedAt = new Date().toISOString();
  cumulativeDeepSeekUsage.promptTokens += normalized.promptTokens;
  cumulativeDeepSeekUsage.cachedPromptTokens += normalized.cachedPromptTokens;
  cumulativeDeepSeekUsage.promptCacheMissTokens += normalized.promptCacheMissTokens;
  cumulativeDeepSeekUsage.completionTokens += normalized.completionTokens;
  cumulativeDeepSeekUsage.reasoningTokens += normalized.reasoningTokens;
  cumulativeDeepSeekUsage.totalTokens += normalized.totalTokens;
  cumulativeDeepSeekCost += cost;
}

function balanceSummary(balance) {
  const infos = Array.isArray(balance?.balance_infos) ? balance.balance_infos : [];
  if (!infos.length) return "";
  return infos
    .map((info) => {
      const currency = String(info?.currency || "").trim();
      const total = String(info?.total_balance || "").trim();
      if (!currency || !total) return "";
      return `${currency} ${total} balance`;
    })
    .filter(Boolean)
    .join(" / ");
}

function usdBalanceAmount(balance) {
  const infos = Array.isArray(balance?.balance_infos) ? balance.balance_infos : [];
  const usdInfo = infos.find((info) => String(info?.currency || "").trim().toUpperCase() === "USD");
  if (!usdInfo) return undefined;
  const value = Number.parseFloat(String(usdInfo.total_balance || ""));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function tokensForBalance(balanceAmount, pricePerMillion) {
  if (!Number.isFinite(balanceAmount) || !Number.isFinite(pricePerMillion) || pricePerMillion <= 0) {
    return undefined;
  }
  return Math.floor((balanceAmount / pricePerMillion) * 1_000_000);
}

function estimateRemainingDeepSeekTokens(modelId, balance) {
  const balanceAmount = usdBalanceAmount(balance);
  const pricing = MODEL_PRICING_PER_MILLION[modelId] || MODEL_PRICING_PER_MILLION[DEFAULT_MODEL];
  if (balanceAmount === undefined || !pricing) return undefined;
  const estimate = {
    modelId,
    balanceCurrency: "USD",
    balanceAmount: Number(balanceAmount.toFixed(6)),
    inputCacheHitTokens: tokensForBalance(balanceAmount, pricing.promptCacheHit),
    inputCacheMissTokens: tokensForBalance(balanceAmount, pricing.promptCacheMiss),
    outputTokens: tokensForBalance(balanceAmount, pricing.completion),
  };
  if (cumulativeDeepSeekCost > 0 && cumulativeDeepSeekUsage.totalTokens > 0) {
    estimate.mixedTokensAtSessionRate = Math.floor(
      balanceAmount / (cumulativeDeepSeekCost / cumulativeDeepSeekUsage.totalTokens),
    );
  }
  return estimate;
}

function formatLargeTokenCount(value) {
  if (!Number.isFinite(value)) return "";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.floor(value));
}

function remainingTokenEstimateMessage(estimate) {
  if (!estimate) return "";
  const output = formatLargeTokenCount(estimate.outputTokens);
  const input = formatLargeTokenCount(estimate.inputCacheMissTokens);
  const cached = formatLargeTokenCount(estimate.inputCacheHitTokens);
  if (!output || !input || !cached) return "";
  const mixed = estimate.mixedTokensAtSessionRate
    ? ` About ${formatLargeTokenCount(estimate.mixedTokensAtSessionRate)} tokens remain at this bridge session's observed input/output mix.`
    : "";
  return `Estimated remaining on ${estimate.modelId}: ${output} output tokens, ${input} uncached input tokens, or ${cached} cached input tokens.${mixed}`;
}

async function fetchDeepSeekBalance(apiKey) {
  if (!apiKey) return null;
  const lastCheckedAt = Date.parse(latestBalanceCheckedAt);
  if (
    (latestBalance || latestBalanceError) &&
    Number.isFinite(lastCheckedAt) &&
    Date.now() - lastCheckedAt < BALANCE_REFRESH_MS
  ) {
    return latestBalance;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS);
  try {
    const response = await fetch(`${ACCOUNT_BASE_URL}/user/balance`, {
      method: "GET",
      headers: upstreamHeaders(apiKey),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Balance returned ${response.status}: ${sanitizeUpstreamText(text)}`);
    }
    const json = text ? JSON.parse(text) : {};
    latestBalance = json;
    latestBalanceCheckedAt = new Date().toISOString();
    latestBalanceError = "";
    return json;
  } catch (error) {
    latestBalanceCheckedAt = new Date().toISOString();
    latestBalanceError = error instanceof Error && error.name === "AbortError"
      ? "Balance request timed out."
      : error instanceof Error ? error.message : "Could not check balance.";
    return latestBalance;
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeUpstreamText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .slice(0, 600)
    .trim();
}

async function getDeepSeekUsagePayload(apiKey) {
  const balance = await fetchDeepSeekBalance(apiKey);
  const balanceText = balanceSummary(balance);
  const remainingTokenEstimate = estimateRemainingDeepSeekTokens(latestDeepSeekModelId, balance);
  const balanceMessage = balanceText
    ? `Current DeepSeek balance: ${balanceText}.`
    : latestBalanceError
      ? `Balance unavailable: ${latestBalanceError}.`
      : "Balance has not been checked yet.";
  const remainingMessage = remainingTokenEstimateMessage(remainingTokenEstimate);
  return {
    ok: true,
    provider: "deepseek",
    source: "deepseek-bridge",
    updatedAt: latestDeepSeekUsageUpdatedAt || new Date().toISOString(),
    accountUsageAvailable: false,
    message:
      `${balanceMessage}${remainingMessage ? ` ${remainingMessage}` : ""} Token totals and cost are counted for this bridge process; DeepSeek detailed usage by API key is exported from the Platform Usage page.`,
    planType: balanceText || undefined,
    totalCost: Number(cumulativeDeepSeekCost.toFixed(8)),
    remainingTokenEstimate,
    limits: [],
    balance: balance ? {
      isAvailable: Boolean(balance.is_available),
      checkedAt: latestBalanceCheckedAt || undefined,
      infos: Array.isArray(balance.balance_infos) ? balance.balance_infos : [],
    } : undefined,
    tokenUsage: {
      total: {
        promptTokens: cumulativeDeepSeekUsage.promptTokens,
        cachedPromptTokens: cumulativeDeepSeekUsage.cachedPromptTokens,
        promptCacheMissTokens: cumulativeDeepSeekUsage.promptCacheMissTokens,
        completionTokens: cumulativeDeepSeekUsage.completionTokens,
        reasoningTokens: cumulativeDeepSeekUsage.reasoningTokens,
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

function writeProxyHeaders(res, upstreamResponse, extra = {}) {
  const contentType =
    upstreamResponse.headers.get("content-type") ||
    "application/json; charset=utf-8";
  res.writeHead(
    upstreamResponse.status,
    createHeaders({
      "Content-Type": contentType,
      "X-PocketAI-Bridge-Provider": "deepseek",
      ...extra,
    }),
  );
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
}

function inspectSseUsageText(text, state, modelId) {
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
      if (parsed.usage) recordDeepSeekUsage(modelId || parsed.model || DEFAULT_MODEL, parsed.usage);
    } catch {}
  }
}

async function proxyUpstreamResponse(res, upstreamResponse, modelId) {
  const contentType = upstreamResponse.headers.get("content-type") || "";
  const isEventStream = contentType.toLowerCase().includes("text/event-stream");

  if (!isEventStream) {
    const text = await upstreamResponse.text();
    if (contentType.toLowerCase().includes("application/json")) {
      try {
        const payload = JSON.parse(text);
        if (payload.usage) recordDeepSeekUsage(modelId || payload.model || DEFAULT_MODEL, payload.usage);
      } catch {}
    }
    res.writeHead(
      upstreamResponse.status,
      createHeaders({
        "Content-Type": contentType || "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(text),
        "X-PocketAI-Bridge-Provider": "deepseek",
      }),
    );
    res.end(text);
    return;
  }

  if (res.socket && typeof res.socket.setNoDelay === "function") {
    res.socket.setNoDelay(true);
  }
  writeProxyHeaders(res, upstreamResponse, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  if (!upstreamResponse.body) {
    res.end();
    return;
  }

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  const usageState = { buffer: "" };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    inspectSseUsageText(decoder.decode(value, { stream: true }), usageState, modelId);
    res.write(Buffer.from(value));
  }

  const trailing = decoder.decode();
  if (trailing) {
    inspectSseUsageText(trailing, usageState, modelId);
  }
  res.end();
}

async function handleChatCompletion(req, res) {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    sendOpenAiError(
      res,
      401,
      "DeepSeek API key is required. Save a DeepSeek key or set DEEPSEEK_API_KEY.",
      "authentication_error",
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

  await proxyUpstreamResponse(res, upstreamResponse, body.model);
}

async function handleRequest(req, res) {
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
      sendJson(res, 200, createBridgeInfoPayload());
      return;
    }

    if (method === "GET" && pathname === "/status") {
      sendJson(res, 200, {
        ok: Boolean(DEEPSEEK_API_KEY),
        provider: "deepseek",
        defaultModelId: DEFAULT_MODEL,
        default_model_id: DEFAULT_MODEL,
        cwd: BRIDGE_CWD,
      });
      return;
    }

    if (method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
      if (!getApiKey(req)) {
        sendOpenAiError(
          res,
          401,
          "DeepSeek API key is required to use this endpoint.",
          "authentication_error",
        );
        return;
      }
      sendJson(res, 200, toOpenAiModels());
      return;
    }

    if (method === "GET" && pathname === "/usage") {
      sendJson(res, 200, await getDeepSeekUsagePayload(getApiKey(req)));
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
    console.error("[deepseek-bridge]", error);
    sendOpenAiError(
      res,
      502,
      error instanceof Error ? error.message : "DeepSeek bridge failed.",
    );
  }
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res);
});

if (IS_MAIN) {
  server.listen(PORT, HOST, () => {
    console.log(
      `[deepseek-bridge] listening on http://${HOST}:${PORT} cwd=${BRIDGE_CWD} upstream=${UPSTREAM_BASE_URL} model=${DEFAULT_MODEL}`,
    );
  });

  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });

  process.on("SIGINT", () => {
    server.close(() => process.exit(0));
  });
}

export {
  createBridgeInfoPayload,
  normalizeChatBody,
  proxyUpstreamResponse,
};
