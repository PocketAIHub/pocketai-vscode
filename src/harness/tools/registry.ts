import * as path from "path";
import {
  clickBrowserElement,
  closeBrowserSession,
  navigateBrowser,
  screenshotBrowser,
  snapshotBrowser,
  typeIntoBrowser,
  type BrowserCdpOptions,
} from "../../browser-cdp";
import {
  TOOL_DEFINITIONS,
  type OpenAITool,
} from "../../tool-definitions";
import type { ToolCallType } from "../../types";
import type { ToolLoopDeps } from "../../tool-loop";
import { getSessionWorkspaceRoot } from "../../workspace-roots";
import {
  formatMcpPromptGet,
  formatMcpPromptList,
  formatMcpResourceList,
  formatMcpResourceRead,
  formatMcpResourceTemplateList,
} from "../../mcp-format";
import { classifyToolRisk } from "../policy";
import {
  formatHarnessSkillView,
  getHarnessSkillById,
  listHarnessSkills,
} from "../skills/registry";
import {
  findWorkspaceSkillRoots,
  installWorkspaceSkillFromPath,
  listManagedWorkspaceSkills,
  manageWorkspaceSkill,
  scanWorkspaceSkillCandidates,
  type ManagedWorkspaceSkill,
  type WorkspaceSkillCandidate,
  type WorkspaceSkillManageResult,
} from "../skills/workspace";
import { activateSessionSkill } from "../skills/active";
import { listBuiltinHarnessSkills } from "../skills/builtins";
import {
  executeEditFileTool,
  executeGitCommitTool,
  executeGitDiffTool,
  executeGitStatusTool,
  executeGlobTool,
  executeGrepTool,
  executeListFilesTool,
  executeMemoryDeleteTool,
  executeMemoryReadTool,
  executeMemoryWriteTool,
  executeReadFileTool,
  executeRunCommandTool,
  executeTodoWriteTool,
  executeWebFetchTool,
  executeWebSearchTool,
  executeWriteFileTool,
} from "./core";
import {
  executeApplyCodeActionTool,
  executeCodeActionsTool,
  executeDefinitionTool,
  executeDiagnosticsTool,
  executeDocumentSymbolsTool,
  executeHoverSymbolTool,
  executeIdeToolWithGuards,
  executeOpenFileTool,
  executeOpenDefinitionTool,
  executeWorkspaceSymbolsTool,
  executeReferencesTool,
} from "./ide";
import type {
  HarnessToolDescriptor,
  HarnessToolRegistry,
} from "../types";

function createBuiltinToolBehaviors(
  deps: ToolLoopDeps,
): Partial<
  Record<
    ToolCallType,
    Pick<
      HarnessToolDescriptor,
      "approvalPolicy" | "previewKind" | "execute"
    >
  >
