import * as vscode from "vscode";
import * as child_process from "child_process";
import type { ToolCall } from "./types";
import type { OpenAITool } from "./tool-definitions";
import type {
  McpPrompt,
  McpPromptGetResult,
  McpResource,
  McpResourceReadResult,
  McpResourceTemplate,
} from "./mcp-format";

/**
 * MCP (Model Context Protocol) client for connecting to external tool servers.
 * Supports stdio-based MCP servers that communicate via JSON-RPC over stdin/stdout.
 */

export type McpServerConfig = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
};

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
};

export type McpServerMetadata = {
  name: string;
  capabilities?: Record<string, unknown>;
  instructions?: string;
  protocolVersion?: string;
};

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

export class McpManager {
  private servers = new Map<string, McpServerConnection>();
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  /** Connect to all configured MCP servers. */
  async connectAll(configs: McpServerConfig[]) {
    // Disconnect any servers no longer in config
    for (const [name, conn] of this.servers) {
      if (!configs.find((c) => c.name === name && c.enabled !== false)) {
        conn.dispose();
        this.servers.delete(name);
      }
    }

    for (const config of configs) {
      if (config.enabled === false) continue;
      if (this.servers.has(config.name)) continue;

      try {
        const conn = new McpServerConnection(config, this.outputChannel);
        await conn.initialize();
        this.servers.set(config.name, conn);
        this.outputChannel.appendLine(`MCP: Connected to ${config.name}`);
      } catch (e) {
        this.outputChannel.appendLine(
          `MCP: Failed to connect to ${config.name}: ${(e as Error).message}`,
        );
      }
    }
  }

  /** Get OpenAI-format tool definitions from all connected MCP servers. */
  getToolDefinitions(): OpenAITool[] {
    const tools: OpenAITool[] = [];
    for (const [serverName, conn] of this.servers) {
      for (const tool of conn.tools) {
        tools.push({
          type: "function",
          function: {
            name: `mcp__${serverName}__${tool.name}`,
            description: tool.description || `MCP tool from ${serverName}`,
            parameters: tool.inputSchema || { type: "object", properties: {} },
          },
        });
      }
    }
    return tools;
  }

  /** Check if a tool name is an MCP tool. */
  isMcpTool(toolName: string): boolean {
    return toolName.startsWith("mcp__");
  }

  /** Execute an MCP tool call. */
  async executeTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const parts = toolName.split("__");
    if (parts.length < 3) return `Error: Invalid MCP tool name: ${toolName}`;

    const serverName = parts[1];
    const mcpToolName = parts.slice(2).join("__");
    const conn = this.servers.get(serverName);
    if (!conn) return `Error: MCP server "${serverName}" not connected.`;

