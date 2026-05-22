import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import * as vscode from "vscode";

import type { EndpointConfig } from "./types";
import type { EndpointManager } from "./endpoint-manager";
import { normalizeBaseUrl } from "./helpers";
import { CURSOR_BRIDGE_URL } from "./provider-constants";

export const CURSOR_BRIDGE_NAME = "Cursor CLI Bridge";
const CURSOR_BRIDGE_ROOT_URL = `${CURSOR_BRIDGE_URL}/`;
const CURSOR_BRIDGE_POLL_MS = 5000;

export type CursorModelInfo = {
  id: string;
  displayName: string;
  description: string;
};

export type CursorConnectionState = {
  available: boolean;
  loggedIn: boolean;
  loginLabel: string;
  bridgeRunning: boolean;
  endpointConfigured: boolean;
  endpointActive: boolean;
  endpointHealthy: boolean;
  models: CursorModelInfo[];
  selectedModel: string;
  busy: boolean;
  status: string;
  error: string;
};

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  notFound: boolean;
};

function defaultState(): CursorConnectionState {
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
    busy: false,
    status: "One click will add the endpoint and start Cursor for you.",
    error: "",
  };
}

export class CursorBridgeManager {
  private bridgeProcess?: ChildProcessWithoutNullStreams;
  private loginTerminal?: vscode.Terminal;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private refreshInFlight?: Promise<CursorConnectionState>;
  private state: CursorConnectionState = defaultState();
  private cursorBin = "cursor-agent";
  private busyMessage = "";
  private lastError = "";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  getState(endpointMgr: EndpointManager): CursorConnectionState {
    return this.withEndpointState(this.state, endpointMgr);
  }

  startPolling(
    endpointMgr: EndpointManager,
    onChange: (state: CursorConnectionState) => void,
    onReady?: (state: CursorConnectionState) => Promise<void>,
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
    this.refreshTimer = setInterval(() => void tick(), CURSOR_BRIDGE_POLL_MS);
  }

  async refresh(endpointMgr: EndpointManager): Promise<CursorConnectionState> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      const available = await this.resolveCursorBinary();
      const login = available
        ? await this.getLoginStatus()
        : { loggedIn: false, label: "Cursor CLI not found" };
      const bridgeRunning = await this.isBridgeResponsive();
      const models = bridgeRunning ? await this.getBridgeModels() : [];

