import type {
  ChatSession,
  HarnessBackgroundTask,
  HarnessChangeSet,
  HarnessChangeSetStatus,
  HarnessPendingApproval,
  HarnessPendingDiff,
  HarnessSubagentTask,
  HarnessTodoItem,
  HarnessToolTimelineItem,
  HarnessToolTimelineStatus,
  ToolCall,
} from "../types";
import { classifyShellCommandRisk } from "./policy";
import type { HarnessEvent } from "./types";

const MAX_BACKGROUND_TASKS = 20;
const MAX_SUBAGENT_TASKS = 10;
const MAX_DIFF_ARTIFACTS = 20;
const MAX_CHANGE_SETS = 20;
const MAX_TOOL_TIMELINE_ITEMS = 40;
const TOOL_TIMELINE_PREVIEW_LIMIT = 600;

export function createEmptyHarnessSessionState() {
  return {
    pendingApprovals: [],
    pendingDiffs: [],
    changeSets: [],
    todoItems: [],
    toolTimeline: [],
    backgroundTasks: [],
    subagentTasks: [],
  };
}

export function applyHarnessEventToSession(
  session: ChatSession,
  event: HarnessEvent,
) {
  switch (event.type) {
    case "turn_started":
      session.harnessState.pendingApprovals = [];
      markPendingDiffsStale(session);
      markPendingChangeSetsStale(session);
      return;
    case "tool_calls_detected":
      syncToolTimelineFromTranscript(session);
      return;
    case "tool_call_pending_approval":
      if (!event.toolCallId) return;
      const pendingToolCall = findToolCall(session, event.toolCallId);
      upsertToolTimelineItem(
        session,
        buildToolTimelineItem(pendingToolCall, {
          toolCallId: event.toolCallId,
          toolType: event.detail || pendingToolCall?.type || "tool",
          status: "pending_approval",
          now: Date.now(),
        }),
      );
      upsertPendingApproval(session, {
        toolCallId: event.toolCallId,
        toolType: event.detail || "tool",
        filePath: pendingToolCall?.filePath || "",
        ...buildPendingApprovalCommandRisk(pendingToolCall),
      });
      return;
    case "change_set_ready":
      if (!event.detail) return;
      upsertChangeSet(session, parseChangeSetEventDetail(event.detail));
      return;
    case "diff_ready":
      if (!event.toolCallId || !event.detail) return;
      const toolCall = findToolCall(session, event.toolCallId);
      upsertPendingDiff(session, {
        id: `diff:${event.toolCallId}`,
        changeSetId: findChangeSetIdForToolCall(session, event.toolCallId),
        toolCallId: event.toolCallId,
        filePath: event.detail,
        status: "pending",
        previewKind: "inline-diff",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return;
    case "tool_call_started": {
      if (!event.toolCallId) return;
      const toolCall = findToolCall(session, event.toolCallId);
      upsertToolTimelineItem(
        session,
        buildToolTimelineItem(toolCall, {
          toolCallId: event.toolCallId,
          toolType: event.detail || toolCall?.type || "tool",
          status: "running",
          now: Date.now(),
        }),
      );
      clearPendingToolApproval(session, event.toolCallId);
      return;
    }
    case "tool_call_completed": {
      if (!event.toolCallId) return;
      const toolCall = findToolCall(session, event.toolCallId);
      upsertToolTimelineItem(
        session,
        buildToolTimelineItem(toolCall, {
          toolCallId: event.toolCallId,
          toolType: event.detail || toolCall?.type || "tool",
          status: "succeeded",
          now: Date.now(),
        }),
      );
      clearPendingToolApproval(session, event.toolCallId);
      return;
    }
    case "tool_call_failed": {
      if (!event.toolCallId) return;
      const toolCall = findToolCall(session, event.toolCallId);
      upsertToolTimelineItem(
        session,
        buildToolTimelineItem(toolCall, {
          toolCallId: event.toolCallId,
          toolType: toolCall?.type || "tool",
          status: "failed",
          resultPreview: event.detail,
          now: Date.now(),
        }),
      );
      clearPendingToolApproval(session, event.toolCallId);
      return;
    }
    case "turn_completed":
    case "turn_failed":
      session.harnessState.pendingApprovals = [];
      return;
    default:
      return;
  }
}

export function syncHarnessPendingState(session: ChatSession) {
  const pendingApprovals: HarnessPendingApproval[] = [];
  const pendingDiffs: HarnessPendingDiff[] = [];

  for (const entry of session.transcript) {
    if (!entry.toolCalls?.length) continue;
    for (const toolCall of entry.toolCalls) {
      if (toolCall.status !== "pending") continue;
      pendingApprovals.push({
        toolCallId: toolCall.id,
        toolType: toolCall.type,
        filePath: toolCall.filePath,
        ...buildPendingApprovalCommandRisk(toolCall),
      });
      if (toolCall.type === "edit_file" && toolCall.filePath) {
        pendingDiffs.push({
          id: `diff:${toolCall.id}`,
          toolCallId: toolCall.id,
          filePath: toolCall.filePath,
          status: "pending",
          previewKind: "inline-diff",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    }
  }

  session.harnessState.pendingApprovals = dedupeByToolCallId(pendingApprovals);
  session.harnessState.changeSets = buildPendingChangeSetsFromApprovals(
    session.harnessState.pendingApprovals,
  );
  session.harnessState.pendingDiffs = dedupeByToolCallId(pendingDiffs).map((diff) => ({
    ...diff,
    changeSetId: findChangeSetIdForToolCall(session, diff.toolCallId),
  }));
  session.harnessState.todoItems = extractTodoItems(session);
  syncToolTimelineFromTranscript(session);
}

export function syncHarnessToolTimeline(session: ChatSession) {
  syncToolTimelineFromTranscript(session);
}

function syncToolTimelineFromTranscript(session: ChatSession) {
  for (const entry of session.transcript) {
    if (!entry.toolCalls?.length) continue;
    for (const toolCall of entry.toolCalls) {
      upsertToolTimelineItem(
        session,
        buildToolTimelineItem(toolCall, {
          status: resolveToolTimelineStatus(toolCall),
          now: Date.now(),
        }),
      );
    }
  }
}

function buildToolTimelineItem(
  toolCall: ToolCall | undefined,
  options: {
    toolCallId?: string;
    toolType?: string;
    status: HarnessToolTimelineStatus;
    resultPreview?: string;
    now: number;
  },
): HarnessToolTimelineItem {
  const toolCallId =
    options.toolCallId ||
    toolCall?.id ||
    `tool:${options.now.toString(36)}`;
  const toolType = options.toolType || toolCall?.type || "tool";
  const descriptor = describeTimelineTool(toolCall, toolType);
  const resultPreview =
    options.resultPreview ?? buildToolResultPreview(toolCall?.result ?? "");

  return {
    id: toolCallId,
    toolCallId,
    toolType,
    label: descriptor.label,
    target: descriptor.target,
    status: options.status,
    filePath: toolCall?.filePath || undefined,
    command: toolCall?.command || undefined,
    url: toolCall?.url || undefined,
    query: toolCall?.query || toolCall?.pattern || undefined,
    resultPreview: resultPreview || undefined,
    commandRisk:
      toolCall?.type === "run_command"
        ? classifyShellCommandRisk(toolCall.command || "")
        : undefined,
    createdAt: options.now,
    updatedAt: options.now,
  };
}

function upsertToolTimelineItem(
  session: ChatSession,
  item: HarnessToolTimelineItem,
) {
  const currentTimeline = session.harnessState.toolTimeline ?? [];
  const previous = currentTimeline.find(
    (timelineItem) => timelineItem.toolCallId === item.toolCallId,
  );
  const startedAt =
    item.status === "running"
      ? previous?.startedAt ?? item.updatedAt
      : previous?.startedAt;
  const completedAt =
    isTerminalTimelineStatus(item.status)
      ? previous?.completedAt ?? item.updatedAt
      : previous?.completedAt;

  const merged: HarnessToolTimelineItem = {
    ...previous,
    ...item,
    createdAt: previous?.createdAt ?? item.createdAt,
    startedAt,
    completedAt,
  };

  const withoutCurrent = currentTimeline.filter(
    (timelineItem) => timelineItem.toolCallId !== item.toolCallId,
  );
  session.harnessState.toolTimeline = [merged, ...withoutCurrent]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_TOOL_TIMELINE_ITEMS);
}

function isTerminalTimelineStatus(status: HarnessToolTimelineStatus) {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "rejected" ||
    status === "stale"
  );
}

function resolveToolTimelineStatus(
  toolCall: ToolCall,
): HarnessToolTimelineStatus {
  if (toolCall.status === "pending") return "pending_approval";
  if (toolCall.status === "approved") return "running";
  if (toolCall.status === "rejected") return "rejected";
  if (toolCall.status === "error") {
    return /^Edit became stale/i.test(toolCall.result || "") ? "stale" : "failed";
  }
  if (toolCall.status === "executed") {
    return looksLikeFailedToolResult(toolCall.result || "")
      ? "failed"
      : "succeeded";
  }
  return "detected";
}

export function looksLikeFailedToolResult(result: string): boolean {
  return /^(?:Tool execution error|Command failed|Error:|Blocked by permission rule)/i.test(
    result.trim(),
  );
}

function buildToolResultPreview(result: string): string {
  const text = result.trim();
  if (!text) return "";
  const compacted = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  if (compacted.length <= TOOL_TIMELINE_PREVIEW_LIMIT) return compacted;
  return `${compacted.slice(0, TOOL_TIMELINE_PREVIEW_LIMIT - 1).trimEnd()}…`;
}

function describeTimelineTool(
  toolCall: ToolCall | undefined,
  toolType: string,
): { label: string; target: string } {
  const fileTarget = compactPath(toolCall?.filePath || "");
  switch (toolType) {
    case "read_file":
      return { label: "Read", target: fileTarget || "file" };
    case "edit_file":
      return { label: "Edit", target: fileTarget || "file" };
    case "write_file":
      return { label: "Write", target: fileTarget || "file" };
    case "open_file":
      return { label: "Open", target: fileTarget || "file" };
    case "open_definition":
    case "go_to_definition":
      return { label: "Open definition", target: fileTarget || "symbol" };
    case "find_references":
      return { label: "Find references", target: fileTarget || "symbol" };
    case "document_symbols":
      return { label: "Inspect symbols", target: fileTarget || "document" };
    case "workspace_symbols":
      return { label: "Search symbols", target: toolCall?.query || "workspace" };
    case "hover_symbol":
      return { label: "Inspect symbol", target: fileTarget || "symbol" };
    case "code_actions":
      return { label: "Check fixes", target: fileTarget || "current file" };
    case "apply_code_action":
      return {
        label: "Apply fix",
        target: toolCall?.actionTitle || fileTarget || "code action",
      };
    case "diagnostics":
      return { label: "Check diagnostics", target: fileTarget || "workspace" };
    case "web_search":
      return { label: "Search web", target: toolCall?.query || "query" };
    case "web_fetch":
      return { label: "Fetch", target: compactUrl(toolCall?.url || "") || "page" };
    case "run_command":
      return { label: "Run", target: toolCall?.command || "command" };
    case "grep":
      return { label: "Search code", target: toolCall?.pattern || "pattern" };
    case "glob":
      return { label: "Find files", target: toolCall?.glob || "files" };
    case "list_files":
      return { label: "List files", target: fileTarget || "workspace" };
    case "git_status":
      return { label: "Git status", target: "repository" };
    case "git_diff":
      return { label: "Git diff", target: "repository" };
    case "git_commit":
      return { label: "Commit", target: toolCall?.commitMessage || "changes" };
    case "todo_write":
      return { label: "Update plan", target: "task list" };
    case "task":
      return { label: "Delegate", target: toolCall?.taskPrompt || "subagent task" };
    case "list_tools":
      return { label: "List tools", target: toolCall?.query || "registry" };
    case "list_skills":
      return { label: "List skills", target: toolCall?.query || "registry" };
    case "run_skill":
      return { label: "Run skill", target: toolCall?.skillName || "skill" };
    case "memory_read":
      return { label: "Read memory", target: toolCall?.memoryQuery || toolCall?.memoryType || "memory" };
    case "memory_write":
      return { label: "Write memory", target: toolCall?.memoryName || toolCall?.memoryType || "memory" };
    case "memory_delete":
      return { label: "Delete memory", target: toolCall?.memoryName || "memory" };
    default:
      return {
        label: toolType.replace(/_/g, " "),
        target:
          fileTarget ||
          toolCall?.query ||
          toolCall?.command ||
          toolCall?.url ||
          "",
      };
  }
}

function compactPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function compactUrl(value: string): string {
  const text = value.trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    return url.pathname && url.pathname !== "/"
      ? `${url.host}${url.pathname}`
      : url.host;
  } catch {
    return text;
  }
}

function buildPendingApprovalCommandRisk(
  toolCall: ToolCall | undefined,
): Pick<HarnessPendingApproval, "commandRisk"> | Record<string, never> {
  if (toolCall?.type !== "run_command") return {};
  return {
    commandRisk: classifyShellCommandRisk(toolCall.command || ""),
  };
}

export function clearPendingToolState(
  session: ChatSession,
  toolCallId: string,
) {
  clearPendingToolApproval(session, toolCallId);
  const diff = session.harnessState.pendingDiffs.find(
    (item) => item.toolCallId === toolCallId,
  );
  if (diff?.status === "pending") {
    markPendingDiffStatus(session, toolCallId, "stale");
  }
  updateChangeSetStatusForToolCall(session, toolCallId);
}

export function markPendingDiffStatus(
  session: ChatSession,
  toolCallId: string,
  status: HarnessPendingDiff["status"],
) {
  const diff = session.harnessState.pendingDiffs.find(
    (item) => item.toolCallId === toolCallId,
  );
  if (!diff) return;
  diff.status = status;
  diff.updatedAt = Date.now();
  updateChangeSetStatusForToolCall(session, toolCallId);
}

function clearPendingToolApproval(
  session: ChatSession,
  toolCallId: string,
) {
  session.harnessState.pendingApprovals =
    session.harnessState.pendingApprovals.filter(
      (item) => item.toolCallId !== toolCallId,
    );
}

export function upsertBackgroundTask(
  session: ChatSession,
  task: HarnessBackgroundTask,
) {
  const withoutCurrent = session.harnessState.backgroundTasks.filter(
    (item) => item.id !== task.id,
  );
  session.harnessState.backgroundTasks = [task, ...withoutCurrent]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_BACKGROUND_TASKS);
}

export function upsertSubagentTask(
  session: ChatSession,
  task: HarnessSubagentTask,
) {
  const withoutCurrent = session.harnessState.subagentTasks.filter(
    (item) => item.id !== task.id,
  );
  session.harnessState.subagentTasks = [task, ...withoutCurrent]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SUBAGENT_TASKS);
}

