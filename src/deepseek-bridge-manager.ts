import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import * as vscode from "vscode";

import type { EndpointConfig } from "./types";
import type { EndpointManager } from "./endpoint-manager";
import { normalizeBaseUrl } from "./helpers";
import { DEEPSEEK_BRIDGE_URL } from "./provider-constants";

export const DEEPSEEK_BRIDGE_NAME = "DeepSeek API Bridge";
const DEEPSEEK_BRIDGE_ROOT_URL = `${DEEPSEEK_BRIDGE_URL}/`;
const DEEPSEEK_BRIDGE_POLL_MS = 5000;

export type DeepSeekModelInfo = {
  id: string;
  displayName: string;
  description: string;
};

export type DeepSeekConnectionState = {
  available: boolean;
  loggedIn: boolean;
  loginLabel: string;
  apiKeyConfigured: boolean;
  bridgeRunning: boolean;
  endpointConfigured: boolean;
  endpointActive: boolean;
  endpointHealthy: boolean;
  models: DeepSeekModelInfo[];
  selectedModel: string;
  busy: boolean;
  status: string;
  error: string;
};

function defaultState(): DeepSeekConnectionState {
  return {
    available: true,
    loggedIn: false,
    loginLabel: "API key required",
    apiKeyConfigured: false,
    bridgeRunning: false,
    endpointConfigured: false,
    endpointActive: false,
    endpointHealthy: false,
    models: [],
    selectedModel: "",
    busy: false,
    status: "One click will add the endpoint and start DeepSeek V4 for you.",
    error: "",
  };
}

export class DeepSeekBridgeManager {
  private bridgeProcess?: ChildProcessWithoutNullStreams;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private refreshInFlight?: Promise<DeepSeekConnectionState>;
  private state: DeepSeekConnectionState = defaultState();
  private busyMessage = "";
  private lastError = "";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  getState(endpointMgr: EndpointManager): DeepSeekConnectionState {
    return this.withEndpointState(this.state, endpointMgr);
  }

  startPolling(
    endpointMgr: EndpointManager,
    onChange: (state: DeepSeekConnectionState) => void,
    onReady?: (state: DeepSeekConnectionState) => Promise<void>,
  ) {
    if (this.refreshTimer) return;

    const tick = async () => {
      const next = await this.refresh(endpointMgr);
      if (onReady) {
        await onReady(next);
      }
      onChange(next);
    };

    void tick();
    this.refreshTimer = setInterval(() => void tick(), DEEPSEEK_BRIDGE_POLL_MS);
  }

  async refresh(endpointMgr: EndpointManager): Promise<DeepSeekConnectionState> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      const apiKeyStatus = this.getApiKeyStatus(endpointMgr);
      const bridgeRunning = await this.isBridgeResponsive();
      const models =
        bridgeRunning && apiKeyStatus.configured
          ? await this.getBridgeModels(endpointMgr)
          : [];

      const base: DeepSeekConnectionState = {
        ...this.state,
        available: true,
        loggedIn: apiKeyStatus.configured,
        loginLabel: apiKeyStatus.label,
        apiKeyConfigured: apiKeyStatus.configured,
        bridgeRunning,
        models,
        busy: this.state.busy,
        error: this.lastError,
        status: this.deriveStatus({
          apiKeyConfigured: apiKeyStatus.configured,
          bridgeRunning,
          endpointMgr,
          busy: this.state.busy,
        }),
      };

