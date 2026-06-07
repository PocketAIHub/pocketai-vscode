import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import * as vscode from "vscode";

import type { EndpointConfig } from "./types";
import type { EndpointManager } from "./endpoint-manager";
import { normalizeBaseUrl } from "./helpers";
import { CODEX_BRIDGE_URL } from "./provider-constants";

export const CODEX_BRIDGE_NAME = "Codex CLI Bridge";
const CODEX_BRIDGE_ROOT_URL = `${CODEX_BRIDGE_URL}/`;
const CODEX_BRIDGE_META_URL = `${CODEX_BRIDGE_URL}/codex/meta`;
const CODEX_BRIDGE_POLL_MS = 5000;
const CODEX_BRIDGE_PORT = new URL(CODEX_BRIDGE_URL).port || "39458";
const CODEX_BRIDGE_STALE_MESSAGE =
  "An older Codex bridge is already running on 127.0.0.1:39458 without image support. Restart it once, then connect Codex again.";

export type CodexReasoningOption = {
  reasoningEffort: string;
  description: string;
};

export type CodexModelInfo = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: CodexReasoningOption[];
};

export type CodexConnectionState = {
  available: boolean;
  loggedIn: boolean;
  loginLabel: string;
  bridgeRunning: boolean;
  endpointConfigured: boolean;
  endpointActive: boolean;
  endpointHealthy: boolean;
  models: CodexModelInfo[];
  selectedModel: string;
  selectedReasoningEffort: string;
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

type BridgeRootPayload = {
  name?: string;
  version?: string;
  capabilities?: {
    imageInput?: boolean;
  };
};

type BridgeProbe = {
  responsive: boolean;
  compatible: boolean;
  payload?: BridgeRootPayload;
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
    status: "One click will add the endpoint and start Codex for you.",
    error: "",
  };
}