function upsertPendingApproval(
  session: ChatSession,
  pendingApproval: HarnessPendingApproval,
) {
  const next = session.harnessState.pendingApprovals.filter(
    (item) => item.toolCallId !== pendingApproval.toolCallId,
  );
  next.push(pendingApproval);
  session.harnessState.pendingApprovals = next;
}

function upsertPendingDiff(session: ChatSession, pendingDiff: HarnessPendingDiff) {
  const next = session.harnessState.pendingDiffs.filter(
    (item) => item.toolCallId !== pendingDiff.toolCallId,
  );
  next.push(pendingDiff);
  session.harnessState.pendingDiffs = next
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_DIFF_ARTIFACTS);
}

function upsertChangeSet(session: ChatSession, changeSet: HarnessChangeSet) {
  const next = session.harnessState.changeSets.filter(
    (item) => item.id !== changeSet.id,
  );
  next.push(changeSet);
  session.harnessState.changeSets = next
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CHANGE_SETS);
}

function markPendingDiffsStale(session: ChatSession) {
  const now = Date.now();
  for (const diff of session.harnessState.pendingDiffs) {
    if (diff.status === "pending") {
      diff.status = "stale";
      diff.updatedAt = now;
    }
  }
}

function markPendingChangeSetsStale(session: ChatSession) {
  const now = Date.now();
  for (const changeSet of session.harnessState.changeSets) {
    if (changeSet.status === "pending" || changeSet.status === "partially_applied") {
      changeSet.status = "stale";
      changeSet.updatedAt = now;
    }
  }
}

