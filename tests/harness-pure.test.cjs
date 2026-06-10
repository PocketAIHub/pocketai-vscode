const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const {
  detectSkillPromptIntent,
  resolveSkillByIntent,
  formatSkillListMessage,
  formatSkillAvailabilityMessage,
} = require("../dist/harness/skills/intents.js");
const {
  activateSessionSkill,
  removeSessionSkill,
  clearSessionSkills,
  formatActiveSkillsStatus,
} = require("../dist/harness/skills/active.js");
const {
  inferBuiltinHarnessSkillFromPrompt,
  getBuiltinHarnessSkillBySlashCommand,
} = require("../dist/harness/skills/builtins.js");
const {
  applySkillIntentLocally,
} = require("../dist/harness/skills/workflows.js");
const {
  buildHarnessRuntimeHealth,
} = require("../dist/harness/runtime-health.js");
const {
  createEmptyHarnessSessionState,
  applyHarnessEventToSession,
  syncHarnessPendingState,
  clearPendingToolState,
  markPendingDiffStatus,
  upsertBackgroundTask,
} = require("../dist/harness/state.js");
const {
  parseToolCalls,
  stripFabricatedResults,
  isInsidePath,
} = require("../dist/helpers.js");
const {
  NON_DESTRUCTIVE_TOOL_TYPES,
} = require("../dist/constants.js");
const {
  applyAnchoredEdit,
  clearReadSnapshots,
  recordReadSnapshot,
  validateAnchoredEdit,
} = require("../dist/edit-anchors.js");
const {
  classifyToolRisk,
  classifyShellCommandRisk,
  getToolApprovalDecision,
  shouldAutoExecuteTool,
} = require("../dist/harness/policy.js");
const {
  isAllowedSubagentPath,
  isAllowedSubagentTool,
  isReadonlySubagentTool,
} = require("../dist/harness/subagent-policy.js");
const {
  evaluatePermissionRules,
  buildRememberedPermissionRule,
  getToolPermissionArg,
  matchesPermissionRule,
} = require("../dist/permission-workflows.js");
const {
  classifyHarnessError,
  canRecoverRepeatedToolLoop,
  canRecoverReadLoop,
  canCompactForContextRecovery,
  shouldSurfaceRetryErrorInTranscript,
} = require("../dist/harness/turn-policy.js");
const {
  getEndpointProviderKind,
  getEndpointCapabilities,
} = require("../dist/provider-capabilities.js");
const {
  buildCodexReasoningControlsState,
  buildProviderChatControlsState,
} = require("../dist/provider-chat-state.js");
const {
  serializeSessionForPersistence,
  restoreSessionFromPersistence,
  restorePersistedBackgroundTasks,
  deriveLastSelectedModel,
  getPreferredModelForNewSession,
} = require("../dist/session-persistence.js");
const {
  buildDoctorReport,
  findEndpointMatch,
  formatBackgroundTaskList,
  formatEndpointList,
  formatTrackedTasks,
  getSessionTitlesStatus,
  parseJobsCommandArg,
} = require("../dist/slash-command-utils.js");
const {
  buildSessionSummaries,
  hasSessionStarted,
  normalizeRenamedSessionTitle,
  resolveAutoSessionTitle,
  resolveRenamedSessionTitle,
  resolveSessionDeletion,
  resolveSidebarSessionId,
  sortSessionsByRecency,
} = require("../dist/session-workflows.js");
const {
  applyRefreshedModelsToSessions,
  buildConnectedSessionStatus,
  resolveActiveEndpointUrl,
  syncSessionsToActiveEndpoint,
} = require("../dist/endpoint-workflows.js");
const {
  buildClearedBackgroundTasksMessage,
  buildSessionExportFileName,
  buildSessionExportMarkdown,
  filterSessionSummariesByQuery,
  getFinishedBackgroundTaskIds,
  getInteractionModeStatus,
} = require("../dist/chat-workflows.js");
const {
  shouldPersistBackgroundTaskUpdate,
} = require("../dist/background-task-workflows.js");
const {
  bindPanelToSession,
  getPanelsBoundToSession,
  rebindDeletedSessionPanels,
} = require("../dist/panel-session-workflows.js");
const {
  applyErroredToolCallResult,
  applyExecutedToolCallResult,
  applyRejectedToolCallResult,
  applyStaleToolCallResult,
  areToolCallsResolved,
  buildToolExecutionErrorMessage,
  findToolCallInTranscript,
  shouldContinueAfterToolResolution,
} = require("../dist/tool-approval-workflows.js");
const {
  buildAssistantToolActionSummary,
  formatAssistantToolActionContent,
  isAssistantToolActionPlaceholder,
} = require("../dist/tool-activity-summary.js");
const {
  buildCancelledLoopOutcome,
  buildFailedLoopOutcome,
  getPostLoopReadyStatus,
  shouldFinalizeCompletedLoop,
} = require("../dist/run-loop-workflows.js");
const {
  applySlashSkillShortcut,
  beginPromptTurn,
  buildTransientSystemPromptForPrompt,
  ensureSelectedModelForPrompt,
  NO_MODEL_SELECTED_STATUS,
  preparePromptForSend,
} = require("../dist/prompt-workflows.js");
const {
  applyClearSlashCommand,
  applyExplicitModeSlashCommand,
  applyModelSlashCommand,
  applyQuickModeSlashCommand,
  applySessionsSlashCommand,
  applyTodoSlashCommand,
  applyTokensSlashCommand,
  buildRefreshSlashStatus,
  buildSlashHelpContent,
  buildUsageSlashReport,
  resolveEndpointSlashCommand,
  resolveJobsSlashCommand,
} = require("../dist/slash-command-workflows.js");
const {
  getPocketAiWorktreeRoot,
  normalizeWorktreeName,
  resolveWorktreeSlashCommand,
} = require("../dist/worktree-workflows.js");
const {
  resolveSessionWorkspaceRoot,
} = require("../dist/workspace-root-workflows.js");
const {
  buildEndpointSecretMigration,
  getEndpointApiKeySecretKey,
} = require("../dist/endpoint-secrets.js");
const {
  isHttpExternalUrl,
  normalizeHttpExternalUrl,
} = require("../dist/external-links.js");
const {
  formatMcpPromptGet,
  formatMcpResourceRead,
} = require("../dist/mcp-format.js");
const {
  getSharedProjectStorage,
  formatSharedProjectPath,
} = require("../dist/shared-storage.js");
const {
  discoverWorkspaceSkillFiles,
  findWorkspaceSkillRoots,
  installWorkspaceSkillFromPath,
  isWorkspaceSkillDisabled,
  listManagedWorkspaceSkills,
  manageWorkspaceSkill,
  normalizeSkillRelativePath,
  parseWorkspaceSkill,
  readWorkspaceSkillSupportFiles,
  scanWorkspaceSkillCandidates,
} = require("../dist/harness/skills/workspace.js");
const {
  TOOL_DEFINITIONS,
} = require("../dist/tool-definitions.js");
const {
  buildBackgroundTaskRestoreSnapshots,
  resolveExistingSessionId,
  shouldPersistStartupState,
} = require("../dist/startup-workflows.js");
const {
  buildPocketAiRemoteEndpoint,
} = require("../dist/pocketai-remote-devices.js");
const {
  getOpenCodeGoChatModels,
  getOpenCodeGoHealthProbeInit,
  isOpenCodeGoEndpoint,
  normalizeEndpointInputUrl,
  toOpenCodeGoRequestModel,
} = require("../dist/opencode-go.js");
const {
  XAI_BASE_URL,
  getXAIProviderName,
  isXAIEndpoint,
  normalizeXAIBaseUrl,
} = require("../dist/xai.js");
const {
  formatBrowserSnapshot,
  normalizeBrowserUrl,
} = require("../dist/browser-cdp.js");
const {
  getChatScript,
} = require("../dist/chat-script.js");
const {
  getSettingsHtml,
} = require("../dist/settings-html.js");

function createSession(overrides = {}) {
  return {
    id: "session-1",
    title: "PocketAI Code",
    transcript: [],
    selectedModel: "model-a",
    selectedReasoningEffort: "",
    selectedEndpoint: "http://127.0.0.1:39457",
    worktreeRoot: "",
    status: "Ready",
    updatedAt: Date.now(),
    busy: false,
    mode: "ask",
    checkpoints: [],
    cumulativeTokens: { prompt: 0, completion: 0 },
    activeSkills: [],
    harnessState: {
      pendingApprovals: [],
      pendingDiffs: [],
      changeSets: [],
      todoItems: [],
      toolTimeline: [],
      backgroundTasks: [],
      subagentTasks: [],
    },
    ...overrides,
  };
}

function createEndpointManager(overrides = {}) {
  return {
    activeEndpointUrl: "http://127.0.0.1:39457",
    endpointHealthMap: new Map([
      [
        "http://127.0.0.1:39457",
        { healthy: true, error: undefined },
      ],
    ]),
    models: ["model-a"],
    getActiveEndpointCapabilities() {
      return {
        kind: "local-pocketai",
        supportsStructuredTools: true,
        supportsReasoningEffort: false,
        requiresBridgeBootstrap: false,
      };
    },
    ...overrides,
  };
}

test("detectSkillPromptIntent handles list, check, and activate prompts", () => {
  assert.deepEqual(detectSkillPromptIntent("what skills do you have?"), {
    type: "list-skills",
  });
  assert.deepEqual(detectSkillPromptIntent("is the debug skill available?"), {
    type: "check-skill",
    skillId: "debug",
  });
  assert.deepEqual(
    detectSkillPromptIntent("use the code review skill to inspect this diff"),
    {
      type: "activate-skill",
      skillId: "code-review",
      remainder: "inspect this diff",
    },
  );
});

test("resolveSkillByIntent matches ids and humanized names", () => {
  const skills = [
    {
      id: "code-review",
      name: "Code Review",
      description: "Review code",
      source: "builtin",
      prompt: "Review it",
    },
  ];

  assert.equal(resolveSkillByIntent(skills, "code-review")?.id, "code-review");
  assert.equal(resolveSkillByIntent(skills, "Code Review")?.id, "code-review");
  assert.equal(resolveSkillByIntent(skills, "code review")?.id, "code-review");
});

test("skill formatters separate builtin and workspace skills", () => {
  const skills = [
    {
      id: "debug",
      name: "Debug",
      description: "Find bugs",
      source: "builtin",
      prompt: "Debug carefully",
    },
    {
      id: "my-workflow",
      name: "My Workflow",
      description: "Workspace flow",
      source: "workspace",
      prompt: "Do the thing",
      path: "/tmp/SKILL.md",
    },
  ];

  const listMessage = formatSkillListMessage(skills);
  assert.match(listMessage, /PocketAI built-in skills:/);
  assert.match(listMessage, /Workspace skills:/);
  assert.match(
    formatSkillAvailabilityMessage(skills[1], "my-workflow"),
    /available as a PocketAI workspace skill/i,
  );
  assert.match(
    formatSkillAvailabilityMessage(undefined, "missing"),
    /is not available/i,
  );
});

test("active skill helpers stack, replace, trim, remove, and clear cleanly", () => {
  const session = createSession();
  const skills = [
    { id: "debug", name: "Debug", description: "Debug", prompt: "Debug it" },
    { id: "review", name: "Review", description: "Review", prompt: "Review it" },
    { id: "test", name: "Test", description: "Test", prompt: "Test it" },
    { id: "fix", name: "Fix", description: "Fix", prompt: "Fix it" },
    { id: "init", name: "Init", description: "Init", prompt: "Init it" },
  ];

  activateSessionSkill(session, skills[0], "focus on stack trace");
  assert.match(session.activeSkillInjection || "", /Focus: focus on stack trace/);
  activateSessionSkill(session, skills[1]);
  activateSessionSkill(session, skills[2]);
  activateSessionSkill(session, skills[3]);
  activateSessionSkill(session, skills[4]);

  assert.equal(session.activeSkills.length, 4);
  assert.equal(session.activeSkills[0].id, "review");
  assert.equal(session.activeSkills[3].id, "init");
  assert.match(session.activeSkillInjection || "", /\[Active Skills\]/);
  assert.doesNotMatch(session.activeSkillInjection || "", /Focus: focus on stack trace/);
  assert.match(formatActiveSkillsStatus(session.activeSkills), /skills active/i);

  activateSessionSkill(session, skills[4], "narrow it down");
  assert.equal(session.activeSkills[3].note, "narrow it down");

  removeSessionSkill(session, "test");
  assert.equal(session.activeSkills.some((skill) => skill.id === "test"), false);

  session.skillPreflightContext = "cached";
  clearSessionSkills(session);
  assert.deepEqual(session.activeSkills, []);
  assert.equal(session.activeSkillInjection, undefined);
  assert.equal(session.skillPreflightContext, undefined);
});

test("builtin skill auto-routing prefers the highest-priority matching skill", () => {
  assert.equal(
    inferBuiltinHarnessSkillFromPrompt("fix these diagnostics")?.id,
    "fix",
  );
  assert.equal(
    inferBuiltinHarnessSkillFromPrompt("please investigate why this is failing")?.id,
    "investigate",
  );
  assert.equal(
    inferBuiltinHarnessSkillFromPrompt("implement a new endpoint dropdown")?.id,
    "implement",
  );
  assert.equal(
    inferBuiltinHarnessSkillFromPrompt("fix these diagnostics", ["fix"])?.id,
    undefined,
  );
  assert.equal(getBuiltinHarnessSkillBySlashCommand("/review")?.id, "review");
});

test("skill intent workflow handles local responses, title updates, and prompt fallthrough", () => {
  const skills = [
    {
      id: "debug",
      name: "Debug",
      description: "Find the real bug.",
      source: "builtin",
      prompt: "Debug carefully.",
    },
    {
      id: "review",
      name: "Review",
      description: "Review the code.",
      source: "builtin",
      prompt: "Review carefully.",
    },
  ];

  const listSession = createSession({ title: "Chat 7", transcript: [] });
  const listResult = applySkillIntentLocally({
    session: listSession,
    intent: { type: "list-skills" },
    originalPrompt: "what skills do you have?",
    skills,
    fallbackTitleNumber: 7,
  });
  assert.deepEqual(listResult, { handled: true, titleChanged: true });
  assert.equal(listSession.status, "Ready");
  assert.equal(listSession.title, "what skills do you have?");
  assert.equal(listSession.transcript.length, 2);
  assert.match(listSession.transcript[1].content, /PocketAI built-in skills:/);

  const checkSession = createSession({
    title: "Existing title",
    transcript: [],
  });
  const checkResult = applySkillIntentLocally({
    session: checkSession,
    intent: { type: "check-skill", skillId: "debug" },
    originalPrompt: "is the debug skill available?",
    skills,
    fallbackTitleNumber: 4,
  });
  assert.deepEqual(checkResult, { handled: true, titleChanged: false });
  assert.equal(checkSession.title, "Existing title");
  assert.match(checkSession.transcript[1].content, /available as a PocketAI builtin skill/i);

  const missingSession = createSession({ title: "Chat 2", transcript: [] });
  const missingResult = applySkillIntentLocally({
    session: missingSession,
    intent: { type: "activate-skill", skillId: "missing", remainder: "" },
    originalPrompt: "use the missing skill",
    skills,
    fallbackTitleNumber: 2,
  });
  assert.deepEqual(missingResult, { handled: true, titleChanged: true });
  assert.equal(missingSession.transcript.length, 2);
  assert.match(missingSession.transcript[1].content, /is not available/i);

  const activateOnlySession = createSession({ transcript: [] });
  const activateOnlyResult = applySkillIntentLocally({
    session: activateOnlySession,
    intent: { type: "activate-skill", skillId: "debug", remainder: "" },
    originalPrompt: "use the debug skill",
    skills,
    fallbackTitleNumber: 1,
  });
  assert.deepEqual(activateOnlyResult, { handled: true, titleChanged: false });
  assert.equal(activateOnlySession.transcript.length, 0);
  assert.equal(activateOnlySession.activeSkills[0].id, "debug");
  assert.match(activateOnlySession.status, /Debug skill active/i);

  const activateWithRemainderSession = createSession({ transcript: [] });
  const activateWithRemainderResult = applySkillIntentLocally({
    session: activateWithRemainderSession,
    intent: {
      type: "activate-skill",
      skillId: "review",
      remainder: "inspect this diff",
    },
    originalPrompt: "use the review skill and inspect this diff",
    skills,
    fallbackTitleNumber: 3,
  });
  assert.deepEqual(activateWithRemainderResult, {
    handled: false,
    nextPrompt: "inspect this diff",
    titleChanged: false,
  });
  assert.equal(activateWithRemainderSession.transcript.length, 0);
  assert.equal(activateWithRemainderSession.activeSkills[0].id, "review");
});