    try {
      return await conn.callTool(mcpToolName, args);
    } catch (e) {
      return `MCP error: ${(e as Error).message}`;
    }
  }

  /** Execute an MCP tool call wrapped as a ToolCall. */
  async executeToolCall(toolCall: ToolCall): Promise<string> {
    const args: Record<string, unknown> = {};
    // The tool call's various fields are the arguments
    if (toolCall.command) args.command = toolCall.command;
    if (toolCall.query) args.query = toolCall.query;
    if (toolCall.pattern) args.pattern = toolCall.pattern;
    if (toolCall.filePath) args.path = toolCall.filePath;
    if (toolCall.content) args.content = toolCall.content;
    // For structured tool calls, the args are passed via mcpArgs
    if ((toolCall as { mcpArgs?: Record<string, unknown> }).mcpArgs) {
      Object.assign(args, (toolCall as { mcpArgs?: Record<string, unknown> }).mcpArgs);
    }

    return this.executeTool(toolCall.type, args);
  }

  /** Get list of connected server names. */
  getConnectedServers(): string[] {
    return Array.from(this.servers.keys());
  }

  getServerMetadata(serverName: string): McpServerMetadata | undefined {
    return this.servers.get(serverName)?.getMetadata();
  }

  async listResources(
    serverName?: string,
  ): Promise<Array<{ serverName: string; resources: McpResource[] }>> {
    const entries = this.getServerEntries(serverName);
    return Promise.all(
      entries.map(async ([name, conn]) => ({
        serverName: name,
        resources: conn.supportsCapability("resources")
          ? await conn.listResources()
          : [],
      })),
    );
  }

  async readResource(
    serverName: string,
    uri: string,
  ): Promise<McpResourceReadResult> {
    const conn = this.servers.get(serverName);
    if (!conn) throw new Error(`MCP server "${serverName}" not connected.`);
    return conn.readResource(uri);
  }

  async listResourceTemplates(
    serverName?: string,
  ): Promise<Array<{ serverName: string; templates: McpResourceTemplate[] }>> {
    const entries = this.getServerEntries(serverName);
    return Promise.all(
      entries.map(async ([name, conn]) => ({
        serverName: name,
        templates: conn.supportsCapability("resources")
          ? await conn.listResourceTemplates()
          : [],
      })),
    );
  }

  async listPrompts(
    serverName?: string,
  ): Promise<Array<{ serverName: string; prompts: McpPrompt[] }>> {
    const entries = this.getServerEntries(serverName);
    return Promise.all(
      entries.map(async ([name, conn]) => ({
        serverName: name,
        prompts: conn.supportsCapability("prompts")
          ? await conn.listPrompts()
          : [],
      })),
    );
  }

  async getPrompt(
    serverName: string,
    name: string,
    args?: Record<string, unknown>,
  ): Promise<McpPromptGetResult> {
    const conn = this.servers.get(serverName);
    if (!conn) throw new Error(`MCP server "${serverName}" not connected.`);
    return conn.getPrompt(name, args);
  }

  /** Disconnect all servers. */
  disposeAll() {
    for (const conn of this.servers.values()) {
      conn.dispose();
    }
    this.servers.clear();
  }

  private getServerEntries(
    serverName?: string,
  ): Array<[string, McpServerConnection]> {
    if (!serverName) return Array.from(this.servers.entries());
    const conn = this.servers.get(serverName);
    if (!conn) throw new Error(`MCP server "${serverName}" not connected.`);
    return [[serverName, conn]];
  }
}

class McpServerConnection {
  private process: child_process.ChildProcess;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = "";
  tools: McpTool[] = [];
  private capabilities?: Record<string, unknown>;
  private instructions?: string;
  private protocolVersion?: string;
  private resources?: McpResource[];
  private resourceTemplates?: McpResourceTemplate[];
  private prompts?: McpPrompt[];

  constructor(
    private config: McpServerConfig,
    private outputChannel: vscode.OutputChannel,
  ) {
    this.process = child_process.spawn(config.command, config.args || [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...config.env },
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      this.outputChannel.appendLine(
        `MCP [${config.name}] stderr: ${data.toString().trim()}`,
      );
    });

    this.process.on("error", (err) => {
      this.outputChannel.appendLine(
        `MCP [${config.name}] process error: ${err.message}`,
      );
    });

