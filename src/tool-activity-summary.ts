import type {
  AssistantToolActionSummary,
  AssistantToolActionSummaryItem,
  ToolCall,
} from "./types";

const MAX_SUMMARY_ACTIONS = 3;

type ToolActionKind =
  | "read"
  | "edit"
  | "search"
  | "fetch"
  | "run"
  | "inspect"
  | "find"
  | "git"
  | "todo"
  | "subagent"
  | "memory"
  | "skill"
  | "tool";

type ToolActionDescription = AssistantToolActionSummaryItem & {
  kind: ToolActionKind;
  priority: number;
};

export function compactToolActivityPath(value: string): {
  primary: string;
  secondary: string;
} {
  const normalized = String(value || "").replace(/\\/g, "/").trim();
  if (!normalized) {
    return { primary: "", secondary: "" };
  }
  const pieces = normalized.split("/").filter(Boolean);
  const primary = pieces[pieces.length - 1] || normalized;
  return {
    primary,
    secondary: primary !== normalized ? normalized : "",
  };
}

export function buildAssistantToolActionSummary(
  toolCalls: ToolCall[],
): AssistantToolActionSummary {
  const actions = (toolCalls || []).map(describeToolAction);
  const primary = pickPrimaryAction(actions);
  const label = buildSummaryLabel(primary, actions);
  const detail = buildSummaryDetail(actions);
  const meta = buildSummaryMeta(actions);

  return {
    kind: "tool_action",
    label,
    detail,
    meta,
    toolCount: actions.length,
    actions: actions.map(({ priority: _priority, ...action }) => action),
  };
}

export function formatAssistantToolActionContent(
  summary: AssistantToolActionSummary,
): string {
  const detail = summary.detail ? ` - ${summary.detail}` : "";
  return `[PocketAI action: ${summary.label}${detail}]`;
}

export function isAssistantToolActionPlaceholder(content: string): boolean {
  return /^\[(?:PocketAI action:|Calling tools?:)[\s\S]*\]$/i.test(
    String(content || "").trim(),
  );
}

function describeToolAction(toolCall: ToolCall): ToolActionDescription {
  const fileTarget = compactToolActivityPath(toolCall.filePath || "");
  const fallbackTarget =
    fileTarget.primary ||
    toolCall.query ||
    toolCall.command ||
    toolCall.url ||
    toolCall.skillName ||
    toolCall.memoryName ||
    toolCall.memoryType ||
    "";

  switch (toolCall.type) {
    case "read_file":
      return action(toolCall, "read", "Reading", fileTarget.primary || "file", fileTarget.secondary, 45);
    case "open_file":
      return action(toolCall, "read", "Opening", fileTarget.primary || "file", fileTarget.secondary, 44);
    case "edit_file":
    case "write_file":
      return action(toolCall, "edit", "Preparing edit", fileTarget.primary || "file", fileTarget.secondary, 100);
    case "apply_code_action":
      return action(
        toolCall,
        "edit",
        "Applying fix",
        toolCall.actionTitle || fileTarget.primary || "code action",
        fileTarget.secondary,
        95,
      );
    case "run_command":
      return action(
        toolCall,
        "run",
        "Running command",
        toolCall.command || "command",
        toolCall.description || "",
        90,
      );
    case "web_search":
      return action(toolCall, "search", "Searching web", toolCall.query || "web", "", 70);
    case "web_fetch":
      return action(toolCall, "fetch", "Fetching page", compactUrl(toolCall.url || "") || "page", toolCall.url || "", 68);
    case "grep":
      return action(toolCall, "search", "Searching code", toolCall.pattern || "code", toolCall.glob || fileTarget.secondary, 65);
    case "workspace_symbols":
      return action(toolCall, "search", "Searching symbols", toolCall.query || "workspace", "", 62);
    case "find_references":
      return action(toolCall, "search", "Finding references", fileTarget.primary || toolCall.query || "symbol", fileTarget.secondary, 61);
    case "glob":
      return action(toolCall, "find", "Finding files", toolCall.glob || "files", toolCall.globPath || "", 58);
    case "list_files":
      return action(toolCall, "find", "Listing files", toolCall.glob || toolCall.globPath || "workspace", "", 57);
    case "diagnostics":
      return action(toolCall, "inspect", "Checking diagnostics", fileTarget.primary || "workspace", fileTarget.secondary, 55);
    case "code_actions":
      return action(toolCall, "inspect", "Checking fixes", fileTarget.primary || "current file", fileTarget.secondary, 54);
    case "hover_symbol":
      return action(toolCall, "inspect", "Inspecting symbol", fileTarget.primary || toolCall.query || "symbol", fileTarget.secondary, 53);
    case "open_definition":
    case "go_to_definition":
      return action(toolCall, "inspect", "Resolving definition", fileTarget.primary || "symbol", fileTarget.secondary, 52);
    case "document_symbols":
      return action(toolCall, "inspect", "Inspecting symbols", fileTarget.primary || "document", fileTarget.secondary, 51);
    case "git_status":
      return action(toolCall, "git", "Checking git status", "repository", "", 48);
    case "git_diff":
      return action(toolCall, "git", "Reviewing diff", "repository", "", 49);
    case "git_commit":
      return action(toolCall, "git", "Committing changes", toolCall.commitMessage || "changes", "", 88);
    case "todo_write":
      return action(
        toolCall,
        "todo",
        "Updating tasks",
        `${toolCall.todos?.length || 0} task${toolCall.todos?.length === 1 ? "" : "s"}`,
        "",
        50,
      );
    case "task":
      return action(
        toolCall,
        "subagent",
        "Starting subagent",
        toolCall.subagentName || "subagent",
        truncateSentence(toolCall.taskPrompt || "", 120),
        80,
      );
    case "list_tools":
      return action(toolCall, "tool", "Inspecting tools", "tool registry", "", 38);
    case "list_skills":
      return action(toolCall, "skill", "Inspecting skills", "skill registry", "", 39);
    case "run_skill":
      return action(toolCall, "skill", "Using skill", toolCall.skillName || "skill", "", 76);
    case "memory_read":
      return action(toolCall, "memory", "Reading memory", toolCall.memoryQuery || toolCall.memoryType || "memory", "", 42);
    case "memory_write":
      return action(toolCall, "memory", "Writing memory", toolCall.memoryName || toolCall.memoryType || "memory", "", 74);
    case "memory_delete":
      return action(toolCall, "memory", "Deleting memory", toolCall.memoryName || "memory", "", 73);
    default:
      return action(
        toolCall,
        "tool",
        formatToolName(toolCall.type),
        fallbackTarget || "tool",
        fileTarget.secondary,
        20,
      );
  }
}