function findChangeSetIdForToolCall(
  session: ChatSession,
  toolCallId: string,
): string | undefined {
  return session.harnessState.changeSets.find((changeSet) =>
    changeSet.toolCallIds.includes(toolCallId),
  )?.id;
}

function updateChangeSetStatusForToolCall(
  session: ChatSession,
  toolCallId: string,
) {
  const changeSet = session.harnessState.changeSets.find((item) =>
    item.toolCallIds.includes(toolCallId),
  );
  if (!changeSet) return;

  const statuses = changeSet.toolCallIds.map((id) =>
    getChangeToolStatus(session, id),
  );
  changeSet.status = resolveChangeSetStatus(statuses);
  changeSet.updatedAt = Date.now();
}

export function markChangeSetStatusForToolCall(
  session: ChatSession,
  toolCallId: string,
) {
  updateChangeSetStatusForToolCall(session, toolCallId);
}

function resolveChangeSetStatus(
  statuses: Array<HarnessPendingDiff["status"] | undefined>,
): HarnessChangeSetStatus {
  const known = statuses.filter(Boolean) as HarnessPendingDiff["status"][];
  if (!known.length) return "pending";
  if (known.some((status) => status === "error")) return "error";
  if (known.some((status) => status === "stale")) return "stale";
  if (known.every((status) => status === "applied")) return "applied";
  if (known.every((status) => status === "rejected")) return "rejected";
  if (known.some((status) => status === "applied" || status === "rejected")) {
    return "partially_applied";
  }
  return "pending";
}

