import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";

import * as vscode from "vscode";

import type { EndpointConfig, ChatEntry, ChatSession } from "./types";
import type { EndpointManager } from "./endpoint-manager";
import { normalizeBaseUrl } from "./helpers";
import { CODEX_APP_SERVER_URL } from "./provider-constants";
import { DEFAULT_MAX_TOKENS, DEFAULT_SYSTEM_PROMPT } from "./constants";
import type { StreamingDeps } from "./streaming";
import type { CodexConnectionState, CodexModelInfo } from "./codex-bridge-manager";

const POLL_MS = 5000;
const CODEX_APP_SERVER_NAME = "Codex App Server";
const APPROVAL_POLICY = "never";
const SANDBOX_MODE = "read-only";

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  notFound: boolean;
};

type JsonRpcMessage = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; details?: string };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type CodexModelList = {
  data?: Array<{
    id?: string;
    model?: string;
    displayName?: string;
    description?: string;
    hidden?: boolean;
    isDefault?: boolean;
    defaultReasoningEffort?: string;
    supportedReasoningEfforts?: Array<{
      reasoningEffort?: string;
      description?: string;
    }>;
  }>;
};

type TokenUsageBucket = {
  inputTokens?: number;
  input_tokens?: number;
  outputTokens?: number;
  output_tokens?: number;
  totalTokens?: number;
  total_tokens?: number;
};

type StreamTurnResult = {
  text: string;
  tokenUsage?: { promptTokens: number; completionTokens: number };
  responseModel?: string;
};

function defaultState(): CodexConnectionState {
  return {
    available: false,
    loggedIn: false,
    loginLabel: "Sign in required",
    bridgeRunning: false,
    endpointConfigured: false,
    endpointActive: false,
    endpointHealthy: false,
    models: [],
    selectedModel: "",
    selectedReasoningEffort: "",
    busy: false,
    status: "Connect Codex App Server to use native Codex turns in PocketAI.",
    error: "",
  };
}