export class CodexBridgeManager {
  private bridgeProcess?: ChildProcessWithoutNullStreams;
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
      if (onReady) {
        await onReady(next);
      }
      onChange(next);
    };

    void tick();
    this.refreshTimer = setInterval(() => void tick(), CODEX_BRIDGE_POLL_MS);
  }

  async refresh(endpointMgr: EndpointManager): Promise<CodexConnectionState> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      const available = await this.resolveCodexBinary();
      const login = available
        ? await this.getLoginStatus()
        : { loggedIn: false, label: "Codex CLI not found" };
      const bridgeProbe = await this.getBridgeProbe();
      const bridgeRunning = bridgeProbe.compatible;
      const models = bridgeRunning
        ? await this.getBridgeModels()
        : [];

      const base: CodexConnectionState = {
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
          modelsCount: models.length,
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
  }): Promise<CodexConnectionState> {
    const workspaceRoot = options.workspaceRoot || os.homedir();

    this.state.busy = true;
    this.busyMessage = "Connecting to Codex...";
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
      options.endpointMgr.switchEndpoint(CODEX_BRIDGE_URL);

      await this.ensureBridgeRunning(workspaceRoot);

      const login = await this.getLoginStatus();
      if (!login.loggedIn) {
        this.openLoginTerminal(workspaceRoot);
        this.busyMessage =
          "Finish signing in to Codex in the terminal we opened.";
      } else {
        this.busyMessage = "Codex CLI connected.";
      }
    } catch (error) {
      this.lastError =
        error instanceof Error ? error.message : "Failed to connect to Codex.";
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
    if (this.state.busy) {
      return this.refresh(options.endpointMgr);
    }

    const current = await this.refresh(options.endpointMgr);
    if (!current.endpointConfigured || !current.available || current.bridgeRunning) {
      return current;
    }

    const workspaceRoot = options.workspaceRoot || os.homedir();

    this.state.busy = true;
    this.busyMessage = "Starting Codex bridge...";
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
        ? "Codex bridge is ready."
        : "Codex bridge is ready. Sign in to finish connecting.";
    } catch (error) {
      this.lastError =
        error instanceof Error ? error.message : "Failed to start Codex bridge.";
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

  dispose() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    if (this.bridgeProcess && this.bridgeProcess.exitCode === null) {
      this.bridgeProcess.kill("SIGTERM");
    }
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
    const normalizedTarget = normalizeBaseUrl(CODEX_BRIDGE_URL);
    const existing = endpoints.find(
      (endpoint) => normalizeBaseUrl(endpoint.url) === normalizedTarget,
    );

    if (existing) {
      existing.name = CODEX_BRIDGE_NAME;
      existing.url = CODEX_BRIDGE_URL;
      existing.maxTokens = existing.maxTokens ?? 4096;
      existing.reasoningEffort = existing.reasoningEffort ?? "";
      existing.systemPrompt = existing.systemPrompt || defaultSystemPrompt;
      delete existing.apiKey;
    } else {
      endpoints.push({
        name: CODEX_BRIDGE_NAME,
        url: CODEX_BRIDGE_URL,
        model: "",
        reasoningEffort: "",
        maxTokens: 4096,
        systemPrompt: defaultSystemPrompt,
      });
    }

    await config.update("endpoints", endpoints, vscode.ConfigurationTarget.Global);
  }

  private async ensureBridgeRunning(workspaceRoot: string) {
    const existingBridge = await this.getBridgeProbe();
    if (existingBridge.compatible) {
      const models = await this.getBridgeModels();
      if (models.length > 0) return;
      throw new Error(
        "An older Codex bridge is already running on 127.0.0.1:39458. Restart it once to enable model and reasoning controls.",
      );
    }
    if (existingBridge.responsive) {
      this.outputChannel.appendLine(
        "[Codex CLI Bridge] Restarting stale Codex bridge without image support.",
      );
      const stopped = await this.stopStaleBridgeOnPort();
      if (!stopped || (await this.getBridgeProbe()).responsive) {
        throw new Error(CODEX_BRIDGE_STALE_MESSAGE);
      }
    }

    if (this.bridgeProcess && this.bridgeProcess.exitCode === null) {
      this.bridgeProcess.kill("SIGTERM");
      this.bridgeProcess = undefined;
    }

    const scriptPath = path.join(
      this.context.extensionPath,
      "scripts",
      "codex-openai-bridge.mjs",
    );

    const child = spawn(process.execPath, [scriptPath], {
      cwd: this.context.extensionPath,
      env: {
        ...process.env,
        // In the extension host, process.execPath is VS Code's Electron binary,
        // not Node. This flag makes it run the bridge script as Node so the
        // server actually starts (otherwise it launches as a GUI app and the
        // bridge port is never bound — "Connection refused").
        ELECTRON_RUN_AS_NODE: "1",
        CODEX_BRIDGE_CWD: workspaceRoot,
        CODEX_BRIDGE_CODEX_BIN: this.codexBin,
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
        this.lastError = `Codex bridge exited with code ${code}.`;
      }
    });

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if ((await this.getBridgeProbe()).compatible) return;
      if (this.bridgeProcess?.exitCode !== null && this.bridgeProcess?.exitCode !== undefined) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(
      this.lastError || "Codex bridge failed to start. Check the PocketAI output channel.",
    );
  }

  private async getBridgeProbe(): Promise<BridgeProbe> {
    try {
      const response = await fetch(CODEX_BRIDGE_ROOT_URL, {
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) {
        return { responsive: false, compatible: false };
      }
      const payload = (await response.json()) as BridgeRootPayload;
      const responsive = payload.name === "pocketai-codex-bridge";
      return {
        responsive,
        compatible: responsive && payload.capabilities?.imageInput === true,
        payload,
      };
    } catch {
      return { responsive: false, compatible: false };
    }
  }

  private async stopStaleBridgeOnPort(): Promise<boolean> {
    if (this.bridgeProcess && this.bridgeProcess.exitCode === null) {
      this.bridgeProcess.kill("SIGTERM");
      this.bridgeProcess = undefined;
      await this.waitForBridgeToStop();
      return !(await this.getBridgeProbe()).responsive;
    }

    if (process.platform === "win32") {
      return false;
    }

    const pidResult = await this.runCommand(
      "lsof",
      ["-ti", `tcp:${CODEX_BRIDGE_PORT}`, "-sTCP:LISTEN"],
      2500,
    );
    const pids = pidResult.stdout
      .split(/\s+/)
      .map((pid) => pid.trim())
      .filter((pid) => /^\d+$/.test(pid));

    if (!pids.length) {
      return false;
    }

    let stoppedAny = false;
    for (const pid of pids) {
      const commandResult = await this.runCommand(
        "ps",
        ["-p", pid, "-o", "command="],
        2500,
      );
      const command = commandResult.stdout.trim();
      if (!command.includes("codex-openai-bridge.mjs")) {
        continue;
      }

      const killResult = await this.runCommand("kill", [pid], 2500);
      if (killResult.exitCode === 0) {
        stoppedAny = true;
      }
    }

    if (stoppedAny) {
      await this.waitForBridgeToStop();
    }

    return stoppedAny;
  }

  private async waitForBridgeToStop(): Promise<void> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (!(await this.getBridgeProbe()).responsive) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  private async getBridgeModels(): Promise<CodexModelInfo[]> {
    try {
      const response = await fetch(CODEX_BRIDGE_META_URL, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return [];
      const payload = (await response.json()) as { data?: CodexModelInfo[] };
      return Array.isArray(payload.data) ? payload.data : [];
    } catch {
      return [];
    }
  }

  private withEndpointState(
    state: CodexConnectionState,
    endpointMgr: EndpointManager,
  ): CodexConnectionState {
    const normalizedTarget = normalizeBaseUrl(CODEX_BRIDGE_URL);
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
    bridgeRunning: boolean;
    modelsCount: number;
    endpointMgr: EndpointManager;
    busy: boolean;
  }): string {
    if (params.busy && this.busyMessage) return this.busyMessage;
    if (this.lastError) return this.lastError;

    const next = this.withEndpointState(defaultState(), params.endpointMgr);

    if (!params.available) {
      return "Codex CLI not found yet. Install Codex to use this shortcut.";
    }
    if (!params.loggedIn) {
      return params.bridgeRunning
        ? "Bridge is ready. Sign in to Codex to finish connecting."
        : "Sign in to Codex to get started.";
    }
    if (params.bridgeRunning && params.modelsCount === 0) {
      return "Connected, but the running bridge needs one restart to load model and reasoning controls.";
    }
    if (next.endpointActive && next.endpointHealthy && params.bridgeRunning) {
      return "Connected. PocketAI is ready to chat through Codex.";
    }
    if (params.bridgeRunning && next.endpointConfigured) {
      return next.endpointActive
        ? "Codex bridge is running. Refreshing the connection..."
        : "Codex is ready. Click Use on the Codex endpoint to switch over.";
    }
    if (next.endpointConfigured) {
      return "Codex endpoint is saved. Click Connect to start it.";
    }
    return "One click will add the endpoint and start Codex for you.";
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

  private appendBridgeOutput(text: string) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.outputChannel.appendLine(`[Codex CLI Bridge] ${trimmed}`);
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