test("runtime health reports warnings and errors with actionable next steps", () => {
  const session = createSession({
    harnessState: {
      pendingApprovals: [{ toolCallId: "t1", toolType: "edit_file", filePath: "a.ts" }],
      pendingDiffs: [],
      todoItems: [],
      backgroundTasks: [
        {
          id: "bg1",
          command: "npm test",
          status: "running",
          outputPreview: "",
          updatedAt: Date.now(),
        },
        {
          id: "bg2",
          command: "npm run lint",
          status: "interrupted",
          outputPreview: "",
          updatedAt: Date.now(),
        },
        {
          id: "bg3",
          command: "npm run build",
          status: "failed",
          outputPreview: "",
          updatedAt: Date.now(),
        },
      ],
    },
  });
  const endpointMgr = createEndpointManager({
    models: [],
    endpointHealthMap: new Map([
      [
        "http://127.0.0.1:39457",
        { healthy: false, error: "refused" },
      ],
    ]),
    getActiveEndpointCapabilities() {
      return {
        kind: "openai-compatible",
        supportsStructuredTools: false,
        supportsReasoningEffort: false,
        requiresBridgeBootstrap: false,
      };
    },
  });

  const health = buildHarnessRuntimeHealth({
    session,
    endpointMgr,
    estimatedTokens: 9000,
    contextWindowSize: 10000,
  });

  assert.equal(health.level, "error");
  assert.match(health.summary, /attention needed/i);
  assert(health.issues.some((issue) => /not healthy/i.test(issue)));
  assert(health.issues.some((issue) => /tool approval/i.test(issue)));
  assert(health.issues.some((issue) => /still running/i.test(issue)));
  assert(health.issues.some((issue) => /failed recently/i.test(issue)));
  assert(health.issues.some((issue) => /interrupted by reload/i.test(issue)));
  assert(health.suggestions.some((suggestion) => /Structured tool calling is unavailable/i.test(suggestion)));
  assert(health.actions.includes("refresh-models"));
  assert(health.actions.includes("compact"));
  assert(health.actions.includes("show-jobs"));
});

test("harness state sync rebuilds pending approvals, diffs, and latest todo list", () => {
  const session = createSession({
    transcript: [
      {
        role: "assistant",
        content: "Working on it",
        toolCalls: [
          {
            id: "edit-1",
            type: "edit_file",
            filePath: "src/app.ts",
            status: "pending",
          },
          {
            id: "read-1",
            type: "read_file",
            filePath: "src/app.ts",
            status: "pending",
          },
          {
            id: "write-1",
            type: "write_file",
            filePath: "src/new.ts",
            status: "pending",
          },
        ],
      },
      {
        role: "tool",
        content: "todos",
        toolCalls: [
          {
            id: "todo-old",
            type: "todo_write",
            filePath: "",
            status: "executed",
            todos: [
              { content: "old", status: "completed" },
            ],
          },
          {
            id: "todo-new",
            type: "todo_write",
            filePath: "",
            status: "executed",
            todos: [
              { content: "step one", status: "pending" },
              { content: "step two", status: "in_progress" },
              { content: "step three", status: "completed" },
              { content: "   ", status: "pending" },
            ],
          },
        ],
      },
    ],
  });

  syncHarnessPendingState(session);

  assert.deepEqual(session.harnessState.pendingApprovals, [
    { toolCallId: "edit-1", toolType: "edit_file", filePath: "src/app.ts" },
    { toolCallId: "read-1", toolType: "read_file", filePath: "src/app.ts" },
    { toolCallId: "write-1", toolType: "write_file", filePath: "src/new.ts" },
  ]);
  const runApprovalSession = createSession({
    transcript: [{
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "cmd-1",
        type: "run_command",
        filePath: "",
        command: "echo hello > out.txt",
        status: "pending",
      }],
    }],
  });
  syncHarnessPendingState(runApprovalSession);
  assert.equal(
    runApprovalSession.harnessState.pendingApprovals[0].commandRisk,
    "writes",
  );
  assert.equal(session.harnessState.pendingDiffs.length, 1);
  assert.equal(session.harnessState.pendingDiffs[0].id, "diff:edit-1");
  assert.equal(session.harnessState.pendingDiffs[0].toolCallId, "edit-1");
  assert.equal(session.harnessState.pendingDiffs[0].filePath, "src/app.ts");
  assert.equal(session.harnessState.pendingDiffs[0].status, "pending");
  assert.equal(session.harnessState.pendingDiffs[0].previewKind, "inline-diff");
  assert.equal(typeof session.harnessState.pendingDiffs[0].createdAt, "number");
  assert.equal(typeof session.harnessState.pendingDiffs[0].updatedAt, "number");
  assert.equal(session.harnessState.changeSets.length, 1);
  assert.deepEqual(session.harnessState.changeSets[0].toolCallIds, ["edit-1", "write-1"]);
  assert.deepEqual(session.harnessState.changeSets[0].filePaths, ["src/app.ts", "src/new.ts"]);
  assert.equal(session.harnessState.changeSets[0].status, "pending");
  assert.deepEqual(session.harnessState.todoItems, [
    { content: "step one", status: "pending" },
    { content: "step two", status: "in_progress" },
    { content: "step three", status: "completed" },
  ]);
  const timelineById = new Map(
    session.harnessState.toolTimeline.map((item) => [item.toolCallId, item]),
  );
  assert.equal(timelineById.get("edit-1").status, "pending_approval");
  assert.equal(timelineById.get("edit-1").label, "Edit");
  assert.equal(timelineById.get("edit-1").target, "app.ts");
  assert.equal(timelineById.get("read-1").label, "Read");
  assert.equal(timelineById.get("todo-new").status, "succeeded");
});

test("harness events and task upserts keep session state tidy", () => {
  const session = createSession({
    transcript: [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "edit-2",
            type: "edit_file",
            filePath: "src/file.ts",
            status: "pending",
          },
        ],
      },
    ],
    harnessState: createEmptyHarnessSessionState(),
  });

  applyHarnessEventToSession(session, {
    type: "tool_call_pending_approval",
    sessionId: session.id,
    toolCallId: "edit-2",
    detail: "edit_file",
  });
  applyHarnessEventToSession(session, {
    type: "change_set_ready",
    sessionId: session.id,
    detail: JSON.stringify({
      id: "changes:edit-2",
      toolCallIds: ["edit-2"],
      filePaths: ["src/file.ts"],
    }),
  });
  applyHarnessEventToSession(session, {
    type: "diff_ready",
    sessionId: session.id,
    toolCallId: "edit-2",
    detail: "src/file.ts",
  });

  assert.equal(session.harnessState.pendingApprovals.length, 1);
  assert.equal(session.harnessState.toolTimeline[0].status, "pending_approval");
  assert.equal(session.harnessState.toolTimeline[0].label, "Edit");
  assert.equal(session.harnessState.pendingDiffs.length, 1);
  assert.equal(session.harnessState.pendingDiffs[0].changeSetId, "changes:edit-2");
  assert.equal(session.harnessState.pendingDiffs[0].status, "pending");
  assert.equal(session.harnessState.changeSets.length, 1);
  assert.equal(session.harnessState.changeSets[0].status, "pending");

  markPendingDiffStatus(session, "edit-2", "applied");
  assert.equal(session.harnessState.pendingDiffs[0].status, "applied");
  assert.equal(session.harnessState.changeSets[0].status, "applied");

  clearPendingToolState(session, "edit-2");
  assert.equal(session.harnessState.pendingApprovals.length, 0);
  assert.equal(session.harnessState.pendingDiffs.length, 1);
  assert.equal(session.harnessState.pendingDiffs[0].status, "applied");

  applyHarnessEventToSession(session, {
    type: "tool_call_started",
    sessionId: session.id,
    toolCallId: "edit-2",
    detail: "edit_file",
  });
  assert.equal(session.harnessState.toolTimeline[0].status, "running");
  applyHarnessEventToSession(session, {
    type: "tool_call_completed",
    sessionId: session.id,
    toolCallId: "edit-2",
    detail: "edit_file",
  });
  assert.equal(session.harnessState.toolTimeline[0].status, "succeeded");
  assert.equal(typeof session.harnessState.toolTimeline[0].startedAt, "number");
  assert.equal(typeof session.harnessState.toolTimeline[0].completedAt, "number");

  upsertBackgroundTask(session, {
    id: "bg-old",
    command: "npm run lint",
    status: "completed",
    outputPreview: "",
    updatedAt: 10,
  });
  upsertBackgroundTask(session, {
    id: "bg-new",
    command: "npm test",
    status: "running",
    outputPreview: "",
    updatedAt: 20,
  });
  upsertBackgroundTask(session, {
    id: "bg-old",
    command: "npm run lint --fix",
    status: "failed",
    outputPreview: "oops",
    updatedAt: 30,
  });

  assert.deepEqual(
    session.harnessState.backgroundTasks.map((task) => task.id),
    ["bg-old", "bg-new"],
  );
  assert.equal(session.harnessState.backgroundTasks[0].command, "npm run lint --fix");
  assert.equal(session.harnessState.backgroundTasks[0].status, "failed");
});

test("background task persistence detects output and completion detail changes", () => {
  const baseTask = {
    id: "bg-1",
    command: "npm test",
    kind: "background",
    toolCallId: "tool-1",
    status: "running",
    outputPreview: "starting",
    startedAt: 100,
    updatedAt: 110,
    cwd: "/repo",
  };

  assert.equal(shouldPersistBackgroundTaskUpdate(undefined, baseTask), true);
  assert.equal(
    shouldPersistBackgroundTaskUpdate(baseTask, {
      ...baseTask,
      outputPreview: "starting\nok",
      updatedAt: 120,
    }),
    true,
  );
  assert.equal(
    shouldPersistBackgroundTaskUpdate(baseTask, {
      ...baseTask,
      status: "cancelled",
      exitCode: 143,
      completedAt: 130,
      updatedAt: 130,
    }),
    true,
  );
  assert.equal(
    shouldPersistBackgroundTaskUpdate(baseTask, {
      ...baseTask,
      updatedAt: 120,
    }),
    false,
  );
});

test("parseToolCalls understands newer IDE and editor-action tools", () => {
  const calls = parseToolCalls(`
@open_file: src/app.ts --line 12 --char 4
@workspace_symbols: HeaderBar
@hover_symbol: src/app.ts --line 14 --char 2
@code_actions: src/app.ts --line 18 --char 1
@apply_code_action: src/app.ts --line 18 --char 1 --title Add missing import
@run_command: --background npm test
@grep: pocketai --glob *.ts --output files_with_matches --context 2 -i
@todo_write: one | two | three
@task: reviewer | inspect auth flow and report risks
`);

  assert.equal(calls.length, 9);
  assert.deepEqual(
    calls.map((call) => call.type),
    [
      "open_file",
      "workspace_symbols",
      "hover_symbol",
      "code_actions",
      "apply_code_action",
      "run_command",
      "grep",
      "todo_write",
      "task",
    ],
  );

  assert.equal(calls[0].filePath, "src/app.ts");
  assert.equal(calls[0].line, 12);
  assert.equal(calls[0].character, 4);
  assert.equal(calls[1].query, "HeaderBar");
  assert.equal(calls[4].actionTitle, "Add missing import");
  assert.equal(calls[5].background, true);
  assert.equal(calls[5].command, "npm test");
  assert.equal(calls[6].pattern, "pocketai");
  assert.equal(calls[6].glob, "*.ts");
  assert.equal(calls[6].outputMode, "files_with_matches");
  assert.equal(calls[6].contextLines, 2);
  assert.equal(calls[6].caseInsensitive, true);
  assert.deepEqual(
    calls[7].todos,
    [
      { content: "one", status: "pending" },
      { content: "two", status: "pending" },
      { content: "three", status: "pending" },
    ],
  );
  assert.equal(calls[8].subagentName, "reviewer");
  assert.equal(calls[8].taskPrompt, "inspect auth flow and report risks");
});

test("parseToolCalls understands anchored edit line ranges", () => {
  const calls = parseToolCalls(`
@edit_file: src/app.ts --lines 3-4
<<<REPLACE
const next = true;
return next;
REPLACE>>>
`);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "edit_file");
  assert.equal(calls[0].filePath, "src/app.ts");
  assert.equal(calls[0].startLine, 3);
  assert.equal(calls[0].endLine, 4);
  assert.equal(calls[0].replace, "const next = true;\nreturn next;");
  assert.equal(calls[0].search, undefined);
});

test("anchored edits validate against the last read snapshot", () => {
  clearReadSnapshots();
  const filePath = "src/app.ts";
  const original = ["alpha", "beta", "gamma", "delta"].join("\n");
  recordReadSnapshot(filePath, original);

  const applied = applyAnchoredEdit(filePath, original, {
    startLine: 2,
    endLine: 3,
  }, "BETA\nGAMMA");
  assert.equal(applied.ok, true);
  assert.equal(applied.content, ["alpha", "BETA", "GAMMA", "delta"].join("\n"));

  const changed = ["alpha", "changed", "gamma", "delta"].join("\n");
  const stale = validateAnchoredEdit(filePath, changed, {
    startLine: 2,
    endLine: 3,
  });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /stale/);
});

test("parseToolCalls understands skill management text commands", () => {
  const calls = parseToolCalls(`
@skill_view: github-pr-workflow
@skill_view: github-pr-workflow --path references/ci-troubleshooting.md
@skill_scan: /tmp/local-skills
@skill_scan
@skill_install: /tmp/local-skills/debug-helper
@skill_install: /tmp/local-skills/debug-helper --name debug-copy
@skill_manage: list
@skill_manage: disable github-pr-workflow
@skill_manage: enable github-pr-workflow
@mcp_list_resources: local
@mcp_read_resource: local file:///tmp/context.txt
@mcp_list_resource_templates
@mcp_list_prompts: local
@mcp_get_prompt: local review --args {"focus":"security"}
`);

  assert.deepEqual(
    calls.map((call) => call.type),
    [
      "skill_view",
      "skill_view",
      "skill_scan",
      "skill_scan",
      "skill_install",
      "skill_install",
      "skill_manage",
      "skill_manage",
      "skill_manage",
      "mcp_list_resources",
      "mcp_read_resource",
      "mcp_list_resource_templates",
      "mcp_list_prompts",
      "mcp_get_prompt",
    ],
  );
  assert.equal(calls[0].skillName, "github-pr-workflow");
  assert.equal(calls[0].filePath, "");
  assert.equal(calls[1].skillName, "github-pr-workflow");
  assert.equal(calls[1].filePath, "references/ci-troubleshooting.md");
  assert.equal(calls[2].filePath, "/tmp/local-skills");
  assert.equal(calls[3].filePath, "");
  assert.equal(calls[4].filePath, "/tmp/local-skills/debug-helper");
  assert.equal(calls[4].skillName, "");
  assert.equal(calls[5].filePath, "/tmp/local-skills/debug-helper");
  assert.equal(calls[5].skillName, "debug-copy");
  assert.equal(calls[6].skillManageAction, "list");
  assert.equal(calls[6].skillName, "");
  assert.equal(calls[7].skillManageAction, "disable");
  assert.equal(calls[7].skillName, "github-pr-workflow");
  assert.equal(calls[8].skillManageAction, "enable");
  assert.equal(calls[8].skillName, "github-pr-workflow");
  assert.equal(calls[9].mcpServerName, "local");
  assert.equal(calls[10].mcpServerName, "local");
  assert.equal(calls[10].mcpResourceUri, "file:///tmp/context.txt");
  assert.equal(calls[11].mcpServerName, "");
  assert.equal(calls[12].mcpServerName, "local");
  assert.equal(calls[13].mcpServerName, "local");
  assert.equal(calls[13].mcpPromptName, "review");
  assert.deepEqual(calls[13].mcpArguments, { focus: "security" });
});