      const base: CursorConnectionState = {
        ...this.state,
        available,
        loggedIn: login.loggedIn,
        loginLabel: login.label,
        bridgeRunning,
        models,
        busy: this.state.busy,
        error: this.lastError,
        status: this.deriveStatus({
          available,
          loggedIn: login.loggedIn,
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
  }): Promise<CursorConnectionState> {
    const workspaceRoot = options.workspaceRoot || os.homedir();

    this.state.busy = true;
    this.busyMessage = "Connecting to Cursor...";
    this.lastError = "";

    try {
      const available = await this.resolveCursorBinary();
      if (!available) {
        throw new Error(
          "Cursor CLI was not found. Install Cursor CLI or make the `cursor-agent` command available in PATH.",
        );
      }

      await this.ensureEndpointConfigured(
        options.config,
        options.defaultSystemPrompt,
      );
      options.endpointMgr.initEndpoints();
      options.endpointMgr.switchEndpoint(CURSOR_BRIDGE_URL);

      await this.ensureBridgeRunning(workspaceRoot);

      const login = await this.getLoginStatus();
      if (!login.loggedIn) {
        this.openLoginTerminal(workspaceRoot);
        this.busyMessage =
          "Finish signing in to Cursor in the terminal we opened.";
      } else {
        this.busyMessage = "Cursor CLI connected.";
      }
    } catch (error) {
      this.lastError =
        error instanceof Error ? error.message : "Failed to connect to Cursor.";
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
  }): Promise<CursorConnectionState> {
    if (this.state.busy) {
      return this.refresh(options.endpointMgr);
    }

    const current = await this.refresh(options.endpointMgr);
    if (!current.endpointConfigured || !current.available || current.bridgeRunning) {
      return current;
    }

    const workspaceRoot = options.workspaceRoot || os.homedir();

    this.state.busy = true;
    this.busyMessage = "Starting Cursor bridge...";
    this.lastError = "";

    try {
      await this.ensureEndpointConfigured(
        options.config,
        options.defaultSystemPrompt,
      );
      options.endpointMgr.initEndpoints();
      await this.ensureBridgeRunning(workspaceRoot);

      const login = await this.getLoginStatus();
      this.busyMessage = login.loggedIn
        ? "Cursor bridge is ready."
        : "Cursor bridge is ready. Sign in to finish connecting.";
    } catch (error) {
      this.lastError =
        error instanceof Error ? error.message : "Failed to start Cursor bridge.";
    } finally {
      this.state.busy = false;
    }

    return this.refresh(options.endpointMgr);
  }

  async signIn(
    workspaceRoot: string | undefined,
    endpointMgr: EndpointManager,
  ): Promise<CursorConnectionState> {
    const available = await this.resolveCursorBinary();
    if (!available) {
      const message =
        "Cursor CLI was not found. Install Cursor CLI or make the `cursor-agent` command available in PATH.";
      this.lastError = message;
      throw new Error(message);
    }

    this.lastError = "";
    this.openLoginTerminal(workspaceRoot || os.homedir());
    this.busyMessage =
      "Finish signing in to Cursor in the terminal we opened.";
    return this.refresh(endpointMgr);
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

  private async resolveCursorBinary(): Promise<boolean> {
    const envCandidate =
      process.env.CURSOR_AGENT_BIN?.trim() ||
      process.env.CURSOR_BIN?.trim();
    const candidates = Array.from(
      new Set(
        [
          envCandidate,
          this.cursorBin,
          "cursor-agent",
          process.platform === "darwin"
            ? "/usr/local/bin/cursor-agent"
            : "",
          process.platform === "darwin"
            ? "/opt/homebrew/bin/cursor-agent"
            : "",
          process.platform !== "win32"
            ? path.join(os.homedir(), ".local", "bin", "cursor-agent")
            : "",
        ].filter((value): value is string => Boolean(value)),
      ),
    );

    for (const candidate of candidates) {
      const result = await this.runCommand(candidate, ["--version"], 5000);
      if (result.exitCode === 0) {
        this.cursorBin = candidate;
        return true;
      }
    }

    return false;
  }

  private async getLoginStatus(): Promise<{ loggedIn: boolean; label: string }> {
    if (process.env.CURSOR_API_KEY?.trim()) {
      return { loggedIn: true, label: "Using CURSOR_API_KEY" };
    }

    const result = await this.runCommand(this.cursorBin, ["status"], 8000);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const firstLine = output.split("\n")[0] || "";

    if (
      result.exitCode === 0 &&
      !/not authenticated|not logged in|login required|sign in required/i.test(output)
    ) {
      return { loggedIn: true, label: firstLine || "Logged in" };
    }

    if (output) {
      return { loggedIn: false, label: firstLine || "Sign in required" };
    }

    return { loggedIn: false, label: "Sign in required" };
  }

  private async ensureEndpointConfigured(
    config: vscode.WorkspaceConfiguration,
    defaultSystemPrompt: string,
  ) {
    const endpoints = (config.get<EndpointConfig[]>("endpoints") ?? []).slice();
    const normalizedTarget = normalizeBaseUrl(CURSOR_BRIDGE_URL);
    const existing = endpoints.find(
      (endpoint) => normalizeBaseUrl(endpoint.url) === normalizedTarget,
    );

    if (existing) {
      existing.name = CURSOR_BRIDGE_NAME;
      existing.url = CURSOR_BRIDGE_URL;
      existing.model = existing.model || "composer-2.5";
      existing.maxTokens = existing.maxTokens ?? 4096;
      existing.systemPrompt = existing.systemPrompt || defaultSystemPrompt;
      delete existing.apiKey;
      existing.reasoningEffort = "";
    } else {
      endpoints.push({
        name: CURSOR_BRIDGE_NAME,
        url: CURSOR_BRIDGE_URL,
        model: "composer-2.5",
        reasoningEffort: "",
        maxTokens: 4096,
        systemPrompt: defaultSystemPrompt,
      });
    }

    await config.update("endpoints", endpoints, vscode.ConfigurationTarget.Global);
  }

  private async ensureBridgeRunning(workspaceRoot: string) {
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
      "cursor-openai-bridge.mjs",
    );

    const child = spawn(process.execPath, [scriptPath], {
      cwd: this.context.extensionPath,
      env: {
        ...process.env,
        CURSOR_BRIDGE_CWD: workspaceRoot,
        CURSOR_BRIDGE_CURSOR_BIN: this.cursorBin,
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
        this.lastError = `Cursor bridge exited with code ${code}.`;
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
      this.lastError || "Cursor bridge failed to start. Check the PocketAI output channel.",
    );
  }

  private async isBridgeResponsive(): Promise<boolean> {
    try {
      const response = await fetch(CURSOR_BRIDGE_ROOT_URL, {
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return false;
      const payload = (await response.json()) as { name?: string };
      return payload.name === "pocketai-cursor-bridge";
    } catch {
      return false;
    }
  }

  private async getBridgeModels(): Promise<CursorModelInfo[]> {
    try {
      const response = await fetch(`${CURSOR_BRIDGE_URL}/v1/models`, {
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
    state: CursorConnectionState,
    endpointMgr: EndpointManager,
  ): CursorConnectionState {
    const normalizedTarget = normalizeBaseUrl(CURSOR_BRIDGE_URL);
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
    available: boolean;
    loggedIn: boolean;
    bridgeRunning: boolean;
    endpointMgr: EndpointManager;
    busy: boolean;
  }): string {
    if (params.busy && this.busyMessage) return this.busyMessage;
    if (this.lastError) return this.lastError;

    const next = this.withEndpointState(defaultState(), params.endpointMgr);

    if (!params.available) {
      return "Cursor CLI not found yet. Install Cursor CLI to use this shortcut.";
    }
    if (!params.loggedIn) {
      return params.bridgeRunning
        ? "Bridge is ready. Sign in to Cursor to finish connecting."
        : "Sign in to Cursor to get started.";
    }
    if (next.endpointActive && next.endpointHealthy && params.bridgeRunning) {
      return "Connected. PocketAI is ready to chat through Cursor.";
    }
    if (params.bridgeRunning && next.endpointConfigured) {
      return next.endpointActive
        ? "Cursor bridge is running. Refreshing the connection..."
        : "Cursor is ready. Click Use on the Cursor endpoint to switch over.";
    }
    if (next.endpointConfigured) {
      return "Cursor endpoint is saved. Click Connect to start it.";
    }
    return "One click will add the endpoint and start Cursor for you.";
  }

  private openLoginTerminal(workspaceRoot: string) {
    const terminalAlive = this.loginTerminal?.exitStatus === undefined;
    if (!terminalAlive) {
      this.loginTerminal = vscode.window.createTerminal({
        name: "PocketAI Cursor Login",
        cwd: workspaceRoot,
      });
    }

    this.loginTerminal?.show(true);
    this.loginTerminal?.sendText(
      `${this.shellQuote(this.cursorBin)} login`,
      true,
    );
  }

  private shellQuote(value: string): string {
    if (process.platform === "win32") {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private appendBridgeOutput(text: string) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.outputChannel.appendLine(`[Cursor CLI Bridge] ${trimmed}`);
    }
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

          const exitCode =
            typeof (error as NodeJS.ErrnoException & { code?: number | string }).code === "number"
              ? Number((error as NodeJS.ErrnoException & { code?: number }).code)
              : null;
          const notFound =
            (error as NodeJS.ErrnoException).code === "ENOENT";

          resolve({
            exitCode,
            stdout: stdOut,
            stderr: stdErr || (error as Error).message,
            notFound,
          });
        },
      );
    });
  }
}