    this.process.on("close", (code) => {
      this.outputChannel.appendLine(
        `MCP [${config.name}] process exited with code ${code}`,
      );
      // Reject all pending requests
      for (const [, p] of this.pending) {
        p.reject(new Error(`MCP server ${config.name} exited`));
      }
      this.pending.clear();
    });
  }

  private processBuffer() {
    // MCP uses newline-delimited JSON
    while (true) {
      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx === -1) break;

      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(msg.error.message));
          } else {
            p.resolve(msg.result);
          }
        } else if (msg.method) {
          this.handleNotification(msg.method);
        }
      } catch {
        this.outputChannel.appendLine(
          `MCP [${this.config.name}] invalid JSON: ${line.slice(0, 200)}`,
        );
      }
    }
  }

  private handleNotification(method: string) {
    if (method === "notifications/tools/list_changed") {
      void this.refreshTools().catch((error) => {
        this.outputChannel.appendLine(
          `MCP [${this.config.name}] failed to refresh tools: ${(error as Error).message}`,
        );
      });
      return;
    }

    if (method === "notifications/resources/list_changed") {
      this.resources = undefined;
      this.resourceTemplates = undefined;
      return;
    }

    if (method === "notifications/prompts/list_changed") {
      this.prompts = undefined;
    }
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;

      const timeoutHandle = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(
            new Error(`MCP request timed out: ${method} on ${this.config.name}`),
          );
        }
      }, 30000);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timeoutHandle); resolve(v); },
        reject: (e) => { clearTimeout(timeoutHandle); reject(e); },
      });

      const msg: JsonRpcMessage = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      const data = JSON.stringify(msg) + "\n";
      const ok = this.process.stdin?.write(data);
      if (!ok) {
        clearTimeout(timeoutHandle);
        this.pending.delete(id);
        reject(new Error(`Failed to write to MCP server ${this.config.name}`));
      }
    });
  }

  async initialize() {
    const result = (await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "PocketAI", version: "1.0.0" },
    })) as {
      capabilities?: Record<string, unknown>;
      instructions?: string;
      protocolVersion?: string;
    };
    this.capabilities = result.capabilities;
    this.instructions = result.instructions;
    this.protocolVersion = result.protocolVersion;

    // Send initialized notification
    const notification: JsonRpcMessage = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    };
    this.process.stdin?.write(JSON.stringify(notification) + "\n");

    // List available tools
    await this.refreshTools();
    return result;
  }

  async refreshTools() {
    this.tools = await this.sendPaginatedList<McpTool>("tools/list", "tools");
    this.outputChannel.appendLine(
      `MCP [${this.config.name}]: ${this.tools.length} tools available`,
    );
  }

  getMetadata(): McpServerMetadata {
    return {
      name: this.config.name,
      capabilities: this.capabilities,
      instructions: this.instructions,
      protocolVersion: this.protocolVersion,
    };
  }

  supportsCapability(name: string): boolean {
    if (!this.capabilities) return true;
    return Object.prototype.hasOwnProperty.call(this.capabilities, name);
  }

  async listResources(): Promise<McpResource[]> {
    if (!this.resources) {
      this.resources = await this.sendPaginatedList<McpResource>(
        "resources/list",
        "resources",
      );
    }
    return this.resources;
  }

  async readResource(uri: string): Promise<McpResourceReadResult> {
    return (await this.sendRequest("resources/read", { uri })) as McpResourceReadResult;
  }

  async listResourceTemplates(): Promise<McpResourceTemplate[]> {
    if (!this.resourceTemplates) {
      this.resourceTemplates = await this.sendPaginatedList<McpResourceTemplate>(
        "resources/templates/list",
        "resourceTemplates",
      );
    }
    return this.resourceTemplates;
  }

  async listPrompts(): Promise<McpPrompt[]> {
    if (!this.prompts) {
      this.prompts = await this.sendPaginatedList<McpPrompt>(
        "prompts/list",
        "prompts",
      );
    }
    return this.prompts;
  }

  async getPrompt(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<McpPromptGetResult> {
    return (await this.sendRequest("prompts/get", {
      name,
      ...(args && Object.keys(args).length ? { arguments: args } : {}),
    })) as McpPromptGetResult;
  }

  private async sendPaginatedList<T>(
    method: string,
    resultKey: string,
  ): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 50; page++) {
      const result = (await this.sendRequest(
        method,
        cursor ? { cursor } : undefined,
      )) as Record<string, unknown> | undefined;
      const pageItems = result?.[resultKey];
      if (Array.isArray(pageItems)) {
        items.push(...(pageItems as T[]));
      }

      const nextCursor = result?.nextCursor;
      if (typeof nextCursor !== "string" || !nextCursor) break;
      cursor = nextCursor;
    }

    return items;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = (await this.sendRequest("tools/call", {
      name,
      arguments: args,
    })) as { content?: Array<{ type: string; text?: string }> };

    if (!result?.content?.length) return "(empty result)";

    return result.content
      .map((c) => c.text || JSON.stringify(c))
      .join("\n");
  }

  dispose() {
    try {
      this.process.kill();
    } catch {}
    // Reject all pending requests so their timeouts get cleared
    for (const [, p] of this.pending) {
      p.reject(new Error(`MCP server ${this.config.name} disposed`));
    }
    this.pending.clear();
  }
}