test("parseToolCalls understands local browser text commands", () => {
  const calls = parseToolCalls(`
@browser_navigate: localhost:3000/login
@browser_snapshot --max-elements 25 --max-body-chars 3000
@browser_click: 3
@browser_type: 3 hello world
@browser_type: active text only
@browser_screenshot --full-page
@browser_close
`);

  assert.deepEqual(
    calls.map((call) => call.type),
    [
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_type",
      "browser_screenshot",
      "browser_close",
    ],
  );
  assert.equal(calls[0].browserUrl, "localhost:3000/login");
  assert.equal(calls[0].url, "localhost:3000/login");
  assert.equal(calls[1].browserMaxElements, 25);
  assert.equal(calls[1].browserMaxBodyChars, 3000);
  assert.equal(calls[2].browserRef, "3");
  assert.equal(calls[3].browserRef, "3");
  assert.equal(calls[3].browserText, "hello world");
  assert.equal(calls[4].browserRef, "");
  assert.equal(calls[4].browserText, "active text only");
  assert.equal(calls[5].browserFullPage, true);
});

test("workspace skill helpers discover ancestor skills, metadata, and support files", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pocketai-skills-"));
  const repoRoot = path.join(tempRoot, "repo");
  const openedFolder = path.join(repoRoot, "pocketai-vscode");
  const skillsRoot = path.join(repoRoot, ".pocketai", "skills");
  const skillDir = path.join(skillsRoot, "category", "debug-helper");
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
  fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(skillDir, "node_modules", "junk"), { recursive: true });
  fs.mkdirSync(path.join(skillsRoot, ".git", "hidden"), { recursive: true });
  fs.mkdirSync(openedFolder, { recursive: true });

  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(
    skillPath,
    [
      "---",
      "name: debug-helper",
      "description: \"Debug helper workflow.\"",
      "platforms:",
      "  - linux",
      "  - macos",
      "metadata:",
      "  hermes:",
      "    tags: [debugging, root-cause]",
      "    category: software-development",
      "    related_skills: [test-driven-development, writing-plans]",
      "---",
      "",
      "# Debug Helper",
      "Read the references before fixing.",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(skillsRoot, "flat.md"), "# Flat Skill\n");
  fs.writeFileSync(path.join(skillDir, "references", "guide.md"), "Guide");
  fs.writeFileSync(path.join(skillDir, "scripts", "inspect.js"), "inspect();");
  fs.writeFileSync(
    path.join(skillDir, "node_modules", "junk", "SKILL.md"),
    "# Ignore me",
  );
  fs.writeFileSync(
    path.join(skillsRoot, ".git", "hidden", "SKILL.md"),
    "# Ignore me too",
  );

  assert.deepEqual(findWorkspaceSkillRoots([openedFolder]), [skillsRoot]);

  const discovered = discoverWorkspaceSkillFiles(skillsRoot)
    .map((filePath) => path.relative(skillsRoot, filePath).split(path.sep).join("/"))
    .sort();
  assert.deepEqual(discovered, ["category/debug-helper/SKILL.md", "flat.md"]);

  const parsed = parseWorkspaceSkill(fs.readFileSync(skillPath, "utf-8"));
  assert.equal(parsed.frontmatter.name, "debug-helper");
  assert.equal(parsed.frontmatter.description, "Debug helper workflow.");
  assert.deepEqual(parsed.frontmatter.platforms, ["linux", "macos"]);
  assert.deepEqual(parsed.frontmatter.tags, ["debugging", "root-cause"]);
  assert.equal(parsed.frontmatter.category, "software-development");
  assert.deepEqual(parsed.frontmatter.relatedSkills, [
    "test-driven-development",
    "writing-plans",
  ]);

  const supportFiles = readWorkspaceSkillSupportFiles(skillDir).map((file) => ({
    path: file.path,
    kind: file.kind,
  }));
  assert.deepEqual(supportFiles, [
    { path: "references/guide.md", kind: "references" },
    { path: "scripts/inspect.js", kind: "scripts" },
  ]);

  assert.equal(
    normalizeSkillRelativePath("references/guide.md"),
    "references/guide.md",
  );
  assert.equal(normalizeSkillRelativePath("../secret.txt"), undefined);
  assert.equal(normalizeSkillRelativePath("references/../secret.txt"), undefined);
  assert.equal(normalizeSkillRelativePath("/tmp/secret.txt"), undefined);
  assert.equal(normalizeSkillRelativePath("C:/secret.txt"), undefined);
});

test("shared project storage uses a deterministic app-data project directory", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pocketai-shared-"));
  const oldPocketAiHome = process.env.POCKETAI_HOME;
  process.env.POCKETAI_HOME = path.join(tempRoot, "PocketAIHome");
  try {
    const workspaceRoot = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const first = getSharedProjectStorage(workspaceRoot);
    const second = getSharedProjectStorage(workspaceRoot);

    assert.equal(first.projectId, second.projectId);
    assert.match(first.projectId, /^workspace-[a-f0-9]{12}$/);
    assert.equal(
      first.projectRoot,
      path.join(tempRoot, "PocketAIHome", "projects", first.projectId),
    );
    assert.equal(
      formatSharedProjectPath(workspaceRoot, path.join(first.vaultDir, "evals.qmd")),
      "PocketAI project storage/vault/evals.qmd",
    );
  } finally {
    if (oldPocketAiHome === undefined) {
      delete process.env.POCKETAI_HOME;
    } else {
      process.env.POCKETAI_HOME = oldPocketAiHome;
    }
  }
});

test("workspace skill scanner reports candidates and installed conflicts", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pocketai-scan-"));
  const skillsRoot = path.join(tempRoot, "skills");
  const skillDir = path.join(skillsRoot, "debug-helper");
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
  fs.mkdirSync(path.join(skillsRoot, "node_modules", "ignored"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: debug-helper",
      "description: Debug helper workflow.",
      "metadata:",
      "  hermes:",
      "    tags: [debugging, root-cause]",
      "    category: software-development",
      "---",
      "",
      "# Debug Helper",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(skillDir, "references", "guide.md"), "Guide");
  fs.writeFileSync(
    path.join(skillsRoot, "node_modules", "ignored", "SKILL.md"),
    "# Ignored",
  );
  fs.writeFileSync(path.join(skillsRoot, "flat.md"), "# Flat Skill\n");

  const result = scanWorkspaceSkillCandidates(skillsRoot, [
    { id: "debug-helper", path: "/installed/debug-helper/SKILL.md" },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.id).sort(),
    ["debug-helper", "flat"],
  );
  const debugCandidate = result.candidates.find(
    (candidate) => candidate.id === "debug-helper",
  );
  assert.ok(debugCandidate);
  assert.equal(debugCandidate.description, "Debug helper workflow.");
  assert.equal(debugCandidate.sourcePath, path.join(skillDir, "SKILL.md"));
  assert.equal(debugCandidate.supportFileCount, 1);
  assert.equal(debugCandidate.category, "software-development");
  assert.deepEqual(debugCandidate.tags, ["debugging", "root-cause"]);
  assert.equal(debugCandidate.conflict, "installed");
  assert.equal(debugCandidate.conflictPath, "/installed/debug-helper/SKILL.md");

  const missing = scanWorkspaceSkillCandidates(path.join(tempRoot, "missing"));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /does not exist/);
});

test("workspace skill installer copies skill and support files without overwriting", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pocketai-install-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const oldPocketAiHome = process.env.POCKETAI_HOME;
  process.env.POCKETAI_HOME = path.join(tempRoot, "PocketAIHome");
  const sourceSkillDir = path.join(tempRoot, "source", "debug-helper");
  fs.mkdirSync(path.join(sourceSkillDir, "references"), { recursive: true });
  fs.mkdirSync(path.join(sourceSkillDir, "scripts"), { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(sourceSkillDir, "SKILL.md"),
    [
      "---",
      "name: debug-helper",
      "description: Debug helper workflow.",
      "---",
      "",
      "# Debug Helper",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(sourceSkillDir, "references", "guide.md"), "Guide");
  fs.writeFileSync(path.join(sourceSkillDir, "scripts", "inspect.js"), "inspect();");

  let symlinkCreated = false;
  try {
    fs.symlinkSync(
      path.join(sourceSkillDir, "references", "guide.md"),
      path.join(sourceSkillDir, "references", "guide-link.md"),
    );
    symlinkCreated = true;
  } catch {
    symlinkCreated = false;
  }

  try {
    const result = installWorkspaceSkillFromPath({
      sourcePath: sourceSkillDir,
      workspaceRoot,
    });

    assert.equal(result.ok, true);
    const installedDir = path.join(
      getSharedProjectStorage(workspaceRoot).skillsDir,
      "debug-helper",
    );
    assert.equal(result.installedPath, installedDir);
    assert.equal(
      fs.readFileSync(path.join(installedDir, "SKILL.md"), "utf-8"),
      fs.readFileSync(path.join(sourceSkillDir, "SKILL.md"), "utf-8"),
    );
    assert.equal(
      fs.readFileSync(path.join(installedDir, "references", "guide.md"), "utf-8"),
      "Guide",
    );
    assert.equal(
      fs.readFileSync(path.join(installedDir, "scripts", "inspect.js"), "utf-8"),
      "inspect();",
    );
    if (symlinkCreated) {
      assert.equal(
        fs.existsSync(path.join(installedDir, "references", "guide-link.md")),
        false,
      );
      assert.equal(result.skippedSymlinkCount, 1);
    }

    const conflict = installWorkspaceSkillFromPath({
      sourcePath: sourceSkillDir,
      workspaceRoot,
    });
    assert.equal(conflict.ok, false);
    assert.match(conflict.error, /already installed/);

    if (symlinkCreated) {
      const symlinkPath = path.join(tempRoot, "source-link");
      fs.symlinkSync(sourceSkillDir, symlinkPath);
      const symlinkResult = installWorkspaceSkillFromPath({
        sourcePath: symlinkPath,
        workspaceRoot,
        desiredId: "debug-helper-copy",
      });
      assert.equal(symlinkResult.ok, false);
      assert.match(symlinkResult.error, /symlink/);

      const symlinkScan = scanWorkspaceSkillCandidates(symlinkPath);
      assert.equal(symlinkScan.ok, false);
      assert.match(symlinkScan.error, /symlink/);
    }
  } finally {
    if (oldPocketAiHome === undefined) {
      delete process.env.POCKETAI_HOME;
    } else {
      process.env.POCKETAI_HOME = oldPocketAiHome;
    }
  }
});

test("workspace skill manager lists, disables, enables, and rejects unsafe targets", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pocketai-manage-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const skillDir = path.join(workspaceRoot, ".pocketai", "skills", "debug-helper");
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: debug-helper",
      "description: Debug helper workflow.",
      "metadata:",
      "  hermes:",
      "    tags: [debugging]",
      "    category: software-development",
      "---",
      "",
      "# Debug Helper",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(skillDir, "references", "guide.md"), "Guide");

  const initialList = manageWorkspaceSkill({
    workspaceRoots: [workspaceRoot],
    action: "list",
  });
  assert.equal(initialList.ok, true);
  assert.equal(initialList.skills.length, 1);
  assert.equal(initialList.skills[0].id, "debug-helper");
  assert.equal(initialList.skills[0].status, "enabled");
  assert.equal(initialList.skills[0].supportFileCount, 1);
  assert.equal(initialList.skills[0].category, "software-development");
  assert.deepEqual(initialList.skills[0].tags, ["debugging"]);

  const disabled = manageWorkspaceSkill({
    workspaceRoots: [workspaceRoot],
    action: "disable",
    skillId: "debug-helper",
    builtinSkillIds: ["builtin-debug"],
  });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.changed, true);
  assert.equal(fs.existsSync(path.join(skillDir, ".pocketai-disabled")), true);
  assert.equal(isWorkspaceSkillDisabled(skillDir), true);

  const disabledList = listManagedWorkspaceSkills([workspaceRoot]);
  assert.equal(disabledList.length, 1);
  assert.equal(disabledList[0].status, "disabled");

  const enabled = manageWorkspaceSkill({
    workspaceRoots: [workspaceRoot],
    action: "enable",
    skillId: "debug-helper",
  });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.changed, true);
  assert.equal(fs.existsSync(path.join(skillDir, ".pocketai-disabled")), false);
  assert.equal(isWorkspaceSkillDisabled(skillDir), false);

  const unknown = manageWorkspaceSkill({
    workspaceRoots: [workspaceRoot],
    action: "disable",
    skillId: "missing-skill",
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Unknown installed project skill/);

  const builtin = manageWorkspaceSkill({
    workspaceRoots: [workspaceRoot],
    action: "disable",
    skillId: "builtin-debug",
    builtinSkillIds: ["builtin-debug"],
  });
  assert.equal(builtin.ok, false);
  assert.match(builtin.error, /built-in skill/);

  let symlinkCreated = false;
  try {
    fs.symlinkSync(
      path.join(skillDir, "SKILL.md"),
      path.join(skillDir, ".pocketai-disabled"),
    );
    symlinkCreated = true;
  } catch {
    symlinkCreated = false;
  }
  if (symlinkCreated) {
    const symlinkEnable = manageWorkspaceSkill({
      workspaceRoots: [workspaceRoot],
      action: "enable",
      skillId: "debug-helper",
    });
    assert.equal(symlinkEnable.ok, false);
    assert.match(symlinkEnable.error, /symlink/);
  }
});

test("structured tools include skill management and browser tools", () => {
  const names = TOOL_DEFINITIONS.map((tool) => tool.function.name);
  assert.equal(names.includes("skill_view"), true);
  assert.equal(names.includes("skill_scan"), true);
  assert.equal(names.includes("skill_install"), true);
  assert.equal(names.includes("skill_manage"), true);
  assert.equal(names.includes("mcp_list_resources"), true);
  assert.equal(names.includes("mcp_read_resource"), true);
  assert.equal(names.includes("mcp_list_resource_templates"), true);
  assert.equal(names.includes("mcp_list_prompts"), true);
  assert.equal(names.includes("mcp_get_prompt"), true);
  assert.equal(names.includes("browser_navigate"), true);
  assert.equal(names.includes("browser_snapshot"), true);
  assert.equal(names.includes("browser_click"), true);
  assert.equal(names.includes("browser_type"), true);
  assert.equal(names.includes("browser_screenshot"), true);
  assert.equal(names.includes("browser_close"), true);

  const skillInstall = TOOL_DEFINITIONS.find(
    (tool) => tool.function.name === "skill_install",
  );
  assert.ok(skillInstall);
  assert.deepEqual(skillInstall.function.parameters.required, ["path"]);

  const skillManage = TOOL_DEFINITIONS.find(
    (tool) => tool.function.name === "skill_manage",
  );
  assert.ok(skillManage);
  assert.deepEqual(skillManage.function.parameters.required, ["action"]);

  const mcpReadResource = TOOL_DEFINITIONS.find(
    (tool) => tool.function.name === "mcp_read_resource",
  );
  assert.ok(mcpReadResource);
  assert.deepEqual(mcpReadResource.function.parameters.required, ["server", "uri"]);

  const mcpGetPrompt = TOOL_DEFINITIONS.find(
    (tool) => tool.function.name === "mcp_get_prompt",
  );
  assert.ok(mcpGetPrompt);
  assert.deepEqual(mcpGetPrompt.function.parameters.required, ["server", "name"]);

  const browserNavigate = TOOL_DEFINITIONS.find(
    (tool) => tool.function.name === "browser_navigate",
  );
  assert.ok(browserNavigate);
  assert.deepEqual(browserNavigate.function.parameters.required, ["url"]);

  const browserClick = TOOL_DEFINITIONS.find(
    (tool) => tool.function.name === "browser_click",
  );
  assert.ok(browserClick);
  assert.deepEqual(browserClick.function.parameters.required, ["ref"]);

  const browserType = TOOL_DEFINITIONS.find(
    (tool) => tool.function.name === "browser_type",
  );
  assert.ok(browserType);
  assert.deepEqual(browserType.function.parameters.required, ["text"]);
});