function action(
  toolCall: ToolCall,
  kind: ToolActionKind,
  label: string,
  target: string,
  detail: string | undefined,
  priority: number,
): ToolActionDescription {
  return {
    toolCallId: toolCall.id,
    toolType: toolCall.type,
    kind,
    label,
    target: truncateSentence(target, 120),
    detail: detail ? truncateSentence(detail, 180) : undefined,
    priority,
  };
}

function pickPrimaryAction(
  actions: ToolActionDescription[],
): ToolActionDescription | undefined {
  return [...actions].sort((a, b) => b.priority - a.priority)[0];
}

function buildSummaryLabel(
  primary: ToolActionDescription | undefined,
  actions: ToolActionDescription[],
): string {
  if (!primary) return "Using tools";
  if (actions.length === 1) return primary.label;

  const kinds = new Set(actions.map((item) => item.kind));
  if (kinds.size === 1) {
    switch (primary.kind) {
      case "read":
        return "Reading files";
      case "edit":
        return "Preparing edits";
      case "search":
        return "Searching";
      case "fetch":
        return "Fetching pages";
      case "run":
        return "Running commands";
      case "inspect":
        return "Inspecting code";
      case "find":
        return "Finding files";
      case "git":
        return "Checking git";
      case "todo":
        return "Updating tasks";
      case "subagent":
        return "Starting subagents";
      case "memory":
        return "Using memory";
      case "skill":
        return "Using skills";
      default:
        return "Using tools";
    }
  }

  if (kinds.has("edit")) return "Preparing changes";
  if (kinds.has("run")) return "Running checks";
  if (kinds.has("search")) return "Searching context";
  if (kinds.has("read")) return "Reading context";
  return "Using tools";
}

function buildSummaryDetail(actions: ToolActionDescription[]): string {
  if (!actions.length) return "Preparing the next step.";
  if (actions.length === 1) {
    return actions[0].target || actions[0].detail || "Preparing the next step.";
  }

  const visible = actions.slice(0, MAX_SUMMARY_ACTIONS);
  const parts = visible.map((item) =>
    [item.label, item.target].filter(Boolean).join(" "),
  );
  const remaining = actions.length - visible.length;
  if (remaining > 0) {
    parts.push(`${remaining} more`);
  }
  return parts.join(", ");
}

function buildSummaryMeta(actions: ToolActionDescription[]): string | undefined {
  if (!actions.length) return undefined;
  if (actions.length === 1) {
    const action = actions[0];
    return action.detail && action.detail !== action.target
      ? action.detail
      : defaultMetaForKind(action.kind);
  }

  const kinds = new Set(actions.map((item) => item.kind));
  if (kinds.size === 1) {
    const first = actions[0];
    return `${actions.length} ${first.kind === "run" ? "commands" : "tool calls"} queued.`;
  }
  return `${actions.length} tool calls queued.`;
}

function defaultMetaForKind(kind: ToolActionKind): string {
  switch (kind) {
    case "read":
      return "Inspecting context before continuing.";
    case "edit":
      return "Preparing a workspace change.";
    case "search":
      return "Looking for the right evidence.";
    case "fetch":
      return "Loading external context.";
    case "run":
      return "Executing in the workspace.";
    case "inspect":
      return "Checking editor context.";
    case "find":
      return "Scanning workspace paths.";
    case "git":
      return "Reviewing repository state.";
    case "todo":
      return "Refreshing the visible task list.";
    case "subagent":
      return "Delegating a bounded task.";
    case "memory":
      return "Using saved project memory.";
    case "skill":
      return "Preparing skill-guided context.";
    default:
      return "Gathering context before continuing.";
  }
}

function compactUrl(value: string): string {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(text);
    const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
    return `${parsed.host}${path}`;
  } catch {
    return text;
  }
}

function formatToolName(value: string): string {
  return String(value || "tool")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function truncateSentence(value: string, maxLength: number): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