> {
  return {
  list_tools: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ toolCall, registry }) => {
      const query = toolCall.query?.trim().toLowerCase() || "";
      const tools = registry.list().filter((tool) => {
        if (!query) return true;
        const haystack = `${tool.name} ${tool.description}`.toLowerCase();
        return haystack.includes(query);
      });

      if (tools.length === 0) {
        return query
          ? `No tools matched "${toolCall.query}".`
          : "No tools are currently available.";
      }

      const label = query
        ? `Available tools matching "${toolCall.query}" (${tools.length}):`
        : `Available tools (${tools.length}):`;
      return `${label}\n${tools
        .map(
          (tool) =>
            `- ${tool.name} [${tool.source}, ${tool.risk}, ${tool.approvalPolicy}, ${tool.previewKind}]: ${tool.description}`,
        )
        .join("\n")}`;
    },
  },
  list_skills: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ toolCall, registry }) => {
      const query = toolCall.query?.trim().toLowerCase() || "";
      const skills = registry.listSkills(query);

      if (skills.length === 0) {
        return query
          ? `No skills matched "${toolCall.query}".`
          : "No skills are currently available.";
      }

      const label = query
        ? `Available skills matching "${toolCall.query}" (${skills.length}):`
        : `Available skills (${skills.length}):`;
      return `${label}\n${skills
        .map((skill) => {
          const details: string[] = [skill.source];
          if (skill.source === "workspace" && skill.path) {
            details.push(skill.path);
          }
          if (skill.category) details.push(`category: ${skill.category}`);
          if (skill.tags?.length) {
            details.push(`tags: ${skill.tags.slice(0, 5).join(", ")}`);
          }
          if (skill.supportFiles?.length) {
            details.push(`${skill.supportFiles.length} support files`);
          }
          return `- ${skill.id} [${details.join(", ")}]: ${skill.description}`;
        })
        .join("\n")}`;
    },
  },
  run_skill: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall, registry }) => {
      const skillId = toolCall.skillName?.trim() || toolCall.query?.trim() || "";
      if (!skillId) {
        return "No skill name was provided. Use list_skills first to discover available skills.";
      }

      const skill = registry.getSkill(skillId);
      if (!skill) {
        return `Unknown skill "${skillId}". Use list_skills to discover available skills.`;
      }

      const extraPrompt = toolCall.skillPrompt?.trim();
      activateSessionSkill(session, skill, extraPrompt);
      const activeCount = session.activeSkills.length;
      return extraPrompt
        ? `Skill "${skill.name}" is now active for this request (${activeCount} active). Apply it to: ${extraPrompt}`
        : `Skill "${skill.name}" is now active for this request (${activeCount} active).`;
    },
  },
  skill_view: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ toolCall, registry }) => {
      const skillId = toolCall.skillName?.trim() || toolCall.query?.trim() || "";
      if (!skillId) {
        return "No skill name was provided. Use list_skills first to discover available skills.";
      }

      const skill = registry.getSkill(skillId);
      if (!skill) {
        return `Unknown skill "${skillId}". Use list_skills to discover available skills.`;
      }

      return formatHarnessSkillView(skill, toolCall.filePath);
    },
  },
  skill_scan: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) => {
      const workspaceRoot = getSessionWorkspaceRoot(session);
      if (!workspaceRoot) return "Error: No workspace folder open.";

      const requestedPath = toolCall.filePath?.trim() || toolCall.query?.trim();
      const scanPaths: string[] = [];
      if (requestedPath) {
        const resolved = resolveLocalSkillToolPath(requestedPath, workspaceRoot);
        if (!resolved.ok) return resolved.error;
        scanPaths.push(resolved.path);
      } else {
        scanPaths.push(...defaultSkillScanPaths(workspaceRoot));
      }

      const installedSkills = listManagedWorkspaceSkills([workspaceRoot])
        .map((skill) => ({ id: skill.id, path: skill.path }));
      const results = scanPaths.map((scanPath) =>
        scanWorkspaceSkillCandidates(scanPath, installedSkills),
      );

      return formatSkillScanResults(results);
    },
  },
  skill_install: {
    approvalPolicy: "mode-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) => {
      const workspaceRoot = getSessionWorkspaceRoot(session);
      if (!workspaceRoot) return "Error: No workspace folder open.";

      const sourcePath = toolCall.filePath?.trim() || toolCall.query?.trim() || "";
      if (!sourcePath) {
        return "No skill path was provided. Use skill_scan first to discover candidate paths.";
      }

      const resolved = resolveLocalSkillToolPath(sourcePath, workspaceRoot);
      if (!resolved.ok) return resolved.error;

      const result = installWorkspaceSkillFromPath({
        sourcePath: resolved.path,
        workspaceRoot,
        desiredId: toolCall.skillName,
      });
      if (!result.ok) return result.error;

      return [
        `Installed skill "${result.id}" at ${result.installedPath}.`,
        `Support files copied: ${result.supportFileCount}.`,
        result.skippedSymlinkCount > 0
          ? `Skipped symlinks: ${result.skippedSymlinkCount}.`
          : "",
      ].filter(Boolean).join("\n");
    },
  },
  skill_manage: {
    // Static tool policy covers both read-only list and marker-writing enable/disable.
    approvalPolicy: "mode-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) => {
      const workspaceRoot = getSessionWorkspaceRoot(session);
      if (!workspaceRoot) return "Error: No workspace folder open.";

      const action = normalizeSkillManageAction(
        toolCall.skillManageAction || toolCall.query || "list",
      );
      if (!action) {
        return `Unsupported skill_manage action "${toolCall.skillManageAction || toolCall.query || ""}". Supported actions: list, enable, disable.`;
      }

      const result = manageWorkspaceSkill({
        workspaceRoots: [workspaceRoot],
        action,
        skillId: toolCall.skillName,
        builtinSkillIds: listBuiltinHarnessSkills().map((skill) => skill.id),
      });

      return formatSkillManageResult(result);
    },
  },
  mcp_list_resources: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ toolCall }) => {
      if (!deps.mcpManager) return "No MCP manager is available.";
      try {
        const groups = await deps.mcpManager.listResources(
          toolCall.mcpServerName || undefined,
        );
        if (groups.length === 0) return "No MCP servers are connected.";
        return groups
          .map((group) =>
            formatMcpResourceList(group.serverName, group.resources),
          )
          .join("\n\n");
      } catch (error) {
        return `MCP resources error: ${(error as Error).message}`;
      }
    },
  },
  mcp_read_resource: {
    approvalPolicy: "mode-auto",
    previewKind: "none",
    execute: async ({ toolCall }) => {
      if (!deps.mcpManager) return "No MCP manager is available.";
      const serverName = toolCall.mcpServerName?.trim() || "";
      const uri = toolCall.mcpResourceUri?.trim() || "";
      if (!serverName || !uri) {
        return "mcp_read_resource requires both server and uri.";
      }
      try {
        const result = await deps.mcpManager.readResource(serverName, uri);
        return formatMcpResourceRead(serverName, uri, result);
      } catch (error) {
        return `MCP resource read error: ${(error as Error).message}`;
      }
    },
  },
  mcp_list_resource_templates: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ toolCall }) => {
      if (!deps.mcpManager) return "No MCP manager is available.";
      try {
        const groups = await deps.mcpManager.listResourceTemplates(
          toolCall.mcpServerName || undefined,
        );
        if (groups.length === 0) return "No MCP servers are connected.";
        return groups
          .map((group) =>
            formatMcpResourceTemplateList(group.serverName, group.templates),
          )
          .join("\n\n");
      } catch (error) {
        return `MCP resource templates error: ${(error as Error).message}`;
      }
    },
  },
  mcp_list_prompts: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ toolCall }) => {
      if (!deps.mcpManager) return "No MCP manager is available.";
      try {
        const groups = await deps.mcpManager.listPrompts(
          toolCall.mcpServerName || undefined,
        );
        if (groups.length === 0) return "No MCP servers are connected.";
        return groups
          .map((group) => formatMcpPromptList(group.serverName, group.prompts))
          .join("\n\n");
      } catch (error) {
        return `MCP prompts error: ${(error as Error).message}`;
      }
    },
  },
  mcp_get_prompt: {
    approvalPolicy: "mode-auto",
    previewKind: "none",
    execute: async ({ toolCall }) => {
      if (!deps.mcpManager) return "No MCP manager is available.";
      const serverName = toolCall.mcpServerName?.trim() || "";
      const promptName = toolCall.mcpPromptName?.trim() || "";
      if (!serverName || !promptName) {
        return "mcp_get_prompt requires both server and name.";
      }
      try {
        const result = await deps.mcpManager.getPrompt(
          serverName,
          promptName,
          toolCall.mcpArguments,
        );
        return formatMcpPromptGet(serverName, promptName, result);
      } catch (error) {
        return `MCP prompt error: ${(error as Error).message}`;
      }
    },
  },
  diagnostics: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeIdeToolWithGuards(deps, session, toolCall, () =>
        executeDiagnosticsTool(toolCall, session),
      ),
  },
  open_file: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeIdeToolWithGuards(deps, session, toolCall, () =>
        executeOpenFileTool(toolCall, session),
      ),
  },
  open_definition: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeIdeToolWithGuards(deps, session, toolCall, () =>
        executeOpenDefinitionTool(toolCall, session),
      ),
  },
  workspace_symbols: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeIdeToolWithGuards(deps, session, toolCall, () =>
        executeWorkspaceSymbolsTool(toolCall),
      ),
  },
  hover_symbol: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeIdeToolWithGuards(deps, session, toolCall, () =>
        executeHoverSymbolTool(toolCall, session),
      ),
  },
  code_actions: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeIdeToolWithGuards(deps, session, toolCall, () =>
        executeCodeActionsTool(toolCall, session),
      ),
  },
  apply_code_action: {
    approvalPolicy: "mode-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeIdeToolWithGuards(deps, session, toolCall, () =>
        executeApplyCodeActionTool(toolCall, session),
      ),
  },
  go_to_definition: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeIdeToolWithGuards(deps, session, toolCall, () =>
        executeDefinitionTool(toolCall, session),
      ),
  },
  find_references: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeIdeToolWithGuards(deps, session, toolCall, () =>
        executeReferencesTool(toolCall, session),
      ),
  },
  document_symbols: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeIdeToolWithGuards(deps, session, toolCall, () =>
        executeDocumentSymbolsTool(toolCall, session),
      ),
  },
  read_file: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeReadFileTool(deps, session, toolCall),
  },
  web_search: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeWebSearchTool(deps, session, toolCall),
  },
  web_fetch: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeWebFetchTool(deps, session, toolCall),
  },
  browser_navigate: {
    approvalPolicy: "mode-auto",
    previewKind: "none",
    execute: async ({ toolCall }) =>
      navigateBrowser(
        toolCall.browserUrl || toolCall.url || "",
        getBrowserCdpOptions(deps),
      ),
  },
  browser_snapshot: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ toolCall }) =>
      snapshotBrowser({
        ...getBrowserCdpOptions(deps),
        maxBodyChars: toolCall.browserMaxBodyChars,
        maxElements: toolCall.browserMaxElements,
      }),
  },
  browser_click: {
    approvalPolicy: "mode-auto",
    previewKind: "none",
    execute: async ({ toolCall }) =>
      clickBrowserElement(
        toolCall.browserRef || "",
        getBrowserCdpOptions(deps),
      ),
  },
  browser_type: {
    approvalPolicy: "mode-auto",
    previewKind: "none",
    execute: async ({ toolCall }) =>
      typeIntoBrowser(
        toolCall.browserText || "",
        toolCall.browserRef || "",
        getBrowserCdpOptions(deps),
      ),
  },
  browser_screenshot: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ toolCall }) =>
      screenshotBrowser({
        ...getBrowserCdpOptions(deps),
        fullPage: toolCall.browserFullPage,
      }),
  },
  browser_close: {
    approvalPolicy: "mode-auto",
    previewKind: "none",
    execute: async () => closeBrowserSession(),
  },
  list_files: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeListFilesTool(deps, session, toolCall),
  },
  grep: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeGrepTool(deps, session, toolCall),
  },
  glob: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeGlobTool(deps, session, toolCall),
  },
  git_status: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeGitStatusTool(deps, session, toolCall),
  },
  git_diff: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeGitDiffTool(deps, session, toolCall),
  },
  todo_write: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeTodoWriteTool(deps, session, toolCall),
  },
  task: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) => {
      const { executeTaskTool } = await import("../subagents");
      return executeTaskTool(deps, session, toolCall);
    },
  },
  memory_read: {
    approvalPolicy: "always-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeMemoryReadTool(deps, session, toolCall),
  },
  memory_write: {
    approvalPolicy: "always-ask",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeMemoryWriteTool(deps, session, toolCall),
  },
  memory_delete: {
    approvalPolicy: "always-ask",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeMemoryDeleteTool(deps, session, toolCall),
  },
  edit_file: {
    approvalPolicy: "mode-auto",
    previewKind: "inline-diff",
    execute: async ({ session, toolCall }) =>
      executeEditFileTool(deps, session, toolCall),
  },
  write_file: {
    approvalPolicy: "mode-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeWriteFileTool(deps, session, toolCall),
  },
  run_command: {
    approvalPolicy: "mode-auto",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeRunCommandTool(deps, session, toolCall),
  },
  git_commit: {
    approvalPolicy: "always-ask",
    previewKind: "none",
    execute: async ({ session, toolCall }) =>
      executeGitCommitTool(deps, session, toolCall),
  },
  };
}