test("browser snapshot formatting is bounded and index/ref oriented", () => {
  const formatted = formatBrowserSnapshot({
    url: "http://localhost:3000/login",
    title: "Login",
    bodyText: "Welcome back",
    bodyTextTruncated: true,
    elementsTruncated: true,
    elements: [
      {
        ref: "7",
        tag: "input",
        role: "textbox",
        text: "",
        ariaLabel: "Email",
        placeholder: "name@example.com",
        inputType: "email",
        href: "",
        disabled: false,
        rect: { x: 10, y: 20, width: 200, height: 32 },
      },
      {
        ref: "8",
        tag: "button",
        role: "button",
        text: "Sign in",
        ariaLabel: "",
        placeholder: "",
        inputType: "",
        href: "",
        disabled: true,
        rect: { x: 10, y: 64, width: 100, height: 32 },
      },
    ],
  });

  assert.match(formatted, /Browser snapshot/);
  assert.match(formatted, /Body text \(truncated\):/);
  assert.match(formatted, /Interactive elements \(2, truncated\):/);
  assert.match(formatted, /\[1\] ref=7 <input> Email \(role=textbox, type=email\)/);
  assert.match(formatted, /\[2\] ref=8 <button> Sign in \(role=button, disabled\)/);
  assert.equal(normalizeBrowserUrl("localhost:3000"), "http://localhost:3000/");
  assert.throws(() => normalizeBrowserUrl("javascript:alert(1)"), /Unsupported/);
});

test("MCP formatting includes provenance, truncates text, and omits blobs", () => {
  const longText = "x".repeat(13000);
  const resourceOutput = formatMcpResourceRead("local", "file:///big.txt", {
    contents: [
      {
        uri: "file:///big.txt",
        mimeType: "text/plain",
        text: longText,
      },
      {
        uri: "file:///image.png",
        mimeType: "image/png",
        blob: "abcdef",
      },
    ],
  });

  assert.match(resourceOutput, /MCP resource from server "local": file:\/\/\/big\.txt/);
  assert.match(resourceOutput, /mime=text\/plain/);
  assert.match(resourceOutput, /\[truncated 1000 characters\]/);
  assert.match(resourceOutput, /binary\/blob content omitted/);
  assert.doesNotMatch(resourceOutput, /abcdef/);

  const promptOutput = formatMcpPromptGet("local", "review", {
    description: "Review prompt",
    messages: [
      { role: "user", content: { type: "text", text: "Review this" } },
    ],
  });
  assert.match(promptOutput, /MCP prompt from server "local": review/);
  assert.match(promptOutput, /Returned as tool output only/);
  assert.match(promptOutput, /Review this/);
});

test("MCP client paginates stdio tools, resources, and prompts", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pocketai-mcp-"));
  const serverPath = path.join(tempRoot, "server.cjs");
  fs.writeFileSync(
    serverPath,
    `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (!msg.id) return;
  const cursor = msg.params && msg.params.cursor;
  if (msg.method === "initialize") {
    send(msg.id, {
      protocolVersion: "2024-11-05",
      capabilities: { resources: {}, prompts: {}, tools: {} },
      instructions: "fake instructions"
    });
  } else if (msg.method === "tools/list") {
    send(msg.id, cursor
      ? { tools: [{ name: "tool-b", inputSchema: { type: "object", properties: {} } }] }
      : { tools: [{ name: "tool-a", inputSchema: { type: "object", properties: {} } }], nextCursor: "page-2" });
  } else if (msg.method === "resources/list") {
    send(msg.id, cursor
      ? { resources: [{ uri: "file:///b.txt", mimeType: "text/plain" }] }
      : { resources: [{ uri: "file:///a.txt", mimeType: "text/plain" }], nextCursor: "page-2" });
  } else if (msg.method === "resources/templates/list") {
    send(msg.id, { resourceTemplates: [{ uriTemplate: "file:///{name}.txt", name: "file" }] });
  } else if (msg.method === "prompts/list") {
    send(msg.id, cursor
      ? { prompts: [{ name: "prompt-b" }] }
      : { prompts: [{ name: "prompt-a" }], nextCursor: "page-2" });
  } else if (msg.method === "resources/read") {
    send(msg.id, { contents: [{ uri: msg.params.uri, mimeType: "text/plain", text: "hello" }] });
  } else if (msg.method === "prompts/get") {
    send(msg.id, { messages: [{ role: "user", content: { type: "text", text: "focus " + (msg.params.arguments && msg.params.arguments.focus) } }] });
  } else {
    send(msg.id, {});
  }
});
`,
  );

  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  let McpManager;
  try {
    ({ McpManager } = require("../dist/mcp-client.js"));
  } finally {
    Module._load = originalLoad;
  }

  const manager = new McpManager({ appendLine() {} });
  try {
    await manager.connectAll([
      { name: "fake", command: process.execPath, args: [serverPath] },
    ]);

    assert.deepEqual(manager.getConnectedServers(), ["fake"]);
    assert.equal(manager.getToolDefinitions().length, 2);
    assert.equal(manager.getServerMetadata("fake").protocolVersion, "2024-11-05");
    assert.equal(manager.getServerMetadata("fake").instructions, "fake instructions");

    const resources = await manager.listResources("fake");
    assert.deepEqual(
      resources[0].resources.map((resource) => resource.uri),
      ["file:///a.txt", "file:///b.txt"],
    );

    const templates = await manager.listResourceTemplates("fake");
    assert.equal(templates[0].templates[0].uriTemplate, "file:///{name}.txt");

    const prompts = await manager.listPrompts("fake");
    assert.deepEqual(
      prompts[0].prompts.map((prompt) => prompt.name),
      ["prompt-a", "prompt-b"],
    );

    const resource = await manager.readResource("fake", "file:///a.txt");
    assert.equal(resource.contents[0].text, "hello");

    const prompt = await manager.getPrompt("fake", "prompt-a", { focus: "security" });
    assert.equal(prompt.messages[0].content.text, "focus security");
  } finally {
    manager.disposeAll();
  }
});

test("stripFabricatedResults removes fake tool calls and fabricated dialogue", () => {
  const stripped = stripFabricatedResults(`
Real answer
@delete_file: src/nope.ts
@rename_file: src/a.ts src/b.ts
Assistant: and then everything worked
`);

  assert.equal(stripped, "Real answer");
});