function getChangeToolStatus(
  session: ChatSession,
  toolCallId: string,
): HarnessPendingDiff["status"] | undefined {
  const diff = session.harnessState.pendingDiffs.find(
    (item) => item.toolCallId === toolCallId,
  );
  if (diff) return diff.status;

  const toolCall = findToolCall(session, toolCallId);
  if (!toolCall) return undefined;
  if (toolCall.status === "executed") return "applied";
  if (toolCall.status === "rejected") return "rejected";
  if (toolCall.status === "error") return "error";
  if (toolCall.status === "pending" || toolCall.status === "approved") return "pending";
  return undefined;
}

function buildPendingChangeSetsFromApprovals(
  pendingApprovals: HarnessPendingApproval[],
): HarnessChangeSet[] {
  const changeApprovals = pendingApprovals.filter((approval) =>
    isChangeToolType(approval.toolType) && approval.filePath,
  );
  if (!changeApprovals.length) return [];
  const now = Date.now();
  return [{
    id: `changes:${changeApprovals.map((approval) => approval.toolCallId).join("+")}`,
    toolCallIds: changeApprovals.map((approval) => approval.toolCallId),
    filePaths: Array.from(new Set(changeApprovals.map((approval) => approval.filePath))),
    status: "pending",
    createdAt: now,
    updatedAt: now,
  }];
}