function getBrowserCdpOptions(deps: ToolLoopDeps): BrowserCdpOptions {
  return {
    cdpEndpoint: deps.config.get<string>("browserCdpEndpoint") || "",
    executablePath: deps.config.get<string>("browserExecutablePath") || "",
    headless: deps.config.get<boolean>("browserHeadless", false),
  };
}

function resolveLocalSkillToolPath(
  inputPath: string,
  workspaceRoot: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    return { ok: false, error: "No skill path was provided." };
  }
  if (trimmed.includes("\0")) {
    return { ok: false, error: "Rejected skill path containing a null byte." };
  }

  if (path.isAbsolute(trimmed)) {
    return { ok: true, path: path.resolve(trimmed) };
  }

  const normalized = trimmed.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    return {
      ok: false,
      error: `Rejected relative skill path with traversal: ${inputPath}`,
    };
  }

  return { ok: true, path: path.resolve(workspaceRoot, trimmed) };
}

function defaultSkillScanPaths(workspaceRoot: string): string[] {
  const seen = new Set<string>();
  const paths = [workspaceRoot, ...findWorkspaceSkillRoots([workspaceRoot])];
  return paths.filter((candidate) => {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

function formatSkillScanResults(
  results: ReturnType<typeof scanWorkspaceSkillCandidates>[],
): string {
  if (results.length === 0) return "No skill scan paths were available.";

  const sections = results.map((result) => {
    if (!result.ok) {
      return `Skill scan failed for ${result.scanPath}: ${result.error}`;
    }

    if (result.candidates.length === 0) {
      return `No skill candidates found under ${result.scanPath}.`;
    }

    return [
      `Skill candidates under ${result.scanPath} (${result.candidates.length}):`,
      ...result.candidates.map(formatSkillCandidateLine),
    ].join("\n");
  });

  return sections.join("\n\n");
}

function formatSkillCandidateLine(candidate: WorkspaceSkillCandidate): string {
  const details = [
    `source: ${candidate.sourcePath}`,
    `support files: ${candidate.supportFileCount}`,
    candidate.category ? `category: ${candidate.category}` : "",
    candidate.tags?.length ? `tags: ${candidate.tags.join(", ")}` : "",
    candidate.conflict === "installed"
      ? `conflict: installed${candidate.conflictPath ? ` at ${candidate.conflictPath}` : ""}`
      : "conflict: none",
  ].filter(Boolean);

  return `- ${candidate.id} (${candidate.name}) [${details.join("; ")}]: ${candidate.description}`;
}

function normalizeSkillManageAction(
  value: string,
): "list" | "enable" | "disable" | undefined {
  const action = value.trim().toLowerCase().split(/\s+/)[0] || "list";
  if (action === "list" || action === "enable" || action === "disable") {
    return action;
  }
  return undefined;
}

function formatSkillManageResult(result: WorkspaceSkillManageResult): string {
  if (!result.ok) return result.error;

  if (result.action === "list") {
    if (result.skills.length === 0) {
      return "No installed project skills were found.";
    }

    return [
      `Installed project skills (${result.skills.length}):`,
      ...result.skills.map(formatManagedSkillLine),
    ].join("\n");
  }

  const verb = result.action === "disable" ? "disabled" : "enabled";
  const state = result.changed ? verb : `already ${verb}`;
  return `Skill "${result.skill.id}" is ${state}. Marker: ${result.markerPath}`;
}

function formatManagedSkillLine(skill: ManagedWorkspaceSkill): string {
  const details = [
    `status: ${skill.status}`,
    `path: ${skill.path}`,
    `support files: ${skill.supportFileCount}`,
    skill.category ? `category: ${skill.category}` : "",
    skill.tags?.length ? `tags: ${skill.tags.join(", ")}` : "",
    skill.markerError ? `marker error: ${skill.markerError}` : "",
  ].filter(Boolean);

  return `- ${skill.id} (${skill.name}) [${details.join("; ")}]: ${skill.description}`;
}

function toBuiltinDescriptor(
  tool: OpenAITool,
  behaviors: Partial<
    Record<
      ToolCallType,
      Pick<
        HarnessToolDescriptor,
        "approvalPolicy" | "previewKind" | "execute"
      >
    >
  >,
): HarnessToolDescriptor {
  const behavior = behaviors[tool.function.name as ToolCallType] ?? {
      approvalPolicy: "mode-auto" as const,
      previewKind: "none" as const,
    };
  return {
    name: tool.function.name,
    description: tool.function.description,
    risk: classifyToolRisk(tool.function.name),
    source: "builtin",
    definition: tool,
    approvalPolicy: behavior.approvalPolicy,
    previewKind: behavior.previewKind,
    execute: behavior.execute,
  };
}

function toMcpDescriptor(tool: OpenAITool): HarnessToolDescriptor {
  return {
    name: tool.function.name,
    description: tool.function.description,
    risk: classifyToolRisk(tool.function.name, true),
    source: "mcp",
    definition: tool,
    approvalPolicy: "mode-auto",
    previewKind: "none",
  };
}

export function createHarnessToolRegistry(
  deps: ToolLoopDeps,
): HarnessToolRegistry {
  const mcpManager = deps.mcpManager;
  const builtinToolBehaviors = createBuiltinToolBehaviors(deps);
  const builtinToolDescriptors = TOOL_DEFINITIONS.map((tool) =>
    toBuiltinDescriptor(tool, builtinToolBehaviors),
  );
  const builtinToolDescriptorMap = new Map(
    builtinToolDescriptors.map((tool) => [tool.name, tool]),
  );

  return {
    list() {
      const mcpTools = (mcpManager?.getToolDefinitions() ?? []).map(
        toMcpDescriptor,
      );
      return [...builtinToolDescriptors, ...mcpTools];
    },

    getToolDescriptor(toolName: string) {
      if (mcpManager?.isMcpTool(toolName)) {
        const tool = (mcpManager.getToolDefinitions() ?? []).find(
          (candidate) => candidate.function.name === toolName,
        );
        return tool ? toMcpDescriptor(tool) : undefined;
      }

      return builtinToolDescriptorMap.get(toolName);
    },

    isMcpTool(toolName: string) {
      return mcpManager?.isMcpTool(toolName) ?? false;
    },

    getStructuredToolDefinitions() {
      const extraTools = mcpManager?.getToolDefinitions() ?? [];
      return extraTools.length
        ? [...TOOL_DEFINITIONS, ...extraTools]
        : TOOL_DEFINITIONS;
    },

    listSkills(query) {
      const normalizedQuery = query?.trim().toLowerCase() || "";
      return listHarnessSkills().filter((skill) => {
        if (!normalizedQuery) return true;
        const haystack =
          `${skill.id} ${skill.name} ${skill.description} ${
            skill.category || ""
          } ${skill.tags?.join(" ") || ""} ${
            skill.relatedSkills?.join(" ") || ""
          }`.toLowerCase();
        return haystack.includes(normalizedQuery);
      });
    },

    getSkill(skillId) {
      return getHarnessSkillById(skillId);
    },
  };
}