test("assistant tool action summaries replace tool-only placeholders", () => {
  const summary = buildAssistantToolActionSummary([
    {
      id: "read-1",
      type: "read_file",
      filePath: "src/harness/provider.ts",
      status: "pending",
    },
    {
      id: "grep-1",
      type: "grep",
      filePath: "",
      pattern: "tool_summary_placeholder",
      glob: "src/**/*.ts",
      status: "pending",
    },
  ]);

  assert.equal(summary.kind, "tool_action");
  assert.equal(summary.label, "Searching context");
  assert.equal(summary.toolCount, 2);
  assert.equal(summary.actions[0].label, "Reading");
  assert.equal(summary.actions[0].target, "provider.ts");
  assert.equal(summary.actions[1].label, "Searching code");
  assert.match(summary.detail, /Reading provider\.ts/);
  assert.match(summary.detail, /Searching code tool_summary_placeholder/);

  const content = formatAssistantToolActionContent(summary);
  assert.match(content, /^\[PocketAI action: Searching context/);
  assert.equal(isAssistantToolActionPlaceholder(content), true);
  assert.equal(isAssistantToolActionPlaceholder("[Calling tools: read_file(src/a.ts)]"), true);
});

test("policy helpers classify risk and approvals conservatively", () => {
  assert.equal(classifyToolRisk("read_file"), "safe");
  assert.equal(classifyToolRisk("run_command"), "caution");
  assert.equal(classifyToolRisk("git_commit"), "destructive");
  assert.equal(classifyToolRisk("task"), "safe");
  assert.equal(classifyToolRisk("skill_scan"), "safe");
  assert.equal(classifyToolRisk("skill_install"), "caution");
  assert.equal(classifyToolRisk("skill_manage"), "caution");
  assert.equal(classifyToolRisk("mcp_list_resources"), "safe");
  assert.equal(classifyToolRisk("mcp_read_resource"), "caution");
  assert.equal(classifyToolRisk("browser_snapshot"), "safe");
  assert.equal(classifyToolRisk("browser_screenshot"), "safe");
  assert.equal(classifyToolRisk("browser_navigate"), "caution");
  assert.equal(classifyToolRisk("browser_click"), "caution");
  assert.equal(classifyToolRisk("browser_type"), "caution");
  assert.equal(classifyToolRisk("browser_close"), "caution");
  assert.equal(classifyToolRisk("memory_write"), "caution");
  assert.equal(classifyToolRisk("mcp__foo", true), "external");

  const safeRead = { type: "read_file", filePath: "src/a.ts" };
  const commandCall = { type: "run_command", filePath: "", command: "npm test" };
  const destructiveCommandCall = {
    type: "run_command",
    filePath: "",
    command: "rm -rf dist",
  };
  const commitCall = {
    type: "git_commit",
    filePath: "",
    commitMessage: "test",
  };
  const memoryWriteCall = {
    type: "memory_write",
    filePath: "",
    memoryType: "project",
    memoryName: "decision",
    memoryContent: "Use safe defaults",
  };
  const codeActionCall = {
    type: "apply_code_action",
    filePath: "src/a.ts",
    line: 1,
    character: 0,
    actionTitle: "Fix issue",
  };

  assert.equal(getToolApprovalDecision("ask", safeRead), "auto-execute");
  assert.equal(getToolApprovalDecision("ask", commandCall), "requires-approval");
  assert.equal(classifyShellCommandRisk("npm test"), "safe");
  assert.equal(classifyShellCommandRisk("npm install left-pad"), "network");
  assert.equal(classifyShellCommandRisk("rm -rf dist"), "destructive");
  assert.equal(classifyShellCommandRisk("npm run dev"), "long-running");
  assert.equal(classifyShellCommandRisk("echo hello > out.txt"), "writes");
  assert.equal(classifyShellCommandRisk("mkdir dist"), "writes");
  assert.equal(
    getToolApprovalDecision("ask", codeActionCall, { approvalPolicy: "mode-auto" }),
    "requires-approval",
  );
  assert.equal(
    getToolApprovalDecision("auto", codeActionCall, { approvalPolicy: "mode-auto" }),
    "auto-execute",
  );
  assert.equal(shouldAutoExecuteTool("auto", commandCall), true);
  assert.equal(shouldAutoExecuteTool("auto", destructiveCommandCall), false);
  assert.equal(
    shouldAutoExecuteTool("auto", commitCall, { approvalPolicy: "always-ask" }),
    false,
  );
  assert.equal(
    shouldAutoExecuteTool("auto", memoryWriteCall, { approvalPolicy: "always-ask" }),
    false,
  );
  assert.equal(shouldAutoExecuteTool("ask", commandCall), false);
  assert.equal(NON_DESTRUCTIVE_TOOL_TYPES.has("task"), true);
  assert.equal(NON_DESTRUCTIVE_TOOL_TYPES.has("skill_scan"), true);
  assert.equal(NON_DESTRUCTIVE_TOOL_TYPES.has("skill_install"), false);
  assert.equal(NON_DESTRUCTIVE_TOOL_TYPES.has("skill_manage"), false);
  assert.equal(NON_DESTRUCTIVE_TOOL_TYPES.has("mcp_list_prompts"), true);
  assert.equal(NON_DESTRUCTIVE_TOOL_TYPES.has("mcp_get_prompt"), false);
  assert.equal(NON_DESTRUCTIVE_TOOL_TYPES.has("browser_snapshot"), true);
  assert.equal(NON_DESTRUCTIVE_TOOL_TYPES.has("browser_screenshot"), true);
  assert.equal(NON_DESTRUCTIVE_TOOL_TYPES.has("browser_navigate"), false);
  assert.equal(NON_DESTRUCTIVE_TOOL_TYPES.has("browser_click"), false);
  assert.equal(NON_DESTRUCTIVE_TOOL_TYPES.has("browser_type"), false);
  assert.equal(NON_DESTRUCTIVE_TOOL_TYPES.has("browser_close"), false);
  assert.equal(isReadonlySubagentTool("read_file"), true);
  assert.equal(isReadonlySubagentTool("skill_scan"), true);
  assert.equal(isReadonlySubagentTool("skill_install"), false);
  assert.equal(isReadonlySubagentTool("mcp_list_resources"), true);
  assert.equal(isReadonlySubagentTool("mcp_read_resource"), false);
  assert.equal(isReadonlySubagentTool("browser_snapshot"), true);
  assert.equal(isReadonlySubagentTool("browser_screenshot"), true);
  assert.equal(isReadonlySubagentTool("browser_navigate"), false);
  assert.equal(isReadonlySubagentTool("browser_click"), false);
  assert.equal(isReadonlySubagentTool("browser_type"), false);
  assert.equal(isReadonlySubagentTool("browser_close"), false);
  assert.equal(isReadonlySubagentTool("edit_file"), false);
  assert.equal(isReadonlySubagentTool("task"), false);
  assert.equal(isAllowedSubagentTool({ subagentReadonly: true }, "edit_file"), false);
  assert.equal(isAllowedSubagentTool({ subagentReadonly: false }, "edit_file"), true);
  assert.equal(isAllowedSubagentTool({ subagentReadonly: false }, "run_command"), false);
  assert.equal(isAllowedSubagentPath(["src/features"], "src/features/a.ts"), true);
  assert.equal(isAllowedSubagentPath(["src/features"], "src/other/a.ts"), false);
});

test("permission workflow helpers support wildcard and command-risk rules", () => {
  assert.equal(
    matchesPermissionRule("read_file(src/**)", {
      toolType: "read_file",
      toolArg: "src/index.ts",
    }),
    true,
  );
  assert.equal(
    matchesPermissionRule("read_file(src/**)", {
      toolType: "read_file",
      toolArg: "package.json",
    }),
    false,
  );
  assert.equal(
    matchesPermissionRule("run_command:network(*)", {
      toolType: "run_command",
      toolArg: "npm install left-pad",
      commandRisk: "network",
    }),
    true,
  );
  assert.equal(
    matchesPermissionRule("run_command:network(*)", {
      toolType: "run_command",
      toolArg: "npm test",
      commandRisk: "safe",
    }),
    false,
  );
  assert.equal(
    evaluatePermissionRules(
      ["run_command:safe(npm test)"],
      ["run_command:network(*)"],
      {
        toolType: "run_command",
        toolArg: "npm install left-pad",
        commandRisk: "network",
      },
    ),
    "deny",
  );
  assert.equal(
    evaluatePermissionRules(
      ["run_command:safe(npm test)"],
      ["run_command:network(*)"],
      {
        toolType: "run_command",
        toolArg: "npm test",
        commandRisk: "safe",
      },
    ),
    "allow",
  );
  assert.equal(
    getToolPermissionArg({
      type: "task",
      filePath: "",
      taskPrompt: "inspect permissions",
      status: "pending",
    }),
    "inspect permissions",
  );
  assert.equal(
    buildRememberedPermissionRule(
      {
        type: "run_command",
        filePath: "",
        command: "npm install left-pad",
        status: "pending",
      },
      "command-risk",
      "network",
    ),
    "run_command:network(*)",
  );
  assert.equal(
    buildRememberedPermissionRule(
      {
        type: "read_file",
        filePath: "src/index.ts",
        status: "pending",
      },
      "path",
    ),
    "read_file(src/index.ts)",
  );
});

test("isInsidePath rejects sibling paths with shared prefixes", () => {
  assert.equal(isInsidePath("/tmp/repo", "/tmp/repo/src/index.ts"), true);
  assert.equal(isInsidePath("/tmp/repo", "/tmp/repo"), true);
  assert.equal(isInsidePath("/tmp/repo", "/tmp/repo-other/secret.ts"), false);
  assert.equal(isInsidePath("/tmp/repo", "/tmp/repo/../repo-other/secret.ts"), false);
});

test("bridge tool shim extracts PocketAI tool envelopes", async () => {
  const {
    buildStructuredToolBridgeInstructions,
    extractStructuredToolCalls,
    toOpenAiToolCalls,
  } = await import("../scripts/bridge-tool-shim.mjs");

  const instructions = buildStructuredToolBridgeInstructions([
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file.",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ]);
  assert.match(instructions, /PocketAI Structured Tool Bridge/);
  assert.match(instructions, /read_file/);

  const extracted = extractStructuredToolCalls(`
Checking first.
<POCKETAI_TOOL_CALLS>{"tool_calls":[{"name":"read_file","arguments":{"path":"src/index.ts"}}]}</POCKETAI_TOOL_CALLS>
`);
  assert.equal(extracted.text, "Checking first.");
  assert.deepEqual(extracted.toolCalls, [
    { name: "read_file", arguments: { path: "src/index.ts" } },
  ]);

  const openAiCalls = toOpenAiToolCalls(extracted.toolCalls, () => "call_test");
  assert.deepEqual(openAiCalls, [
    {
      id: "call_test",
      type: "function",
      function: {
        name: "read_file",
        arguments: "{\"path\":\"src/index.ts\"}",
      },
    },
  ]);
});

test("turn policy classifies errors and recovery limits correctly", () => {
  assert.deepEqual(
    classifyHarnessError(new Error("Maximum context length exceeded")),
    {
      kind: "context-pressure",
      message: "Maximum context length exceeded",
    },
  );
  assert.deepEqual(
    classifyHarnessError(new Error("503 temporarily unavailable")),
    {
      kind: "transient",
      message: "503 temporarily unavailable",
    },
  );
  assert.deepEqual(
    classifyHarnessError(new Error("something else")),
    {
      kind: "generic",
      message: "something else",
    },
  );

  const baseLoopState = {
    previousToolKeys: new Set(),
    fileReadCounts: new Map(),
    nudgedReadLoopFiles: new Set(),
    repeatedToolRecoveryUsed: false,
    contextCompactions: 0,
    consecutiveModelErrors: { count: 0, maxRetries: 1 },
    consecutiveToolFailures: { count: 0, maxRetries: 1 },
  };

  assert.equal(canRecoverRepeatedToolLoop(baseLoopState), true);
  assert.equal(canRecoverReadLoop(baseLoopState, "src/a.ts"), true);
  assert.equal(canCompactForContextRecovery(baseLoopState), true);

  baseLoopState.repeatedToolRecoveryUsed = true;
  baseLoopState.nudgedReadLoopFiles.add("src/a.ts");
  baseLoopState.contextCompactions = 2;

  assert.equal(canRecoverRepeatedToolLoop(baseLoopState), false);
  assert.equal(canRecoverReadLoop(baseLoopState, "src/a.ts"), false);
  assert.equal(canCompactForContextRecovery(baseLoopState), false);
  assert.equal(
    shouldSurfaceRetryErrorInTranscript({
      kind: "transient",
      message: "fetch failed",
    }),
    false,
  );
  assert.equal(
    shouldSurfaceRetryErrorInTranscript({
      kind: "generic",
      message: "something else",
    }),
    true,
  );
});

test("provider capabilities and chat controls honor provider kind and codex reasoning", () => {
  assert.equal(
    getEndpointProviderKind("http://127.0.0.1:39457/"),
    "local-pocketai",
  );
  assert.equal(
    getEndpointProviderKind("http://127.0.0.1:39458"),
    "codex-bridge",
  );
  assert.equal(
    getEndpointProviderKind("http://127.0.0.1:39460"),
    "claude-bridge",
  );
  assert.equal(
    getEndpointProviderKind("http://127.0.0.1:39461"),
    "cursor-bridge",
  );
  assert.equal(
    getEndpointProviderKind("http://127.0.0.1:39462"),
    "opencode-bridge",
  );
  assert.equal(
    getEndpointProviderKind("http://127.0.0.1:39464"),
    "deepseek-bridge",
  );
  assert.equal(
    getEndpointProviderKind("https://example.com/v1"),
    "openai-compatible",
  );
  assert.equal(
    getEndpointProviderKind("https://opencode.ai/zen/go"),
    "openai-compatible",
  );

  assert.deepEqual(
    getEndpointCapabilities("http://127.0.0.1:39458"),
    {
      kind: "codex-bridge",
      label: "Codex Bridge",
      description: "Codex bridge endpoint with model and reasoning controls",
      supportsStructuredTools: true,
      supportsReasoningEffort: true,
      requiresBridgeBootstrap: true,
      usesReportedUsageForContext: false,
    },
  );
  assert.deepEqual(
    getEndpointCapabilities("http://127.0.0.1:39460"),
    {
      kind: "claude-bridge",
      label: "Claude Bridge",
      description: "Claude bridge endpoint with PocketAI-compatible tools",
      supportsStructuredTools: true,
      supportsReasoningEffort: false,
      requiresBridgeBootstrap: true,
      usesReportedUsageForContext: false,
    },
  );
  assert.deepEqual(
    getEndpointCapabilities("http://127.0.0.1:39461"),
    {
      kind: "cursor-bridge",
      label: "Cursor Bridge",
      description: "Cursor bridge endpoint with Composer model controls",
      supportsStructuredTools: true,
      supportsReasoningEffort: false,
      requiresBridgeBootstrap: true,
      usesReportedUsageForContext: false,
    },
  );
  assert.deepEqual(
    getEndpointCapabilities("http://127.0.0.1:39462"),
    {
      kind: "opencode-bridge",
      label: "OpenCode Bridge",
      description: "OpenCode bridge endpoint with provider/model controls",
      supportsStructuredTools: true,
      supportsReasoningEffort: false,
      requiresBridgeBootstrap: true,
      usesReportedUsageForContext: false,
    },
  );
  assert.deepEqual(
    getEndpointCapabilities("http://127.0.0.1:39464"),
    {
      kind: "deepseek-bridge",
      label: "DeepSeek Bridge",
      description: "DeepSeek V4 API bridge with provider/model controls",
      supportsStructuredTools: true,
      supportsReasoningEffort: true,
      requiresBridgeBootstrap: true,
      usesReportedUsageForContext: false,
    },
  );
  assert.deepEqual(
    getEndpointCapabilities("https://example.com/v1", {
      structuredToolsEnabled: false,
    }),
    {
      kind: "openai-compatible",
      label: "OpenAI-compatible",
      description: "OpenAI-compatible chat endpoint",
      supportsStructuredTools: false,
      supportsReasoningEffort: false,
      requiresBridgeBootstrap: false,
      usesReportedUsageForContext: true,
    },
  );
  assert.deepEqual(
    getEndpointCapabilities("https://opencode.ai/zen/go"),
    {
      kind: "openai-compatible",
      label: "OpenAI-compatible",
      description: "OpenAI-compatible chat endpoint",
      supportsStructuredTools: true,
      supportsReasoningEffort: false,
      requiresBridgeBootstrap: false,
      usesReportedUsageForContext: false,
    },
  );

  const codexState = {
    models: [
      {
        id: "gpt-5.4",
        isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast" },
          { reasoningEffort: "high", description: "Thorough" },
        ],
      },
      {
        id: "gpt-5.4-mini",
        isDefault: false,
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast" },
        ],
      },
    ],
  };

  assert.deepEqual(
    buildCodexReasoningControlsState({
      selectedModel: "gpt-5.4",
      selectedReasoningEffort: "high",
      codexState,
    }),
    {
      selectedReasoningEffort: "high",
      reasoningOptions: ["low", "high"],
    },
  );
  assert.deepEqual(
    buildCodexReasoningControlsState({
      selectedModel: "gpt-5.4-mini",
      selectedReasoningEffort: "high",
      codexState,
    }),
    {
      selectedReasoningEffort: "",
      reasoningOptions: ["low"],
    },
  );

  const localSession = createSession({
    selectedModel: "qwen",
    selectedReasoningEffort: "high",
  });
  assert.deepEqual(
    buildProviderChatControlsState({
      endpointUrl: "http://127.0.0.1:39457",
      availableModels: ["qwen"],
      session: localSession,
    }),
    {
      models: ["qwen"],
      selectedModel: "qwen",
      providerKind: "local-pocketai",
      providerLabel: "Local LLM",
      providerDescription: "Local PocketAI-compatible endpoint",
      selectedReasoningEffort: "",
      showReasoningControl: false,
      reasoningOptions: [],
    },
  );

  const codexSession = createSession({
    selectedModel: "gpt-5.4",
    selectedReasoningEffort: "high",
  });
  assert.deepEqual(
    buildProviderChatControlsState({
      endpointUrl: "http://127.0.0.1:39458",
      availableModels: ["gpt-5.4", "gpt-5.4-mini"],
      session: codexSession,
      codexState,
    }),
    {
      models: ["gpt-5.4", "gpt-5.4-mini"],
      selectedModel: "gpt-5.4",
      providerKind: "codex-bridge",
      providerLabel: "Codex Bridge",
      providerDescription: "Codex bridge endpoint with model and reasoning controls",
      selectedReasoningEffort: "high",
      showReasoningControl: true,
      reasoningOptions: ["low", "high"],
    },
  );

  const deepseekSession = createSession({
    selectedModel: "deepseek-v4-pro",
    selectedReasoningEffort: "max",
  });
  assert.deepEqual(
    buildProviderChatControlsState({
      endpointUrl: "http://127.0.0.1:39464",
      availableModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
      session: deepseekSession,
    }),
    {
      models: ["deepseek-v4-pro", "deepseek-v4-flash"],
      selectedModel: "deepseek-v4-pro",
      providerKind: "deepseek-bridge",
      providerLabel: "DeepSeek Bridge",
      providerDescription: "DeepSeek V4 API bridge with provider/model controls",
      selectedReasoningEffort: "max",
      showReasoningControl: true,
      reasoningOptions: ["high", "max"],
    },
  );
});

test("session persistence strips large payloads and restores interrupted jobs safely", () => {
  const session = createSession({
    worktreeRoot: "/tmp/project/.pocketai/worktrees/feature-a",
    transcript: [
      {
        role: "user",
        content: "hello",
        images: [{ data: "base64data", mimeType: "image/png" }],
        files: [
          {
            name: "big.txt",
            mimeType: "text/plain",
            content: "raw file contents",
            sizeBytes: 17,
          },
        ],
      },
    ],
    harnessState: {
      pendingApprovals: [],
      pendingDiffs: [],
      todoItems: [],
      backgroundTasks: [
        {
          id: "bg-running",
          command: "npm test",
          status: "running",
          outputPreview: "still going",
          updatedAt: 1,
          cwd: "/tmp/project",
        },
        {
          id: "bg-complete",
          command: "npm run build",
          status: "completed",
          outputPreview: "x".repeat(5005),
          updatedAt: 2,
        },
      ],
    },
  });

  const persisted = serializeSessionForPersistence(session);
  assert.equal(persisted.transcript[0].images[0].data, "");
  assert.equal(persisted.transcript[0].files[0].content, "");
  assert.equal(persisted.worktreeRoot, "/tmp/project/.pocketai/worktrees/feature-a");
  assert.equal(persisted.backgroundTasks[1].outputPreview.length, 4000);

  const restored = restoreSessionFromPersistence(persisted);
  assert.equal(restored.hadRunningBackgroundTasks, true);
  assert.equal(restored.session.busy, false);
  assert.match(restored.session.status, /1 background command was interrupted/);
  assert.match(restored.session.transcript.at(-1).content, /PocketAI restored this chat/);
  assert.match(restored.session.transcript.at(-1).content, /\/jobs rerun/);
  assert.equal(restored.session.worktreeRoot, "/tmp/project/.pocketai/worktrees/feature-a");
  assert.equal(restored.session.activeSkills.length, 0);
  assert.equal(restored.session.harnessState.backgroundTasks[1].status, "interrupted");
  assert.match(
    restored.session.harnessState.backgroundTasks[1].outputPreview,
    /\[Interrupted after PocketAI reload\]/,
  );
  assert.equal(
    restored.session.harnessState.backgroundTasks[1].cwd,
    "/tmp/project",
  );
});

test("restorePersistedBackgroundTasks filters invalid items and keeps newest 20", () => {
  const tasks = Array.from({ length: 25 }, (_, index) => ({
    id: `task-${index}`,
    command: index === 3 ? "" : `cmd-${index}`,
    status: "completed",
    outputPreview: `out-${index}`,
    updatedAt: index,
  }));

  const restored = restorePersistedBackgroundTasks(tasks);
  assert.equal(restored.length, 20);
  assert.equal(restored[0].id, "task-24");
  assert.equal(restored.at(-1).id, "task-5");
  assert.equal(restored.some((task) => task.id === "task-3"), false);
});

test("session persistence helpers derive last model and preferred model consistently", () => {
  const sessions = [
    createSession({ selectedModel: "model-old", updatedAt: 10 }),
    createSession({ selectedModel: "model-new", updatedAt: 20 }),
    createSession({ selectedModel: "", updatedAt: 30 }),
  ];

  assert.equal(deriveLastSelectedModel("saved-model", sessions), "saved-model");
  assert.equal(deriveLastSelectedModel("", sessions), "model-new");
  assert.equal(
    getPreferredModelForNewSession(["saved-model", "fallback"], "saved-model", sessions),
    "saved-model",
  );
  assert.equal(
    getPreferredModelForNewSession(["model-new", "fallback"], "", sessions),
    "model-new",
  );
  assert.equal(
    getPreferredModelForNewSession(["fallback-a", "fallback-b"], "", sessions),
    "fallback-a",
  );
});

test("slash command helpers parse jobs subcommands and format core reports", () => {
  assert.deepEqual(parseJobsCommandArg(""), { type: "list" });
  assert.deepEqual(parseJobsCommandArg("clear"), { type: "clear" });
  assert.deepEqual(parseJobsCommandArg("cancel bg_123"), {
    type: "cancel",
    taskId: "bg_123",
  });
  assert.deepEqual(parseJobsCommandArg("rerun bg_456"), {
    type: "rerun",
    taskId: "bg_456",
  });
  assert.deepEqual(parseJobsCommandArg("bg_789"), {
    type: "details",
    taskId: "bg_789",
  });

  const endpoints = [
    {
      name: "Local PocketAI",
      url: "http://127.0.0.1:39457",
      healthy: true,
      lastChecked: 1,
    },
    {
      name: "Codex Bridge",
      url: "http://127.0.0.1:39458",
      healthy: false,
      lastChecked: 2,
    },
  ];
  assert.equal(findEndpointMatch(endpoints, "codex bridge")?.url, "http://127.0.0.1:39458");
  assert.equal(findEndpointMatch(endpoints, "http://127.0.0.1:39457/")?.name, "Local PocketAI");
  assert.equal(findEndpointMatch(endpoints, "missing"), undefined);

  const endpointList = formatEndpointList(endpoints, "http://127.0.0.1:39458");
  assert.match(endpointList, /\* \*\*Codex Bridge\*\*/);
  assert.match(endpointList, /Local PocketAI/);

  const taskList = formatTrackedTasks([
    { content: "pending item", status: "pending" },
    { content: "active item", status: "in_progress" },
    { content: "done item", status: "completed" },
  ]);
  assert.match(taskList, /\[ \] pending item/);
  assert.match(taskList, /\[~\] active item/);
  assert.match(taskList, /\[x\] done item/);

  const backgroundList = formatBackgroundTaskList([
    { id: "bg1", command: "npm test", status: "running" },
    { id: "bg2", command: "npm run build", status: "failed" },
  ]);
  assert.match(backgroundList, /Command tasks:/);
  assert.match(backgroundList, /`bg1` \[background, running\] `npm test`/);
  assert.match(backgroundList, /\/jobs clear/);

  const doctorReport = buildDoctorReport({
    endpointName: "Codex Bridge",
    endpointUrl: "http://127.0.0.1:39458",
    providerKind: "codex-bridge",
    providerLabel: "Codex Bridge",
    providerDescription: "Codex bridge endpoint with model and reasoning controls",
    healthy: false,
    selectedModel: "gpt-5.4",
    mode: "auto",
    supportsStructuredTools: false,
    supportsReasoningEffort: true,
    activeSkills: [{ id: "debug", name: "Debug" }],
    todoItems: [{ content: "check issue", status: "in_progress" }],
    pendingApprovalCount: 2,
    backgroundTaskCount: 3,
    estimatedTokens: 12345,
    contextWindowSize: 32000,
    runtimeHealth: {
      level: "warning",
      summary: "Harness has pending work.",
      issues: ["2 approvals waiting."],
      suggestions: ["Review the approval cards."],
      actions: ["show-jobs"],
    },
  });
  assert.match(doctorReport, /PocketAI doctor:/);
  assert.match(doctorReport, /Provider: Codex Bridge \(`codex-bridge`\)/);
  assert.match(doctorReport, /Provider detail: Codex bridge endpoint/);
  assert.match(doctorReport, /Active skills: Debug/);
  assert.match(doctorReport, /Suggested next actions:/);

  assert.equal(getSessionTitlesStatus(["Chat 1", "Chat 2"]), "Sessions: Chat 1, Chat 2");
});

test("worktree workflow helpers resolve status, enter, and exit actions", () => {
  assert.equal(normalizeWorktreeName("enter feature/payment flow"), "feature-payment-flow");
  assert.equal(
    getPocketAiWorktreeRoot("/tmp/repo", "feature-a"),
    "/tmp/repo/.pocketai/worktrees/feature-a",
  );

  const status = resolveWorktreeSlashCommand({
    session: createSession(),
    arg: "",
    workspaceRoot: "/tmp/repo",
    pathExists: () => false,
  });
  assert.equal(status.kind, "status");
  assert.match(status.transcriptEntry.content, /No active worktree/);

  const enter = resolveWorktreeSlashCommand({
    session: createSession(),
    arg: "feature-a",
    workspaceRoot: "/tmp/repo",
    pathExists: () => false,
  });
  assert.equal(enter.kind, "enter");
  assert.equal(enter.name, "feature-a");
  assert.equal(enter.branchName, "pocketai/feature-a");
  assert.equal(enter.worktreeRoot, "/tmp/repo/.pocketai/worktrees/feature-a");
  assert.equal(enter.exists, false);

  const exit = resolveWorktreeSlashCommand({
    session: createSession({ worktreeRoot: "/tmp/repo/.pocketai/worktrees/feature-a" }),
    arg: "exit",
    workspaceRoot: "/tmp/repo",
    pathExists: () => true,
  });
  assert.equal(exit.kind, "exit");
  assert.match(exit.status, /Exited worktree mode/);
});

test("session workspace root resolution prefers safe active worktrees", () => {
  assert.equal(
    resolveSessionWorkspaceRoot(
      "/tmp/repo",
      "/tmp/repo/.pocketai/worktrees/feature-a",
    ),
    "/tmp/repo/.pocketai/worktrees/feature-a",
  );
  assert.equal(
    resolveSessionWorkspaceRoot("/tmp/repo", "/tmp/outside"),
    "/tmp/repo",
  );
  assert.equal(
    resolveSessionWorkspaceRoot("/tmp/repo", ""),
    "/tmp/repo",
  );
  assert.equal(
    resolveSessionWorkspaceRoot(undefined, "/tmp/repo/.pocketai/worktrees/feature-a"),
    "/tmp/repo/.pocketai/worktrees/feature-a",
  );
});

test("session workflow helpers normalize titles and auto-title only default chats", () => {
  assert.equal(
    normalizeRenamedSessionTitle("   My    renamed   chat   "),
    "My renamed chat",
  );
  assert.equal(
    resolveRenamedSessionTitle("Chat 4", "   Chat    4   "),
    undefined,
  );
  assert.equal(
    resolveRenamedSessionTitle("Chat 4", "  Feature   planning  "),
    "Feature planning",
  );

  assert.equal(
    resolveAutoSessionTitle("Chat 7", "Implement a compact harness panel for jobs", 7),
    "Implement a compact harness pane...",
  );
  assert.equal(
    resolveAutoSessionTitle("PocketAI Code", "Implement a compact harness panel for jobs", 7),
    "Implement a compact harness pane...",
  );
  assert.equal(
    resolveAutoSessionTitle("Codex migration notes", "Implement a compact harness panel", 7),
    undefined,
  );
});

test("session workflow helpers keep sidebar and deletion fallback aligned to recency", () => {
  const sessions = [
    { id: "older", updatedAt: 10, title: "Older", transcript: [{ role: "user", content: "older" }] },
    { id: "newer", updatedAt: 30, title: "Newer", transcript: [{ role: "user", content: "newer" }] },
    { id: "middle", updatedAt: 20, title: "Middle", transcript: [{ role: "user", content: "middle" }] },
  ];

  assert.deepEqual(
    sortSessionsByRecency(sessions).map((session) => session.id),
    ["newer", "middle", "older"],
  );
  assert.deepEqual(
    buildSessionSummaries(sessions).map((session) => session.id),
    ["newer", "middle", "older"],
  );
  assert.equal(resolveSidebarSessionId("missing", sessions), "newer");
  assert.equal(resolveSidebarSessionId("middle", sessions), "middle");

  assert.deepEqual(
    resolveSessionDeletion("newer", "newer", sessions.filter((session) => session.id !== "newer")),
    {
      fallbackSessionId: "middle",
      nextSidebarSessionId: "middle",
    },
  );
  assert.deepEqual(
    resolveSessionDeletion("newer", "older", sessions.filter((session) => session.id !== "newer")),
    {
      fallbackSessionId: "middle",
      nextSidebarSessionId: "older",
    },
  );
});

test("session workflow helpers treat empty drafts as not started", () => {
  assert.equal(hasSessionStarted([]), false);
  assert.equal(
    hasSessionStarted([{ role: "assistant", content: "hello" }]),
    false,
  );
  assert.equal(
    hasSessionStarted([{ role: "user", content: "hello" }]),
    true,
  );
  assert.deepEqual(
    buildSessionSummaries([
      { id: "draft", title: "PocketAI Code", updatedAt: 20, transcript: [] },
      { id: "started", title: "Started", updatedAt: 10, transcript: [{ role: "user", content: "hi" }] },
    ]).map((session) => session.id),
    ["started"],
  );
});

test("endpoint workflow helpers resolve active endpoint and sync sessions cleanly", () => {
  const endpoints = [
    { name: "Local PocketAI", url: "http://127.0.0.1:39457/" },
    { name: "Codex Bridge", url: "http://127.0.0.1:39458/" },
  ];

  assert.equal(
    resolveActiveEndpointUrl({
      endpoints,
      currentActiveEndpointUrl: "http://127.0.0.1:39458",
      storedActiveEndpointUrl: "http://127.0.0.1:39457",
      fallbackUrl: "http://fallback",
    }),
    "http://127.0.0.1:39458",
  );
  assert.equal(
    resolveActiveEndpointUrl({
      endpoints,
      currentActiveEndpointUrl: "http://missing",
      storedActiveEndpointUrl: "http://127.0.0.1:39457/",
      fallbackUrl: "http://fallback",
    }),
    "http://127.0.0.1:39457",
  );
  assert.equal(
    resolveActiveEndpointUrl({
      endpoints: [],
      currentActiveEndpointUrl: "",
      storedActiveEndpointUrl: "",
      fallbackUrl: "http://fallback/",
    }),
    "http://fallback",
  );

  const sessions = [
    { selectedEndpoint: "http://127.0.0.1:39457" },
    { selectedEndpoint: "" },
  ];
  assert.equal(
    syncSessionsToActiveEndpoint(sessions, "http://127.0.0.1:39458"),
    true,
  );
  assert.deepEqual(
    sessions.map((session) => session.selectedEndpoint),
    ["http://127.0.0.1:39458", "http://127.0.0.1:39458"],
  );
  assert.equal(
    syncSessionsToActiveEndpoint(sessions, "http://127.0.0.1:39458"),
    false,
  );
});

test("endpoint workflow helpers reset invalid model state and preserve valid selections", () => {
  const sessions = [
    {
      selectedModel: "missing-model",
      selectedReasoningEffort: "high",
      status: "Old status",
    },
    {
      selectedModel: "gpt-5.4",
      selectedReasoningEffort: "medium",
      status: "Stale",
    },
    {
      selectedModel: "",
      selectedReasoningEffort: "",
      status: "Empty",
    },
  ];

  assert.equal(buildConnectedSessionStatus(2), "Connected — 2 models available");
  assert.equal(buildConnectedSessionStatus(0), "Server reachable, but no models found.");

  assert.equal(
    applyRefreshedModelsToSessions(
      sessions,
      ["gpt-5.4", "gpt-5.4-mini"],
      () => "gpt-5.4-mini",
    ),
    true,
  );
  assert.deepEqual(sessions, [
    {
      selectedModel: "gpt-5.4-mini",
      selectedReasoningEffort: "",
      status: "Connected — 2 models available",
    },
    {
      selectedModel: "gpt-5.4",
      selectedReasoningEffort: "medium",
      status: "Connected — 2 models available",
    },
    {
      selectedModel: "gpt-5.4-mini",
      selectedReasoningEffort: "",
      status: "Connected — 2 models available",
    },
  ]);

  assert.equal(
    applyRefreshedModelsToSessions(
      sessions,
      ["gpt-5.4", "gpt-5.4-mini"],
      () => "gpt-5.4-mini",
    ),
    false,
  );
});

test("chat workflow helpers share mode labels, export formatting, search, and task clearing", () => {
  assert.equal(
    getInteractionModeStatus("ask"),
    "Ask mode — I'll ask before making changes.",
  );
  assert.equal(
    getInteractionModeStatus("auto"),
    "Auto mode — changes applied automatically.",
  );
  assert.equal(
    buildSessionExportFileName("Chat: Review / Fix"),
    "Chat__Review___Fix.md",
  );
  assert.match(
    buildSessionExportMarkdown([
      { role: "system", content: "ignored" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]),
    /## You[\s\S]*Hello[\s\S]*## PocketAI[\s\S]*Hi there/,
  );

  const summaries = [
    { id: "s1", title: "Review auth flow", updatedAt: 2 },
    { id: "s2", title: "Bug hunt", updatedAt: 1 },
  ];
  const sessions = [
    {
      id: "s1",
      transcript: [{ role: "assistant", content: "All good here" }],
    },
    {
      id: "s2",
      transcript: [{ role: "user", content: "Need help with auth token bug" }],
    },
  ];
  assert.deepEqual(
    filterSessionSummariesByQuery("auth", summaries, sessions).map((session) => session.id),
    ["s1", "s2"],
  );
  assert.deepEqual(
    filterSessionSummariesByQuery("missing", summaries, sessions),
    [],
  );

  const finishedIds = getFinishedBackgroundTaskIds([
    { id: "bg1", status: "running" },
    { id: "bg2", status: "completed" },
    { id: "bg3", status: "failed" },
  ]);
  assert.deepEqual(finishedIds, ["bg2", "bg3"]);
  assert.equal(
    buildClearedBackgroundTasksMessage(2),
    "Cleared 2 finished background commands.",
  );
});

test("panel session workflow helpers bind, rebind, and query panel mappings", () => {
  const bindings = new Map([
    ["panel-a", "session-1"],
    ["panel-b", "session-2"],
  ]);

  assert.equal(
    bindPanelToSession(bindings, "panel-c", "missing", ["session-1", "session-2"]),
    false,
  );
  assert.equal(
    bindPanelToSession(bindings, "panel-c", "session-2", ["session-1", "session-2"]),
    true,
  );
  assert.deepEqual(
    getPanelsBoundToSession(bindings, "session-2"),
    ["panel-b", "panel-c"],
  );
  assert.deepEqual(
    rebindDeletedSessionPanels(bindings, "session-2", "session-3"),
    ["panel-b", "panel-c"],
  );
  assert.deepEqual(
    Array.from(bindings.entries()),
    [
      ["panel-a", "session-1"],
      ["panel-b", "session-3"],
      ["panel-c", "session-3"],
    ],
  );
});

test("tool approval workflow helpers resolve transcript entries and status transitions", () => {
  const transcript = [
    {
      role: "assistant",
      content: "Working",
      toolCalls: [
        {
          id: "tc-1",
          type: "edit_file",
          filePath: "src/app.ts",
          status: "pending",
        },
        {
          id: "tc-2",
          type: "read_file",
          filePath: "src/app.ts",
          status: "executed",
        },
      ],
    },
  ];

  const resolved = findToolCallInTranscript(transcript, "tc-1");
  assert.equal(resolved.toolCall.id, "tc-1");
  assert.equal(findToolCallInTranscript(transcript, "missing"), undefined);
  assert.equal(areToolCallsResolved(transcript[0].toolCalls), false);

  applyExecutedToolCallResult(resolved.toolCall, transcript, "done");
  assert.equal(resolved.toolCall.status, "executed");
  assert.equal(transcript.at(-1).content, "done");

  const erroredTool = {
    id: "tc-3",
    type: "write_file",
    filePath: "src/app.ts",
    status: "approved",
  };
  applyErroredToolCallResult(erroredTool, transcript, new Error("boom"));
  assert.equal(erroredTool.status, "error");
  assert.equal(erroredTool.result, "Tool execution error: boom");

  const rejectedTool = {
    id: "tc-4",
    type: "edit_file",
    filePath: "src/app.ts",
    status: "pending",
  };
  applyRejectedToolCallResult(rejectedTool, transcript);
  assert.equal(rejectedTool.status, "rejected");
  assert.equal(rejectedTool.result, "Edit rejected by user.");

  const staleTool = {
    id: "tc-stale",
    type: "edit_file",
    filePath: "src/app.ts",
    status: "pending",
  };
  applyStaleToolCallResult(staleTool, transcript);
  assert.equal(staleTool.status, "error");
  assert.equal(staleTool.result, "Edit became stale before approval.");
  assert.match(transcript.at(-1).content, /no longer matches/);

  assert.equal(buildToolExecutionErrorMessage("oops"), "Tool execution error.");
  assert.equal(
    areToolCallsResolved([
      { id: "a", type: "read_file", filePath: "", status: "executed" },
      { id: "b", type: "edit_file", filePath: "", status: "rejected" },
      { id: "c", type: "write_file", filePath: "", status: "error" },
    ]),
    true,
  );
  assert.equal(
    shouldContinueAfterToolResolution(
      [
        { id: "a", type: "read_file", filePath: "", status: "executed" },
      ],
      false,
    ),
    true,
  );
  assert.equal(
    shouldContinueAfterToolResolution(
      [
        { id: "a", type: "read_file", filePath: "", status: "pending" },
      ],
      false,
    ),
    false,
  );
});

test("run loop workflow helpers share cancellation and failure outcomes", () => {
  assert.deepEqual(buildCancelledLoopOutcome(), {
    status: "Cancelled.",
    transcriptEntry: {
      role: "assistant",
      content: "_Request cancelled._",
    },
  });
  assert.deepEqual(buildFailedLoopOutcome(new Error("bad request")), {
    status: "bad request",
    transcriptEntry: {
      role: "assistant",
      content: "**Error:** bad request",
    },
  });
  assert.equal(getPostLoopReadyStatus("done"), "Ready");
  assert.equal(getPostLoopReadyStatus("pending_approval"), undefined);
  assert.equal(shouldFinalizeCompletedLoop("done"), true);
  assert.equal(shouldFinalizeCompletedLoop("pending_approval"), false);
});

test("prompt workflow helpers cover slash skill shortcuts, model fallback, and turn start", () => {
  const debugSkill = {
    id: "debug",
    slashCommand: "/debug",
    name: "Debug",
    description: "Find the real bug.",
    prompt: "Debug carefully.",
  };

  const shortcutOnlySession = createSession({ transcript: [] });
  const shortcutOnlyResult = applySlashSkillShortcut(
    shortcutOnlySession,
    debugSkill,
    "",
  );
  assert.deepEqual(shortcutOnlyResult, { handled: true });
  assert.equal(shortcutOnlySession.activeSkills[0].id, "debug");
  assert.match(shortcutOnlySession.status, /Debug skill active/i);

  const shortcutWithPromptSession = createSession({ transcript: [] });
  const shortcutWithPromptResult = applySlashSkillShortcut(
    shortcutWithPromptSession,
    debugSkill,
    "inspect this stack trace",
  );
  assert.deepEqual(shortcutWithPromptResult, {
    handled: false,
    nextPrompt: "inspect this stack trace",
  });
  assert.equal(shortcutWithPromptSession.activeSkills[0].note, "inspect this stack trace");

  const modelSession = createSession({ selectedModel: "" });
  assert.equal(ensureSelectedModelForPrompt(modelSession, "gpt-5.4"), true);
  assert.equal(modelSession.selectedModel, "gpt-5.4");

  const missingModelSession = createSession({ selectedModel: "" });
  assert.equal(ensureSelectedModelForPrompt(missingModelSession, ""), false);
  assert.equal(missingModelSession.status, NO_MODEL_SELECTED_STATUS);

  const turnSession = createSession({
    title: "Chat 5",
    selectedModel: "gpt-5.4",
    activeSkills: [{ id: "debug", name: "Debug", description: "Debug", source: "builtin", prompt: "Debug carefully." }],
  });
  const turnStart = beginPromptTurn({
    session: turnSession,
    rawPrompt: "Investigate this failure",
    resolvedPrompt: "Investigate this failure in `src/app.ts`",
    fallbackTitleNumber: 5,
    images: [{ data: "abc", mimeType: "image/png" }],
    files: [{ name: "error.log", mimeType: "text/plain", content: "boom", sizeBytes: 4 }],
  });
  assert.deepEqual(turnStart, { titleChanged: true, needsSkillPreflight: true });
  assert.equal(turnSession.title, "Investigate this failure");
  assert.equal(turnSession.busy, true);
  assert.equal(turnSession.status, "Preparing skill context...");
  assert.equal(turnSession.transcript.length, 1);
  assert.equal(turnSession.transcript[0].content, "Investigate this failure in `src/app.ts`");
  assert.equal(turnSession.transcript[0].images.length, 1);
  assert.equal(turnSession.transcript[0].files.length, 1);

  const plainTurnSession = createSession({
    title: "Existing title",
    selectedModel: "gpt-5.4",
    activeSkills: [],
  });
  const plainTurn = beginPromptTurn({
    session: plainTurnSession,
    rawPrompt: "Hello there",
    resolvedPrompt: "Hello there",
    fallbackTitleNumber: 8,
  });
  assert.deepEqual(plainTurn, { titleChanged: false, needsSkillPreflight: false });
  assert.equal(plainTurnSession.status, "Thinking...");
  assert.equal(plainTurnSession.title, "Existing title");
});

test("prompt workflow helper composes slash skill, local skill intent, auto-route, and model fallback", () => {
  const skills = [
    {
      id: "debug",
      name: "Debug",
      description: "Find the real bug.",
      source: "builtin",
      prompt: "Debug carefully.",
    },
    {
      id: "review",
      name: "Review",
      description: "Review the code.",
      source: "builtin",
      prompt: "Review carefully.",
    },
  ];

  const slashSkillSession = createSession({ selectedModel: "", activeSkills: [] });
  const slashSkillResult = preparePromptForSend({
    session: slashSkillSession,
    prompt: "/debug inspect this crash",
    availableSkills: skills,
    preferredModel: "gpt-5.4",
    fallbackTitleNumber: 1,
  });
  assert.equal(slashSkillResult.kind, "ready");
  assert.equal(slashSkillResult.prompt, "inspect this crash");
  assert.equal(slashSkillResult.transientSystemPrompt, undefined);
  assert.equal(slashSkillSession.selectedModel, "gpt-5.4");
  assert.equal(slashSkillSession.activeSkills[0].id, "debug");

  const localIntentSession = createSession({ title: "Chat 2", selectedModel: "" });
  const localIntentResult = preparePromptForSend({
    session: localIntentSession,
    prompt: "what skills do you have?",
    availableSkills: skills,
    preferredModel: "gpt-5.4",
    fallbackTitleNumber: 2,
  });
  assert.deepEqual(localIntentResult, {
    kind: "handled",
    titleChanged: true,
  });
  assert.equal(localIntentSession.transcript.length, 2);
  assert.equal(localIntentSession.selectedModel, "");

  const autoRouteSession = createSession({ selectedModel: "", activeSkills: [] });
  const autoRouteResult = preparePromptForSend({
    session: autoRouteSession,
    prompt: "please investigate why this is failing",
    availableSkills: skills,
    preferredModel: "gpt-5.4-mini",
    fallbackTitleNumber: 3,
  });
  assert.equal(autoRouteResult.kind, "ready");
  assert.equal(autoRouteResult.prompt, "please investigate why this is failing");
  assert.equal(autoRouteResult.transientSystemPrompt, undefined);
  assert.equal(autoRouteSession.selectedModel, "gpt-5.4-mini");
  assert.equal(autoRouteSession.activeSkills[0].id, "investigate");

  const blockedSession = createSession({ selectedModel: "", activeSkills: [] });
  const blockedResult = preparePromptForSend({
    session: blockedSession,
    prompt: "implement a new button",
    availableSkills: skills,
    preferredModel: "",
    fallbackTitleNumber: 4,
  });
  assert.deepEqual(blockedResult, { kind: "blocked" });
  assert.equal(blockedSession.status, NO_MODEL_SELECTED_STATUS);

  const clockPromptResult = preparePromptForSend({
    session: createSession({ selectedModel: "", activeSkills: [] }),
    prompt: "what time is it",
    availableSkills: skills,
    preferredModel: "gpt-5.4",
    fallbackTitleNumber: 5,
  });
  assert.equal(clockPromptResult.kind, "ready");
  assert.match(clockPromptResult.transientSystemPrompt || "", /@run_command:\s+date /);

  const bridgeRepoPromptResult = preparePromptForSend({
    session: createSession({ selectedModel: "", activeSkills: [] }),
    prompt: "in this repo can you tell me where claude has the cool action words that show when loading?",
    availableSkills: skills,
    preferredModel: "gpt-5.4",
    fallbackTitleNumber: 6,
    providerKind: "codex-bridge",
  });
  assert.equal(bridgeRepoPromptResult.kind, "ready");
  assert.match(
    bridgeRepoPromptResult.transientSystemPrompt || "",
    /Bridge Tool Discipline/,
  );
  assert.match(
    bridgeRepoPromptResult.transientSystemPrompt || "",
    /MUST emit an appropriate PocketAI tool call/i,
  );

  const reviewPromptResult = preparePromptForSend({
    session: createSession({ selectedModel: "", activeSkills: [] }),
    prompt: "/review focus on permissions",
    availableSkills: skills,
    preferredModel: "gpt-5.4",
    fallbackTitleNumber: 7,
  });
  assert.equal(reviewPromptResult.kind, "ready");
  assert.match(reviewPromptResult.prompt, /Review the current git diff/);
  assert.match(reviewPromptResult.prompt, /Focus area: focus on permissions/);
});

test("prompt workflow helper only injects local clock verification for narrow local time/date prompts", () => {
  assert.match(
    buildTransientSystemPromptForPrompt("what time is it") || "",
    /Verified Local Clock Request/,
  );
  assert.match(
    buildTransientSystemPromptForPrompt("what's today's date?") || "",
    /@run_command:\s+date /,
  );
  assert.equal(
    buildTransientSystemPromptForPrompt("what time is it in tokyo"),
    undefined,
  );
  assert.equal(
    buildTransientSystemPromptForPrompt("convert 4pm tokyo to new york time"),
    undefined,
  );
  assert.match(
    buildTransientSystemPromptForPrompt(
      "look in this repo and tell me where the loading spinner words are",
      "claude-bridge",
    ) || "",
    /Bridge Tool Discipline/,
  );
  assert.match(
    buildTransientSystemPromptForPrompt(
      "look in this repo and tell me where the loading spinner words are",
      "cursor-bridge",
    ) || "",
    /Bridge Tool Discipline/,
  );
  assert.match(
    buildTransientSystemPromptForPrompt(
      "look in this repo and tell me where the loading spinner words are",
      "opencode-bridge",
    ) || "",
    /Bridge Tool Discipline/,
  );
  assert.equal(
    buildTransientSystemPromptForPrompt(
      "look in this repo and tell me where the loading spinner words are",
      "local-pocketai",
    ),
    undefined,
  );
});

test("slash command workflow helpers handle common command flows and effects", () => {
  const session = createSession({
    mode: "ask",
    transcript: [{ role: "assistant", content: "Existing" }],
    cumulativeTokens: { prompt: 1200, completion: 34 },
    harnessState: {
      pendingApprovals: [],
      pendingDiffs: [],
      todoItems: [
        { content: "check endpoint", status: "in_progress" },
      ],
      backgroundTasks: [
        {
          id: "bg-running",
          command: "npm test",
          status: "running",
          outputPreview: "",
          updatedAt: 1,
        },
        {
          id: "bg-done",
          command: "npm run build",
          status: "completed",
          outputPreview: "ok",
          updatedAt: 2,
        },
      ],
    },
    activeSkills: [
      {
        id: "debug",
        name: "Debug",
        description: "Find bugs",
        source: "builtin",
        prompt: "Debug carefully.",
      },
    ],
  });

  assert.match(buildSlashHelpContent(["- `/debug` — Debug bugs"]), /PocketAI slash commands:/);
  assert.match(buildSlashHelpContent(["- `/debug` — Debug bugs"]), /Skill shortcuts:/);

  applyQuickModeSlashCommand(session, "auto");
  assert.equal(session.mode, "auto");
  assert.match(session.status, /Auto mode/);

  assert.equal(applyExplicitModeSlashCommand(session, "plan"), true);
  assert.equal(session.mode, "plan");
  assert.equal(applyExplicitModeSlashCommand(session, "weird"), false);
  assert.equal(session.status, "Usage: /mode <ask|auto|plan>");

  const modelChanges = [];
  assert.deepEqual(
    applyModelSlashCommand({
      session,
      arg: "gpt-5.4",
      availableModels: ["gpt-5.4", "gpt-5.4-mini"],
      setSessionModel: (modelId) => {
        modelChanges.push(modelId);
        session.selectedModel = modelId;
      },
    }),
    { changedModel: true },
  );
  assert.equal(session.status, "Model switched to gpt-5.4");
  assert.deepEqual(modelChanges, ["gpt-5.4"]);
  assert.deepEqual(
    applyModelSlashCommand({
      session,
      arg: "",
      availableModels: ["gpt-5.4", "gpt-5.4-mini"],
      setSessionModel: () => {},
    }),
    { changedModel: false },
  );
  assert.match(session.status, /Available models:/);

  const endpoints = [
    {
      name: "Local PocketAI",
      url: "http://127.0.0.1:39457",
      healthy: true,
      lastChecked: 1,
    },
    {
      name: "Codex Bridge",
      url: "http://127.0.0.1:39458",
      healthy: true,
      lastChecked: 2,
    },
  ];
  assert.deepEqual(
    resolveEndpointSlashCommand({
      arg: "Codex Bridge",
      endpoints,
      activeUrl: "http://127.0.0.1:39457",
    }),
    {
      kind: "switch",
      endpointUrl: "http://127.0.0.1:39458",
      transcriptEntry: {
        role: "tool",
        content: "Switched endpoint to **Codex Bridge** (`http://127.0.0.1:39458`).",
      },
      status: "Endpoint switch requested: Codex Bridge",
    },
  );
  assert.equal(
    resolveEndpointSlashCommand({
      arg: "missing",
      endpoints,
      activeUrl: "http://127.0.0.1:39457",
    }).kind,
    "missing",
  );

  applySessionsSlashCommand(session, ["Chat 1", "Chat 2"]);
  assert.equal(session.status, "Sessions: Chat 1, Chat 2");

  applyTokensSlashCommand(session);
  assert.match(session.status, /Session tokens/);
  const codexUsageReport = buildUsageSlashReport({
    endpointName: "Codex Bridge",
    endpointUrl: "http://127.0.0.1:39458",
    providerLabel: "Codex Bridge",
    providerKind: "codex-bridge",
    session,
    usage: {
      ok: true,
      provider: "codex",
      source: "local-codex-log",
      planType: "prolite",
      limits: [
        {
          id: "primary",
          label: "5-hour window",
          usedPercent: 22,
          resetsAt: "2026-05-18T09:37:26.000Z",
        },
      ],
      tokenUsage: {
        total: {
          promptTokens: 763900,
          cachedPromptTokens: 629888,
          completionTokens: 7705,
          reasoningTokens: 4769,
          totalTokens: 771605,
        },
      },
    },
  });
  assert.match(codexUsageReport, /Account limits:/);
  assert.match(codexUsageReport, /5-hour window: 22% used/);
  assert.match(codexUsageReport, /Bridge tokens:/);
  assert.match(codexUsageReport, /PocketAI chat:/);

  const claudeUsageReport = buildUsageSlashReport({
    endpointName: "Claude Bridge",
    endpointUrl: "http://127.0.0.1:39460",
    providerLabel: "Claude Bridge",
    providerKind: "claude-bridge",
    session,
    usage: {
      ok: true,
      provider: "claude",
      accountUsageAvailable: false,
      message: "Claude Code does not expose plan-limit percentages through non-interactive bridge calls.",
      tokenUsage: {
        total: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
    },
  });
  assert.match(claudeUsageReport, /does not expose plan-limit percentages/);
  assert.match(claudeUsageReport, /Total: 15 tokens/);

  const cursorUsageReport = buildUsageSlashReport({
    endpointName: "Cursor Bridge",
    endpointUrl: "http://127.0.0.1:39461",
    providerLabel: "Cursor Bridge",
    providerKind: "cursor-bridge",
    session,
    usage: {
      ok: true,
      provider: "cursor",
      accountUsageAvailable: false,
      message: "Cursor CLI does not expose plan-limit percentages through JSON bridge calls.",
      tokenUsage: {
        total: { promptTokens: 20, completionTokens: 7, totalTokens: 27 },
      },
    },
  });
  assert.match(cursorUsageReport, /does not expose plan-limit percentages/);
  assert.match(cursorUsageReport, /Total: 27 tokens/);

  const opencodeUsageReport = buildUsageSlashReport({
    endpointName: "OpenCode Bridge",
    endpointUrl: "http://127.0.0.1:39462",
    providerLabel: "OpenCode Bridge",
    providerKind: "opencode-bridge",
    session,
    usage: {
      ok: true,
      provider: "opencode",
      accountUsageAvailable: false,
      message: "OpenCode CLI does not expose plan-limit percentages through JSON bridge calls.",
      tokenUsage: {
        total: { promptTokens: 30, completionTokens: 9, totalTokens: 39 },
      },
    },
  });
  assert.match(opencodeUsageReport, /does not expose plan-limit percentages/);
  assert.match(opencodeUsageReport, /Total: 39 tokens/);

  const deepseekUsageReport = buildUsageSlashReport({
    endpointName: "DeepSeek Bridge",
    endpointUrl: "http://127.0.0.1:39464",
    providerLabel: "DeepSeek Bridge",
    providerKind: "deepseek-bridge",
    session,
    usage: {
      ok: true,
      provider: "deepseek",
      accountUsageAvailable: false,
      message: "DeepSeek API account limit percentages are not exposed by this bridge.",
      tokenUsage: {
        total: { promptTokens: 40, completionTokens: 11, totalTokens: 51 },
      },
    },
  });
  assert.match(deepseekUsageReport, /DeepSeek API account limit percentages/);
  assert.match(deepseekUsageReport, /Total: 51 tokens/);

  const localUsageReport = buildUsageSlashReport({
    endpointName: "Local PocketAI",
    endpointUrl: "http://127.0.0.1:39457",
    providerLabel: "Local LLM",
    providerKind: "local-pocketai",
    session,
  });
  assert.match(localUsageReport, /does not advertise PocketAI bridge account-usage data/);
  assert.equal(buildRefreshSlashStatus("Codex Bridge", 0), "Refreshed Codex Bridge, but no models were found.");
  assert.equal(buildRefreshSlashStatus("Codex Bridge", 2), "Refreshed models for Codex Bridge.");

  const todoOutcome = applyTodoSlashCommand(session, session.harnessState.todoItems);
  assert.deepEqual(todoOutcome, { handled: true });
  assert.match(session.transcript.at(-1).content, /Tracked tasks:/);
  const emptyTodoSession = createSession();
  assert.deepEqual(applyTodoSlashCommand(emptyTodoSession, []), { handled: false });
  assert.equal(emptyTodoSession.status, "No tracked tasks yet.");

  const jobsList = resolveJobsSlashCommand("", session.harnessState.backgroundTasks);
  assert.equal(jobsList.kind, "list");
  assert.match(jobsList.transcriptEntry.content, /Command tasks:/);
  const jobsClear = resolveJobsSlashCommand("clear", session.harnessState.backgroundTasks);
  assert.deepEqual(jobsClear, {
    kind: "clear",
    staleTaskIds: ["bg-done"],
    remainingTasks: [
      {
        id: "bg-running",
        command: "npm test",
        status: "running",
        outputPreview: "",
        updatedAt: 1,
      },
    ],
    transcriptEntry: {
      role: "tool",
      content: "Cleared 1 finished background command.",
    },
    status: "Cleared 1 finished background command.",
  });
  assert.deepEqual(resolveJobsSlashCommand("cancel bg-running", session.harnessState.backgroundTasks), {
    kind: "cancel",
    taskId: "bg-running",
  });
  assert.deepEqual(resolveJobsSlashCommand("rerun bg-done", session.harnessState.backgroundTasks), {
    kind: "rerun",
    taskId: "bg-done",
  });
  assert.deepEqual(resolveJobsSlashCommand("bg-running", session.harnessState.backgroundTasks), {
    kind: "details",
    taskId: "bg-running",
    status: "Background task details: bg-running",
  });

  applyClearSlashCommand(session);
  assert.equal(session.transcript.length, 0);
  assert.equal(session.activeSkills.length, 0);
  assert.equal(session.status, "Cleared.");
});

test("startup workflow helpers compose restored sessions, endpoint normalization, and persistence needs", () => {
  const persistedSessions = [
    {
      id: "session-a",
      title: "Chat 1",
      transcript: [],
      selectedModel: "missing-model",
      selectedReasoningEffort: "high",
      selectedEndpoint: "http://old-endpoint",
      status: "Old",
      updatedAt: 10,
      mode: "ask",
      cumulativeTokens: { prompt: 0, completion: 0 },
      backgroundTasks: [
        {
          id: "bg-1",
          command: "npm test",
          status: "running",
          outputPreview: "running",
          updatedAt: 5,
          cwd: "/tmp/project",
        },
      ],
    },
    {
      id: "session-b",
      title: "Chat 2",
      transcript: [],
      selectedModel: "gpt-5.4",
      selectedReasoningEffort: "",
      selectedEndpoint: "",
      status: "Old",
      updatedAt: 20,
      mode: "ask",
      cumulativeTokens: { prompt: 0, completion: 0 },
      backgroundTasks: [],
    },
  ];

  const restoredSessions = persistedSessions.map((persisted) =>
    restoreSessionFromPersistence(persisted).session,
  );
  const restoreSnapshots = buildBackgroundTaskRestoreSnapshots(restoredSessions);
  assert.deepEqual(restoreSnapshots, [
    {
      id: "bg-1",
      sessionId: "session-a",
      command: "npm test",
      kind: "background",
      status: "interrupted",
      outputPreview: "[Interrupted after PocketAI reload]\nrunning",
      updatedAt: 5,
      cwd: "/tmp/project",
    },
  ]);

  const activeEndpointUrl = resolveActiveEndpointUrl({
    endpoints: [
      { name: "Local PocketAI", url: "http://127.0.0.1:39457/" },
      { name: "Codex Bridge", url: "http://127.0.0.1:39458/" },
    ],
    currentActiveEndpointUrl: "",
    storedActiveEndpointUrl: "http://127.0.0.1:39458/",
    fallbackUrl: "http://127.0.0.1:39457",
  });
  assert.equal(activeEndpointUrl, "http://127.0.0.1:39458");

  assert.equal(
    syncSessionsToActiveEndpoint(restoredSessions, activeEndpointUrl),
    true,
  );
  assert.equal(
    applyRefreshedModelsToSessions(restoredSessions, ["gpt-5.4", "gpt-5.4-mini"], () => "gpt-5.4-mini"),
    true,
  );
  assert.deepEqual(
    restoredSessions.map((session) => ({
      id: session.id,
      selectedEndpoint: session.selectedEndpoint,
      selectedModel: session.selectedModel,
      selectedReasoningEffort: session.selectedReasoningEffort,
      status: session.status,
    })),
    [
      {
        id: "session-a",
        selectedEndpoint: "http://127.0.0.1:39458",
        selectedModel: "gpt-5.4-mini",
        selectedReasoningEffort: "",
        status: "Connected — 2 models available",
      },
      {
        id: "session-b",
        selectedEndpoint: "http://127.0.0.1:39458",
        selectedModel: "gpt-5.4",
        selectedReasoningEffort: "",
        status: "Connected — 2 models available",
      },
    ],
  );

  assert.equal(
    shouldPersistStartupState({
      createdInitialSession: false,
      normalizedRestoredTasks: true,
      endpointSelectionsSynced: true,
    }),
    true,
  );
  assert.equal(
    shouldPersistStartupState({
      createdInitialSession: false,
      normalizedRestoredTasks: false,
      endpointSelectionsSynced: false,
    }),
    false,
  );
  assert.equal(
    resolveExistingSessionId("missing", restoredSessions.map((session) => session.id), "session-b"),
    "session-b",
  );
});

test("remote PocketAI device endpoints are built as managed in-memory endpoints", () => {
  const endpoint = buildPocketAiRemoteEndpoint({
    id: "device-1",
    name: "Office Mac",
    subdomain: "office-mac",
    url: "https://office-mac.pocketaihub.com/",
    apiKey: "secret-key",
    localPort: 39457,
    status: "active",
    lastSeenAt: null,
  });

  assert.deepEqual(endpoint, {
    name: "Office Mac · office-mac",
    url: "https://office-mac.pocketaihub.com",
    apiKey: "secret-key",
    managed: true,
    managedSource: "pocketai-remote-device",
    deviceId: "device-1",
    subdomain: "office-mac",
    remoteUrl: "https://office-mac.pocketaihub.com",
  });

  assert.equal(
    buildPocketAiRemoteEndpoint({
      id: "device-2",
      name: "No Auth",
      subdomain: "no-auth",
      url: "https://no-auth.pocketaihub.com",
      apiKey: "",
      localPort: 39457,
      status: "active",
      lastSeenAt: null,
    }),
    null,
  );
});

test("OpenCode Go helpers normalize endpoint URLs and expose chat-compatible models", () => {
  assert.equal(
    normalizeEndpointInputUrl("https://opencode.ai/zen/go/v1/chat/completions"),
    "https://opencode.ai/zen/go",
  );
  assert.equal(
    normalizeEndpointInputUrl("https://opencode.ai/zen/go/v1"),
    "https://opencode.ai/zen/go",
  );
  assert.equal(isOpenCodeGoEndpoint("https://opencode.ai/zen/go"), true);
  assert.equal(isOpenCodeGoEndpoint("https://example.com/v1"), false);
  assert.deepEqual(getOpenCodeGoChatModels(), [
    "opencode-go/glm-5",
    "opencode-go/glm-5.1",
    "opencode-go/kimi-k2.5",
    "opencode-go/kimi-k2.6",
    "opencode-go/deepseek-v4-pro",
    "opencode-go/deepseek-v4-flash",
    "opencode-go/mimo-v2.5",
    "opencode-go/mimo-v2.5-pro",
    "opencode-go/mimo-v2-pro",
    "opencode-go/mimo-v2-omni",
  ]);
  assert.equal(
    toOpenCodeGoRequestModel(
      "opencode-go/glm-5.1",
      "https://opencode.ai/zen/go",
    ),
    "glm-5.1",
  );
  assert.equal(
    toOpenCodeGoRequestModel(
      "opencode-go/glm-5.1",
      "http://127.0.0.1:39457",
    ),
    "opencode-go/glm-5.1",
  );
  assert.deepEqual(getOpenCodeGoHealthProbeInit("test-key"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    },
    body: "{}",
  });
});

test("xAI helpers normalize Grok endpoints and provide a friendly default name", () => {
  assert.equal(XAI_BASE_URL, "https://api.x.ai");
  assert.equal(isXAIEndpoint("https://api.x.ai/v1"), true);
  assert.equal(isXAIEndpoint("https://us-east-1.api.x.ai/v1/chat/completions"), true);
  assert.equal(isXAIEndpoint("https://example.com/v1"), false);
  assert.equal(normalizeXAIBaseUrl("https://api.x.ai/v1"), "https://api.x.ai");
  assert.equal(
    normalizeXAIBaseUrl("https://api.x.ai/v1/chat/completions"),
    "https://api.x.ai",
  );
  assert.equal(
    normalizeXAIBaseUrl("https://us-east-1.api.x.ai/v1/models"),
    "https://us-east-1.api.x.ai",
  );
  assert.equal(
    normalizeEndpointInputUrl("https://api.x.ai/v1/chat/completions"),
    "https://api.x.ai",
  );
  assert.equal(getXAIProviderName(""), "Grok (xAI)");
  assert.equal(getXAIProviderName("https://api.x.ai/v1"), "Grok (xAI)");
  assert.equal(getXAIProviderName("My Grok"), "My Grok");
});

test("endpoint secret migration strips configured api keys and normalizes secret ids", () => {
  const migration = buildEndpointSecretMigration([
    {
      name: "Grok",
      url: "https://api.x.ai/v1",
      apiKey: "  x-secret  ",
      model: "grok-code-fast",
    },
    {
      name: "Local",
      url: "http://127.0.0.1:39457",
      apiKey: "",
    },
    {
      name: "OpenCode Go",
      url: "https://opencode.ai/zen/go/v1/chat/completions",
      apiKey: "go-secret",
    },
  ]);

  assert.equal(migration.changed, true);
  assert.deepEqual(migration.endpoints, [
    {
      name: "Grok",
      url: "https://api.x.ai/v1",
      model: "grok-code-fast",
    },
    {
      name: "Local",
      url: "http://127.0.0.1:39457",
    },
    {
      name: "OpenCode Go",
      url: "https://opencode.ai/zen/go/v1/chat/completions",
    },
  ]);
  assert.deepEqual(migration.secrets, [
    {
      url: "https://api.x.ai",
      apiKey: "x-secret",
      secretKey: getEndpointApiKeySecretKey("https://api.x.ai"),
    },
    {
      url: "https://opencode.ai/zen/go",
      apiKey: "go-secret",
      secretKey: getEndpointApiKeySecretKey("https://opencode.ai/zen/go"),
    },
  ]);

  assert.equal(
    getEndpointApiKeySecretKey("https://api.x.ai/v1/chat/completions"),
    "pocketai.endpointApiKey.https://api.x.ai",
  );
});

test("external link policy only allows http and https URLs", () => {
  assert.equal(
    normalizeHttpExternalUrl("https://Example.com/docs?q=PocketAI"),
    "https://example.com/docs?q=PocketAI",
  );
  assert.equal(
    normalizeHttpExternalUrl("http://localhost:3000/path"),
    "http://localhost:3000/path",
  );
  assert.equal(isHttpExternalUrl("command:workbench.action.reloadWindow"), false);
  assert.equal(isHttpExternalUrl("javascript:alert(1)"), false);
  assert.equal(isHttpExternalUrl("file:///tmp/secret.txt"), false);
  assert.equal(isHttpExternalUrl("not a url"), false);
});

test("settings webview uses a script nonce and does not render saved API keys", () => {
  const html = getSettingsHtml("nonce-test");
  assert.match(
    html,
    /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-nonce-test';"/,
  );
  assert.match(html, /<script nonce="nonce-test">/);
  assert.match(html, /const epApiKeySet = !!ep\.apiKeySet;/);
  assert.match(
    html,
    /API key saved\. Enter a new key to replace it\./,
  );
  assert.doesNotMatch(html, /ep\.apiKey \|\|/);
  assert.doesNotMatch(html, /value="' \+ escapeHtml\(epApiKey\)/);
});

test("chat webview script emits valid JavaScript", () => {
  const script = getChatScript("brand://icon");
  assert.doesNotThrow(() => {
    new Function(script);
  });
  assert.match(script, /action === "compact"[\s\S]+prompt: "\/compact"/);
  assert.match(script, /action === "refresh-models"[\s\S]+type: "refreshModels"/);
  assert.match(script, /action === "show-jobs"[\s\S]+prompt: "\/jobs"/);
});

test("codex bridge maps attached images to Codex app-server image input items", async () => {
  const bridgeModuleUrl = pathToFileURL(
    path.join(__dirname, "../scripts/codex-openai-bridge.mjs"),
  ).href;
  const {
    buildCodexPrompt,
    contentToTextAndImages,
    createBridgeInfoPayload,
  } = await import(bridgeModuleUrl);
  const dataUrl = "data:image/png;base64,abc123";
  const jpegUrl = "data:image/jpeg;base64,def456";

  assert.deepEqual(
    contentToTextAndImages([
      { type: "input_text", text: "look at this" },
      { type: "image_url", image_url: { url: dataUrl } },
      { type: "input_image", image_url: jpegUrl },
      { type: "image", url: "data:image/webp;base64,ghi789" },
    ]),
    {
      text: "look at this\n[Image attached]\n[Image attached]\n[Image attached]",
      imageUrls: [dataUrl, jpegUrl, "data:image/webp;base64,ghi789"],
      sawImage: true,
    },
  );

  const prompt = buildCodexPrompt(
    [
      { role: "system", content: "system note" },
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this image?" },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    [],
  );

  assert.equal(prompt.baseInstructions, "system note");
  assert.match(prompt.input[0].text, /USER:\nwhat is in this image\?\n\[Image attached\]/);
  assert.deepEqual(prompt.input[1], {
    type: "image",
    url: dataUrl,
    detail: "high",
  });

  assert.deepEqual(createBridgeInfoPayload().capabilities, {
    streamingChatCompletions: true,
    imageInput: true,
  });
});