      this.state = this.withEndpointState(base, endpointMgr);
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
  }): Promise<DeepSeekConnectionState> {
    this.state.busy = true;
    this.busyMessage = "Connecting to DeepSeek...";
    this.lastError = "";

    try {
      await this.ensureEndpointConfigured(
        options.config,
        options.defaultSystemPrompt,
      );
      options.endpointMgr.initEndpoints();
      options.endpointMgr.switchEndpoint(DEEPSEEK_BRIDGE_URL);

      await this.ensureBridgeRunning(options.endpointMgr, options.workspaceRoot);
      this.busyMessage = this.getApiKeyStatus(options.endpointMgr).configured
        ? "DeepSeek API bridge connected."
        : "DeepSeek bridge is ready. Save an API key to finish connecting.";
    } catch (error) {
      this.lastError =
        error instanceof Error ? error.message : "Failed to connect to DeepSeek.";
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
  }): Promise<DeepSeekConnectionState> {
    if (this.state.busy) {
      return this.refresh(options.endpointMgr);
    }

    const current = await this.refresh(options.endpointMgr);
    if (!current.endpointConfigured || current.bridgeRunning) {
      return current;
    }

    this.state.busy = true;
    this.busyMessage = "Starting DeepSeek bridge...";
    this.lastError = "";

    try {
      await this.ensureEndpointConfigured(
        options.config,
        options.defaultSystemPrompt,
      );
      options.endpointMgr.initEndpoints();
      await this.ensureBridgeRunning(options.endpointMgr, options.workspaceRoot);

      this.busyMessage = this.getApiKeyStatus(options.endpointMgr).configured
        ? "DeepSeek bridge is ready."
        : "DeepSeek bridge is ready. Save an API key to finish connecting.";
    } catch (error) {
      this.lastError =
        error instanceof Error ? error.message : "Failed to start DeepSeek bridge.";
    } finally {
      this.state.busy = false;
    }

    return this.refresh(options.endpointMgr);
  }

  async ensureEndpoint(
    config: vscode.WorkspaceConfiguration,
    defaultSystemPrompt: string,
  ) {
    await this.ensureEndpointConfigured(config, defaultSystemPrompt);
  }

  dispose() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    if (this.bridgeProcess && this.bridgeProcess.exitCode === null) {
      this.bridgeProcess.kill("SIGTERM");
    }
  }

  private getApiKeyStatus(endpointMgr: EndpointManager): {
    configured: boolean;
    label: string;
  } {
    if (endpointMgr.hasEndpointApiKey(DEEPSEEK_BRIDGE_URL)) {
      return { configured: true, label: "API key saved" };
    }
    if (process.env.DEEPSEEK_API_KEY?.trim()) {
      return { configured: true, label: "Using DEEPSEEK_API_KEY from env" };
    }
    return { configured: false, label: "API key required" };
  }

  private getApiKey(endpointMgr: EndpointManager): string {
    return (
      endpointMgr.getEndpointApiKey(DEEPSEEK_BRIDGE_URL) ||
      process.env.DEEPSEEK_API_KEY?.trim() ||
      ""
    );
  }

  private async ensureEndpointConfigured(
    config: vscode.WorkspaceConfiguration,
    defaultSystemPrompt: string,
  ) {
    const endpoints = (config.get<EndpointConfig[]>("endpoints") ?? []).slice();
    const normalizedTarget = normalizeBaseUrl(DEEPSEEK_BRIDGE_URL);
    const existing = endpoints.find(
      (endpoint) => normalizeBaseUrl(endpoint.url) === normalizedTarget,
    );

    if (existing) {
      existing.name = DEEPSEEK_BRIDGE_NAME;
      existing.url = DEEPSEEK_BRIDGE_URL;
      existing.model = existing.model || "deepseek-v4-pro";
      existing.maxTokens = existing.maxTokens ?? 32768;
      existing.systemPrompt = existing.systemPrompt || defaultSystemPrompt;
      existing.reasoningEffort = existing.reasoningEffort || "";
      delete existing.apiKey;
    } else {
      endpoints.push({
        name: DEEPSEEK_BRIDGE_NAME,
        url: DEEPSEEK_BRIDGE_URL,
        model: "deepseek-v4-pro",
        reasoningEffort: "",
        maxTokens: 32768,
        systemPrompt: defaultSystemPrompt,
      });
    }

    await config.update("endpoints", endpoints, vscode.ConfigurationTarget.Global);
  }

  private async ensureBridgeRunning(
    endpointMgr: EndpointManager,
    workspaceRoot?: string,
  ) {
    if (await this.isBridgeResponsive()) {
      return;
    }

    if (this.bridgeProcess && this.bridgeProcess.exitCode === null) {
      this.bridgeProcess.kill("SIGTERM");
      this.bridgeProcess = undefined;
    }

    const scriptPath = path.join(
      this.context.extensionPath,
      "scripts",
      "deepseek-openai-bridge.mjs",
    );

    const child = spawn(process.execPath, [scriptPath], {
      cwd: this.context.extensionPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        DEEPSEEK_BRIDGE_CWD: workspaceRoot || "",
        DEEPSEEK_API_KEY: this.getApiKey(endpointMgr),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.bridgeProcess = child;

    child.stdout.on("data", (chunk: Buffer) => {
      this.appendBridgeOutput(chunk.toString("utf8"));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.appendBridgeOutput(chunk.toString("utf8"));
    });

    child.once("exit", (code) => {
      if (this.bridgeProcess === child) {
        this.bridgeProcess = undefined;
      }
      if (code && !this.lastError) {
        this.lastError = `DeepSeek bridge exited with code ${code}.`;
      }
    });

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await this.isBridgeResponsive()) return;
      if (this.bridgeProcess?.exitCode !== null && this.bridgeProcess?.exitCode !== undefined) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(
      this.lastError || "DeepSeek bridge failed to start. Check the PocketAI output channel.",
    );
  }

  private async isBridgeResponsive(): Promise<boolean> {
    try {
      const response = await fetch(DEEPSEEK_BRIDGE_ROOT_URL, {
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return false;
      const payload = (await response.json()) as { name?: string };
      return payload.name === "pocketai-deepseek-bridge";
    } catch {
      return false;
    }
  }

  private async getBridgeModels(
    endpointMgr: EndpointManager,
  ): Promise<DeepSeekModelInfo[]> {
    try {
      const apiKey = this.getApiKey(endpointMgr) || "local-pocketai";
      const response = await fetch(`${DEEPSEEK_BRIDGE_URL}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return [];
      const payload = (await response.json()) as {
        data?: Array<{
          id?: string;
          display_name?: string;
          description?: string;
        }>;
      };
      return Array.isArray(payload.data)
        ? payload.data
            .map((model) => ({
              id: model.id?.trim() ?? "",
              displayName: model.display_name?.trim() || model.id?.trim() || "",
              description: model.description?.trim() ?? "",
            }))
            .filter((model) => Boolean(model.id))
        : [];
    } catch {
      return [];
    }
  }

  private withEndpointState(
    state: DeepSeekConnectionState,
    endpointMgr: EndpointManager,
  ): DeepSeekConnectionState {
    const normalizedTarget = normalizeBaseUrl(DEEPSEEK_BRIDGE_URL);
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
    };
  }

  private deriveStatus(params: {
    apiKeyConfigured: boolean;
    bridgeRunning: boolean;
    endpointMgr: EndpointManager;
    busy: boolean;
  }): string {
    if (params.busy && this.busyMessage) return this.busyMessage;
    if (this.lastError) return this.lastError;

    const next = this.withEndpointState(defaultState(), params.endpointMgr);

    if (!params.apiKeyConfigured) {
      return next.endpointConfigured
        ? "DeepSeek endpoint is saved. Add an API key to use V4."
        : "Add the endpoint and save a DeepSeek API key to get started.";
    }
    if (next.endpointActive && next.endpointHealthy && params.bridgeRunning) {
      return "Connected. PocketAI is ready to chat through DeepSeek V4.";
    }
    if (params.bridgeRunning && next.endpointConfigured) {
      return next.endpointActive
        ? "DeepSeek bridge is running. Refreshing the connection..."
        : "DeepSeek is ready. Click Use on the DeepSeek endpoint to switch over.";
    }
    if (next.endpointConfigured) {
      return "DeepSeek endpoint is saved. Click Connect to start it.";
    }
    return "One click will add the endpoint and start DeepSeek V4 for you.";
  }

  private appendBridgeOutput(text: string) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.outputChannel.appendLine(`[DeepSeek Bridge] ${trimmed}`);
    }
  }
}