function parseChangeSetEventDetail(detail: string): HarnessChangeSet {
  const parsed = JSON.parse(detail) as {
    id: string;
    toolCallIds: string[];
    filePaths: string[];
  };
  const now = Date.now();
  return {
    id: parsed.id,
    toolCallIds: Array.isArray(parsed.toolCallIds) ? parsed.toolCallIds : [],
    filePaths: Array.isArray(parsed.filePaths) ? parsed.filePaths : [],
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

function isChangeToolType(toolType: string): boolean {
  return toolType === "edit_file" || toolType === "write_file";
}

function dedupeByToolCallId<T extends { toolCallId: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    if (seen.has(item.toolCallId)) continue;
    seen.add(item.toolCallId);
    result.push(item);
  }

  return result;
}

function findToolCall(session: ChatSession, toolCallId: string): ToolCall | undefined {
  for (const entry of session.transcript) {
    const toolCall = entry.toolCalls?.find((item) => item.id === toolCallId);
    if (toolCall) return toolCall;
  }
  return undefined;
}

function extractTodoItems(session: ChatSession): HarnessTodoItem[] {
  for (let entryIndex = session.transcript.length - 1; entryIndex >= 0; entryIndex--) {
    const entry = session.transcript[entryIndex];
    if (!entry.toolCalls?.length) continue;

    for (let toolIndex = entry.toolCalls.length - 1; toolIndex >= 0; toolIndex--) {
      const toolCall = entry.toolCalls[toolIndex];
      if (toolCall.type !== "todo_write" || toolCall.status !== "executed") {
        continue;
      }

      return (toolCall.todos || [])
        .map((todo) => {
          const status: HarnessTodoItem["status"] =
            todo.status === "completed"
              ? "completed"
              : todo.status === "in_progress"
                ? "in_progress"
                : "pending";

          return {
            content: String(todo.content || "").trim(),
            status,
          };
        })
        .filter((todo) => todo.content);
    }
  }

  return [];
}