function firstDefined<T>(...values: Array<T | undefined | null>): T | undefined {
  return values.find((value) => value !== undefined && value !== null) as
    | T
    | undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function mapUsage(value: unknown): { promptTokens: number; completionTokens: number } | undefined {
  const usage = value as
    | {
        last?: TokenUsageBucket;
        lastTokenUsage?: TokenUsageBucket;
        last_token_usage?: TokenUsageBucket;
      }
    | undefined;
  const bucket = firstDefined(
    usage?.last,
    usage?.lastTokenUsage,
    usage?.last_token_usage,
  );
  if (!bucket) return undefined;
  return {
    promptTokens:
      toNumber(firstDefined(bucket.inputTokens, bucket.input_tokens)) ?? 0,
    completionTokens:
      toNumber(firstDefined(bucket.outputTokens, bucket.output_tokens)) ?? 0,
  };
}

function toCodexModels(modelList: CodexModelList): CodexModelInfo[] {
  return (modelList.data ?? [])
    .map((model) => ({
      id: model.id?.trim() ?? "",
      model: model.model?.trim() ?? model.id?.trim() ?? "",
      displayName: model.displayName?.trim() ?? model.id?.trim() ?? "",
      description: model.description?.trim() ?? "",
      hidden: Boolean(model.hidden),
      isDefault: Boolean(model.isDefault),
      defaultReasoningEffort: model.defaultReasoningEffort?.trim() ?? "",
      supportedReasoningEfforts: (model.supportedReasoningEfforts ?? []).map(
        (option) => ({
          reasoningEffort: option.reasoningEffort?.trim() ?? "",
          description: option.description?.trim() ?? "",
        }),
      ).filter((option) => option.reasoningEffort),
    }))
    .filter((model) => model.id);
}

function entryText(entry: ChatEntry): string {
  const parts = [entry.content.trim()].filter(Boolean);
  if (entry.files?.length) {
    for (const file of entry.files) {
      parts.push(
        [
          `[Attached file: ${file.name || "attachment"}${file.mimeType ? ` | ${file.mimeType}` : ""}]`,
          "--- BEGIN FILE ---",
          file.content || "[Attachment content unavailable.]",
          "--- END FILE ---",
        ].join("\n"),
      );
    }
  }
  return parts.join("\n\n");
}

function formatConversationForBootstrap(session: ChatSession): string {
  return session.transcript
    .filter((entry) => entry.role !== "system")
    .map((entry) => {
      const role = entry.role === "tool" ? "tool result" : entry.role;
      return `${role.toUpperCase()}:\n${entryText(entry) || "[Empty message]"}`;
    })
    .join("\n\n");
}

function buildBaseInstructions(
  session: ChatSession,
  deps: StreamingDeps,
  workspaceContext: string,
): string {
  return [
    deps.projectInstructionsCache
      ? `[Project Instructions]\n${deps.projectInstructionsCache}`
      : "",
    deps.getActiveSystemPrompt() || DEFAULT_SYSTEM_PROMPT,
    deps.memoryContext || "",
    session.mode === "plan"
      ? "The user selected Plan mode. Make a plan and do not modify files."
      : "",
    workspaceContext,
    session.activeSkillInjection || "",
    session.skillPreflightContext || "",
    [
      "[PocketAI Codex App Server Preview]",
      "You are running inside PocketAI through Codex app-server.",
      "This preview currently streams native Codex turns, but PocketAI approval cards for native file changes and commands are still being wired.",
      "Prefer chat answers and safe read-only inspection. Do not attempt file changes or command execution that would require approval.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildTurnInput(options: {
  session: ChatSession;
  bootstrapThread: boolean;
}): Array<Record<string, unknown>> {
  const latestUser = [...options.session.transcript]
    .reverse()
    .find((entry) => entry.role === "user");
  const latestText = latestUser ? entryText(latestUser) : "";
  const text = options.bootstrapThread
    ? [
        "Here is the PocketAI conversation so far.",
        "",
        formatConversationForBootstrap(options.session),
        "",
        "Continue by responding to the latest user message.",
      ].join("\n")
    : latestText || "Continue.";

  const input: Array<Record<string, unknown>> = [
    { type: "text", text, text_elements: [] },
  ];

  for (const image of latestUser?.images ?? []) {
    input.push({
      type: "image",
      url: `data:${image.mimeType};base64,${image.data}`,
    });
  }

  return input;
}

class CodexAppServerRpcClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationHandlers = new Set<(message: JsonRpcMessage) => void>();
  private nextId = 1;
  private closed = false;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exitPromise: Promise<void>;

  constructor(
    codexBin: string,
    cwd: string,
    private readonly outputChannel: vscode.OutputChannel,
  ) {
    this.child = spawn(codexBin, ["app-server"], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.exitPromise = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.closed = true;
        const reason = code !== null ? `exit ${code}` : `signal ${signal}`;
        const error = new Error(`Codex app-server exited unexpectedly (${reason}).`);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        resolve();
      });
    });

    this.child.once("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });

    const stdout = readline.createInterface({ input: this.child.stdout });
    stdout.on("line", (line) => this.handleLine(line));

    const stderr = readline.createInterface({ input: this.child.stderr });
    stderr.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed) {
        this.outputChannel.appendLine(`[Codex App Server] ${trimmed}`);
      }
    });
  }

  get isClosed(): boolean {
    return this.closed || this.child.exitCode !== null;
  }

  private handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      this.outputChannel.appendLine(`[Codex App Server] non-JSON stdout: ${trimmed}`);
      return;
    }

    if (
      Object.prototype.hasOwnProperty.call(message, "id") &&
      (Object.prototype.hasOwnProperty.call(message, "result") ||
        Object.prototype.hasOwnProperty.call(message, "error"))
    ) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.reject(
          new Error(message.error.message || "Codex app-server request failed."),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (
      Object.prototype.hasOwnProperty.call(message, "id") &&
      typeof message.method === "string"
    ) {
      this.handleServerRequest(message);
      return;
    }

    if (typeof message.method === "string") {
      for (const handler of this.notificationHandlers) handler(message);
    }
  }

  private handleServerRequest(message: JsonRpcMessage) {
    if (message.method === "item/commandExecution/requestApproval") {
      this.respond(message.id, { decision: "cancel" });
      return;
    }

    if (message.method === "item/fileChange/requestApproval") {
      this.respond(message.id, { decision: "cancel" });
      return;
    }

    if (message.method === "item/permissions/requestApproval") {
      this.respond(message.id, {
        permissions: {
          network: null,
          fileSystem: null,
          macos: null,
        },
        scope: "turn",
      });
      return;
    }

    this.respondError(
      message.id,
      -32601,
      `Unsupported Codex app-server request: ${message.method || "unknown"}`,
    );
  }

  private send(payload: Record<string, unknown>) {
    if (this.isClosed || !this.child.stdin.writable) {
      throw new Error("Codex app-server is not available.");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: Record<string, unknown>) {
    this.send(params === undefined ? { method } : { method, params });
  }

  respond(id: JsonRpcMessage["id"], result: Record<string, unknown>) {
    if (id === undefined) return;
    this.send({ id, result });
  }

  respondError(id: JsonRpcMessage["id"], code: number, message: string) {
    if (id === undefined) return;
    this.send({ id, error: { code, message } });
  }

  onNotification(handler: (message: JsonRpcMessage) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: {
        name: "pocketai_codex_app_server",
        title: "PocketAI Codex App Server",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized");
  }

  async close() {
    if (this.isClosed) return;
    this.child.kill("SIGTERM");
    await Promise.race([
      this.exitPromise,
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    if (!this.isClosed) {
      this.child.kill("SIGKILL");
      await this.exitPromise;
    }
  }
}

export class CodexAppServerManager {
  private client?: CodexAppServerRpcClient;
  private loginTerminal?: vscode.Terminal;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private refreshInFlight?: Promise<CodexConnectionState>;
  private state: CodexConnectionState = defaultState();
  private codexBin = "codex";
  private busyMessage = "";
  private lastError = "";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  getState(endpointMgr: EndpointManager): CodexConnectionState {
    return this.withEndpointState(this.state, endpointMgr);
  }

  startPolling(
    endpointMgr: EndpointManager,
    onChange: (state: CodexConnectionState) => void,
    onReady?: (state: CodexConnectionState) => Promise<void>,
  ) {
    if (this.refreshTimer) return;

    const tick = async () => {
      const next = await this.refresh(endpointMgr);
      if (onReady) await onReady(next);
      onChange(next);
    };

    void tick();
    this.refreshTimer = setInterval(() => void tick(), POLL_MS);
  }

  async refresh(endpointMgr: EndpointManager): Promise<CodexConnectionState> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      const available = await this.resolveCodexBinary();
      const login = available
        ? await this.getLoginStatus()
        : { loggedIn: false, label: "Codex CLI not found" };
      const serverRunning = Boolean(this.client && !this.client.isClosed);
      const models =
        serverRunning && login.loggedIn
          ? await this.fetchModels().catch(() => this.state.models)
          : this.state.models;

      const base: CodexConnectionState = {
        ...this.state,
        available,
        loggedIn: login.loggedIn,
        loginLabel: login.label,
        bridgeRunning: serverRunning,
        models,
        busy: this.state.busy,
        error: this.lastError,
        status: this.deriveStatus({
          available,
          loggedIn: login.loggedIn,
          serverRunning,
          modelsCount: models.length,
          endpointMgr,
          busy: this.state.busy,
        }),
      };

      this.state = this.withEndpointState(base, endpointMgr);
      this.syncEndpointRuntimeState(endpointMgr, models);
      return this.state;
    })().finally(() => {
      this.refreshInFlight = undefined;
    });

    return this.refreshInFlight;
  }

  async connect(options: {
    config: vscode.WorkspaceConfiguration;
    endpointMgr: EndpointManager;
    defaultSystemPrompt: string;
    workspaceRoot?: string;
  }): Promise<CodexConnectionState> {
    const workspaceRoot = options.workspaceRoot || os.homedir();
    this.state.busy = true;
    this.busyMessage = "Connecting to Codex App Server...";
    this.lastError = "";

    try {
      const available = await this.resolveCodexBinary();
      if (!available) {
        throw new Error(
          "Codex CLI was not found. Install Codex or make the `codex` command available in PATH.",
        );
      }

      await this.ensureEndpointConfigured(
        options.config,
        options.defaultSystemPrompt,
      );
      options.endpointMgr.initEndpoints();
      options.endpointMgr.switchEndpoint(CODEX_APP_SERVER_URL);

      const login = await this.getLoginStatus();
      if (!login.loggedIn) {
        this.openLoginTerminal(workspaceRoot);
        this.busyMessage =
          "Finish signing in to Codex in the terminal we opened.";
      } else {
        await this.ensureClient(workspaceRoot);
        const models = await this.fetchModels();
        this.syncEndpointRuntimeState(options.endpointMgr, models);
        this.busyMessage = "Codex App Server connected.";
      }
    } catch (error) {
      this.lastError =
        error instanceof Error ? error.message : "Failed to connect to Codex App Server.";
      throw error;
    } finally {
      this.state.busy = false;
    }

    return this.refresh(options.endpointMgr);
  }

  async autoConnectIfConfigured(options: {
    config: vscode.WorkspaceConfiguration;
    endpointMgr: EndpointManager;
    defaultSystemPrompt: string;
    workspaceRoot?: string;
  }): Promise<CodexConnectionState> {
    const current = await this.refresh(options.endpointMgr);
    if (!current.endpointConfigured || !current.available || current.bridgeRunning) {
      return current;
    }

    const login = await this.getLoginStatus();
    if (!login.loggedIn) return current;

    this.state.busy = true;
    this.busyMessage = "Starting Codex App Server...";
    this.lastError = "";
    try {
      await this.ensureEndpointConfigured(
        options.config,
        options.defaultSystemPrompt,
      );
      options.endpointMgr.initEndpoints();
      await this.ensureClient(options.workspaceRoot || os.homedir());
      const models = await this.fetchModels();
      this.syncEndpointRuntimeState(options.endpointMgr, models);
      this.busyMessage = "Codex App Server is ready.";
    } catch (error) {
      this.lastError =
        error instanceof Error ? error.message : "Failed to start Codex App Server.";
    } finally {
      this.state.busy = false;
    }

    return this.refresh(options.endpointMgr);
  }

  async signIn(
    workspaceRoot: string | undefined,
    endpointMgr: EndpointManager,
  ): Promise<CodexConnectionState> {
    const available = await this.resolveCodexBinary();
    if (!available) {
      const message =
        "Codex CLI was not found. Install Codex or make the `codex` command available in PATH.";
      this.lastError = message;
      throw new Error(message);
    }

    this.lastError = "";
    this.openLoginTerminal(workspaceRoot || os.homedir());
    this.busyMessage = "Finish signing in to Codex in the terminal we opened.";
    return this.refresh(endpointMgr);
  }

  async streamAssistantTurn(options: {
    session: ChatSession;
    streamingDeps: StreamingDeps;
    workspaceContext: string;
    workspaceRoot?: string;
  }): Promise<StreamTurnResult> {
    const workspaceRoot = options.workspaceRoot || os.homedir();
    await this.ensureClient(workspaceRoot);
    const client = this.client;
    if (!client) {
      throw new Error("Codex app-server is not available.");
    }

    const model = options.session.selectedModel.trim() ||
      this.state.models.find((item) => item.isDefault)?.id ||
      this.state.models[0]?.id ||
      "";
    const reasoningEffort =
      options.session.selectedReasoningEffort.trim() ||
      options.streamingDeps.getActiveReasoningEffort().trim();
    const baseInstructions = buildBaseInstructions(
      options.session,
      options.streamingDeps,
      options.workspaceContext,
    );
    const bootstrapThread =
      !options.session.codexAppServerThreadId ||
      options.session.codexAppServerCwd !== workspaceRoot;

    options.streamingDeps.broadcastToWebviews({
      type: "streamStart",
      label: "Codex is thinking...",
      detail: "Native app-server turn",
    });

    if (bootstrapThread) {
      const thread = await client.request<{
        thread?: { id?: string };
        model?: string;
      }>("thread/start", {
        ephemeral: false,
        cwd: workspaceRoot,
        sandbox: SANDBOX_MODE,
        approvalPolicy: APPROVAL_POLICY,
        ...(model ? { model } : {}),
        modelProvider: "openai",
        baseInstructions,
        developerInstructions: [
          "You are running in PocketAI through Codex app-server.",
          "PocketAI native Codex approvals are not fully wired yet.",
          "Avoid file changes and command execution that require approval.",
        ].join("\n"),
        serviceName: "pocketai-codex-app-server",
      });
      options.session.codexAppServerThreadId = thread.thread?.id;
      options.session.codexAppServerCwd = workspaceRoot;
    }

    if (!options.session.codexAppServerThreadId) {
      throw new Error("Codex app-server did not return a thread id.");
    }

    const input = buildTurnInput({
      session: options.session,
      bootstrapThread,
    });

    let fullText = "";
    let turnId = "";
    let tokenUsage: StreamTurnResult["tokenUsage"];
    let responseModel = model;
    let detach: (() => void) | undefined;
    let abortHandler: (() => void) | undefined;

    const completionPromise = new Promise<StreamTurnResult>((resolve, reject) => {
      const removeAbortHandler = () => {
        if (abortHandler) {
          options.session.currentRequest?.signal.removeEventListener(
            "abort",
            abortHandler,
          );
        }
      };
      const finishWithError = (error: Error) => {
        detach?.();
        removeAbortHandler();
        reject(error);
      };

      abortHandler = () => {
        const abortError = new Error("Request cancelled.");
        abortError.name = "AbortError";
        if (turnId) {
          void client.request("turn/interrupt", { turnId }).catch(() => {});
        }
        finishWithError(abortError);
      };

      options.session.currentRequest?.signal.addEventListener(
        "abort",
        abortHandler,
        { once: true },
      );

      detach = client.onNotification((message) => {
        const params = message.params || {};
        if (message.method === "error") {
          finishWithError(
            new Error(String(params.message || "Codex app-server error.")),
          );
          return;
        }

        if (
          message.method === "item/agentMessage/delta" &&
          params.turnId === turnId &&
          typeof params.delta === "string"
        ) {
          fullText += params.delta;
          options.streamingDeps.broadcastToWebviews({
            type: "streamChunk",
            text: params.delta,
          });
          return;
        }

        if (
          message.method === "item/completed" &&
          params.turnId === turnId
        ) {
          const item = params.item as { type?: string; text?: string } | undefined;
          if (
            item?.type === "agentMessage" &&
            typeof item.text === "string" &&
            item.text.length >= fullText.length
          ) {
            const remainder = item.text.startsWith(fullText)
              ? item.text.slice(fullText.length)
              : "";
            fullText = item.text;
            if (remainder) {
              options.streamingDeps.broadcastToWebviews({
                type: "streamChunk",
                text: remainder,
              });
            }
          }
          return;
        }

        if (
          message.method === "thread/tokenUsage/updated" &&
          params.turnId === turnId
        ) {
          tokenUsage = mapUsage(params.tokenUsage);
          return;
        }

        if (
          message.method === "turn/completed" &&
          (params.turn as { id?: string } | undefined)?.id === turnId
        ) {
          detach?.();
          removeAbortHandler();
          const turn = params.turn as
            | {
                error?: { message?: string; details?: string };
                model?: string;
              }
            | undefined;
          if (turn?.model) responseModel = turn.model;
          if (turn?.error) {
            reject(
              new Error(
                turn.error.message ||
                  turn.error.details ||
                  "Codex failed to complete the turn.",
              ),
            );
            return;
          }
          resolve({ text: fullText, tokenUsage, responseModel });
        }
      });
    });

    let turn: { turn?: { id?: string } };
    try {
      turn = await client.request<{ turn?: { id?: string } }>("turn/start", {
        threadId: options.session.codexAppServerThreadId,
        input,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { effort: reasoningEffort } : {}),
      });
    } catch (error) {
      detach?.();
      throw error;
    }

    turnId = turn.turn?.id || "";
    if (!turnId) {
      detach?.();
      throw new Error("Codex app-server did not return a turn id.");
    }

    const result = await completionPromise;
    if (result.tokenUsage) {
      options.session.lastTokenUsage = result.tokenUsage;
      options.session.cumulativeTokens.prompt += result.tokenUsage.promptTokens;
      options.session.cumulativeTokens.completion +=
        result.tokenUsage.completionTokens;
    }
    options.streamingDeps.broadcastToWebviews({
      type: "streamEnd",
      fullText: result.text,
      ...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
      ...(result.responseModel ? { responseModel: result.responseModel } : {}),
    });
    return result;
  }

  dispose() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    void this.client?.close();
    this.client = undefined;
  }

  private async resolveCodexBinary(): Promise<boolean> {
    const envCandidate = process.env.CODEX_BIN?.trim();
    const candidates = Array.from(
      new Set(
        [
          envCandidate,
          this.codexBin,
          "codex",
          process.platform === "darwin"
            ? "/Applications/Codex.app/Contents/Resources/codex"
            : "",
          process.platform === "darwin"
            ? path.join(
                os.homedir(),
                "Applications",
                "Codex.app",
                "Contents",
                "Resources",
                "codex",
              )
            : "",
        ].filter((value): value is string => Boolean(value)),
      ),
    );

    for (const candidate of candidates) {
      const result = await this.runCommand(candidate, ["--version"], 5000);
      if (result.exitCode === 0) {
        this.codexBin = candidate;
        return true;
      }
    }

    return false;
  }

  private async getLoginStatus(): Promise<{ loggedIn: boolean; label: string }> {
    const result = await this.runCommand(this.codexBin, ["login", "status"], 8000);
    const output = `${result.stdout}\n${result.stderr}`.trim();

    if (result.exitCode === 0 && /logged in/i.test(output)) {
      return { loggedIn: true, label: result.stdout.trim() || "Logged in" };
    }

    if (output) {
      return { loggedIn: false, label: output.split("\n")[0] ?? "Sign in required" };
    }

    return { loggedIn: false, label: "Sign in required" };
  }

  private async ensureEndpointConfigured(
    config: vscode.WorkspaceConfiguration,
    defaultSystemPrompt: string,
  ) {
    const endpoints = (config.get<EndpointConfig[]>("endpoints") ?? []).slice();
    const normalizedTarget = normalizeBaseUrl(CODEX_APP_SERVER_URL);
    const existing = endpoints.find(
      (endpoint) => normalizeBaseUrl(endpoint.url) === normalizedTarget,
    );

    if (existing) {
      existing.name = CODEX_APP_SERVER_NAME;
      existing.url = CODEX_APP_SERVER_URL;
      existing.maxTokens = existing.maxTokens ?? DEFAULT_MAX_TOKENS;
      existing.reasoningEffort = existing.reasoningEffort ?? "";
      existing.systemPrompt = existing.systemPrompt || defaultSystemPrompt;
      delete existing.apiKey;
    } else {
      endpoints.push({
        name: CODEX_APP_SERVER_NAME,
        url: CODEX_APP_SERVER_URL,
        model: "",
        reasoningEffort: "",
        maxTokens: DEFAULT_MAX_TOKENS,
        systemPrompt: defaultSystemPrompt,
      });
    }

    await config.update("endpoints", endpoints, vscode.ConfigurationTarget.Global);
  }

  private async ensureClient(workspaceRoot: string) {
    if (this.client && !this.client.isClosed) return;
    this.client = new CodexAppServerRpcClient(
      this.codexBin,
      workspaceRoot,
      this.outputChannel,
    );
    try {
      await this.client.initialize();
    } catch (error) {
      await this.client.close().catch(() => {});
      this.client = undefined;
      throw error;
    }
  }

  private async fetchModels(): Promise<CodexModelInfo[]> {
    if (!this.client || this.client.isClosed) return this.state.models;
    const modelList = await this.client.request<CodexModelList>("model/list", {
      includeHidden: false,
    });
    return toCodexModels(modelList);
  }

  private syncEndpointRuntimeState(
    endpointMgr: EndpointManager,
    models: CodexModelInfo[] = this.state.models,
  ) {
    const normalizedUrl = normalizeBaseUrl(CODEX_APP_SERVER_URL);
    endpointMgr.modelsByEndpoint.set(
      normalizedUrl,
      models.map((model) => model.id),
    );
    endpointMgr.statusSummaryByEndpoint.set(
      normalizedUrl,
      models.length
        ? `OK — ${models.length} Codex model(s)`
        : "Codex App Server connected.",
    );
    const health = endpointMgr.endpointHealthMap.get(normalizedUrl);
    if (health) {
      health.healthy = Boolean(this.client && !this.client.isClosed);
      health.lastChecked = Date.now();
      health.latencyMs = undefined;
      health.error = health.healthy ? undefined : "Codex App Server not started";
    } else {
      endpointMgr.endpointHealthMap.set(normalizedUrl, {
        name: CODEX_APP_SERVER_NAME,
        url: normalizedUrl,
        healthy: Boolean(this.client && !this.client.isClosed),
        lastChecked: Date.now(),
        error:
          this.client && !this.client.isClosed
            ? undefined
            : "Codex App Server not started",
      });
    }
  }

  private withEndpointState(
    state: CodexConnectionState,
    endpointMgr: EndpointManager,
  ): CodexConnectionState {
    const normalizedTarget = normalizeBaseUrl(CODEX_APP_SERVER_URL);
    const endpoint = endpointMgr
      .getEndpoints()
      .find((configuredEndpoint) => normalizeBaseUrl(configuredEndpoint.url) === normalizedTarget);
    const health = endpointMgr.endpointHealthMap.get(normalizedTarget);

    return {
      ...state,
      endpointConfigured: Boolean(endpoint),
      endpointActive: normalizeBaseUrl(endpointMgr.activeEndpointUrl) === normalizedTarget,
      endpointHealthy: Boolean(health?.healthy),
      selectedModel: endpoint?.model ?? "",
      selectedReasoningEffort: endpoint?.reasoningEffort ?? "",
    };
  }

  private deriveStatus(params: {
    available: boolean;
    loggedIn: boolean;
    serverRunning: boolean;
    modelsCount: number;
    endpointMgr: EndpointManager;
    busy: boolean;
  }): string {
    if (params.busy && this.busyMessage) return this.busyMessage;
    if (this.lastError) return this.lastError;

    const next = this.withEndpointState(defaultState(), params.endpointMgr);
    if (!params.available) {
      return "Codex CLI not found yet. Install Codex to use App Server.";
    }
    if (!params.loggedIn) {
      return "Sign in to Codex to use native app-server turns.";
    }
    if (params.serverRunning && params.modelsCount === 0) {
      return "Codex App Server is running. Loading models...";
    }
    if (next.endpointActive && next.endpointHealthy && params.serverRunning) {
      return "Connected. PocketAI is using Codex App Server.";
    }
    if (params.serverRunning && next.endpointConfigured) {
      return next.endpointActive
        ? "Codex App Server is running."
        : "Codex App Server is ready. Click Use on the endpoint to switch over.";
    }
    if (next.endpointConfigured) {
      return "Codex App Server endpoint is saved. Click Connect to start it.";
    }
    return "Connect Codex App Server to use native Codex turns in PocketAI.";
  }

  private openLoginTerminal(workspaceRoot: string) {
    const terminalAlive = this.loginTerminal?.exitStatus === undefined;
    if (!terminalAlive) {
      this.loginTerminal = vscode.window.createTerminal({
        name: "PocketAI Codex Login",
        cwd: workspaceRoot,
      });
    }

    this.loginTerminal?.show(true);
    this.loginTerminal?.sendText(
      `${this.shellQuote(this.codexBin)} login`,
      true,
    );
  }

  private shellQuote(value: string): string {
    if (process.platform === "win32") {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private runCommand(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      execFile(
        command,
        args,
        {
          cwd: this.context.extensionPath,
          env: process.env,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const stdOut = String(stdout || "");
          const stdErr = String(stderr || "");

          if (!error) {
            resolve({
              exitCode: 0,
              stdout: stdOut,
              stderr: stdErr,
              notFound: false,
            });
            return;
          }

          const nodeError = error as NodeJS.ErrnoException & {
            code?: string | number;
            signal?: NodeJS.Signals;
          };
          resolve({
            exitCode:
              typeof nodeError.code === "number" ? nodeError.code : null,
            stdout: stdOut,
            stderr: stdErr,
            notFound: nodeError.code === "ENOENT",
          });
        },
      );
    });
  }
}
