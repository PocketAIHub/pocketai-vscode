const assert = require("node:assert/strict");
const http = require("node:http");
const vscode = require("vscode");

const EXTENSION_ID = "trevorwood.pocketai-vscode";
const BACKGROUND_COMPLETE_COMMAND =
  "node -e \"setTimeout(() => console.log('background command complete'), 250)\"";
const BACKGROUND_CANCEL_COMMAND =
  "node -e \"setTimeout(() => console.log('background cancel should not finish'), 5000)\"";

const EXPECTED_COMMANDS = [
  "pocketai.openPanel",
  "pocketai.focus",
  "pocketai.askSelection",
  "pocketai.askPrompt",
  "pocketai.focusInput",
  "pocketai.sendSelection",
  "pocketai.acceptInlineChange",
  "pocketai.rejectInlineChange",
  "pocketai.acceptAllInlineChanges",
  "pocketai.rejectAllInlineChanges",
];

const EXPECTED_TEST_COMMANDS = [
  "pocketai.test.sendPrompt",
  "pocketai.test.getSidebarSession",
  "pocketai.test.setMode",
  "pocketai.test.approveToolCall",
  "pocketai.test.rejectToolCall",
  "pocketai.test.approveChangeSet",
  "pocketai.test.rejectChangeSet",
];

async function resetPocketAiConfig() {
  const config = vscode.workspace.getConfiguration("pocketai");
  await config.update("endpoints", undefined, vscode.ConfigurationTarget.Global);
  await config.update(
    "includeWorkspaceContext",
    undefined,
    vscode.ConfigurationTarget.Global,
  );
  await config.update(
    "useStructuredTools",
    undefined,
    vscode.ConfigurationTarget.Global,
  );
  await config.update(
    "useIntegratedTerminal",
    undefined,
    vscode.ConfigurationTarget.Global,
  );
  await config.update(
    "permissions",
    undefined,
    vscode.ConfigurationTarget.Global,
  );
  await config.update(
    "contextWindowSize",
    undefined,
    vscode.ConfigurationTarget.Global,
  );
}

function getConfiguredEndpoints() {
  return vscode.workspace.getConfiguration("pocketai").get("endpoints") ?? [];
}

async function run() {
  await resetPocketAiConfig();
  const fakeEndpoint = await createFakeEndpoint();

  try {
    await vscode.workspace.getConfiguration("pocketai").update(
      "endpoints",
      [
        {
          name: "Fake Legacy Secret Endpoint",
          url: fakeEndpoint.baseUrl,
          model: "pocketai-test-model",
          maxTokens: 128,
          apiKey: "legacy-secret-value",
        },
      ],
      vscode.ConfigurationTarget.Global,
    );
    await vscode.workspace.getConfiguration("pocketai").update(
      "includeWorkspaceContext",
      false,
      vscode.ConfigurationTarget.Global,
    );
    await vscode.workspace.getConfiguration("pocketai").update(
      "useIntegratedTerminal",
      false,
      vscode.ConfigurationTarget.Global,
    );

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert(extension, `Expected extension ${EXTENSION_ID} to be discoverable.`);
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    for (const command of EXPECTED_COMMANDS) {
      assert(
        commands.includes(command),
        `Expected command to be registered: ${command}`,
      );
    }
    for (const command of EXPECTED_TEST_COMMANDS) {
      assert(
        commands.includes(command),
        `Expected test command to be registered: ${command}`,
      );
    }

    await waitFor(
      async () => {
        const endpoints = getConfiguredEndpoints();
        return endpoints.every(
          (endpoint) =>
            !Object.prototype.hasOwnProperty.call(endpoint, "apiKey"),
        );
      },
      "legacy endpoint API keys to be removed from VS Code settings",
    );

    const migratedEndpoints = getConfiguredEndpoints();
    assert.deepEqual(migratedEndpoints, [
      {
        name: "Fake Legacy Secret Endpoint",
        url: fakeEndpoint.baseUrl,
        model: "pocketai-test-model",
        maxTokens: 128,
      },
    ]);

    await assertPanelSelectionRoundTrip(fakeEndpoint);
    await assertSlashCommandRoundTrip(fakeEndpoint);
    await assertStructuredToolActionRoundTrip();
    await assertHoverSymbolRoundTrip();
    await assertIdeToolPermissionDenyRoundTrip();
    await assertIdeToolWorktreeRootRoundTrip();
    await assertEditApprovalVisualStateRoundTrip();
    await assertEditRejectionVisualStateRoundTrip();
    await assertStaleEditVisualStateRoundTrip();
    await assertMultiEditChangeSetApprovalRoundTrip();
    await assertMultiEditChangeSetRejectionRoundTrip();
    await assertSafeCommandAutoRunRoundTrip();
    await assertCommandApprovalRoundTrip();
    await assertCommandRejectionRoundTrip();
    await assertFailedCommandTimelineRoundTrip();
    await assertBackgroundCommandTaskRoundTrip();
    await assertRuntimeHealthStatusActionRoundTrip();
  } finally {
    await resetPocketAiConfig();
    await fakeEndpoint.close();
  }
}

async function assertPanelSelectionRoundTrip(fakeEndpoint) {
  await waitFor(
    () => fakeEndpoint.modelRequests.length > 0,
    "startup model refresh to hit the fake endpoint",
  );

  await vscode.commands.executeCommand("pocketai.openPanel");

  const code = [
    "function selectedMultiply(a, b) {",
    "  return a * b;",
    "}",
    "",
  ].join("\n");
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert(workspaceFolder, "Expected an extension-test workspace folder.");
  const fileUri = vscode.Uri.joinPath(
    workspaceFolder.uri,
    "selected-code.js",
  );
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(code, "utf8"));
  const document = await vscode.workspace.openTextDocument(fileUri);
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
  });
  editor.selection = new vscode.Selection(
    new vscode.Position(0, 0),
    new vscode.Position(
      document.lineCount - 1,
      document.lineAt(document.lineCount - 1).text.length,
    ),
  );

  await vscode.commands.executeCommand("pocketai.sendSelection");
  await waitFor(
    () => fakeEndpoint.chatRequests.length > 0,
    "selected text to be sent to the fake chat endpoint",
  );

  const chatRequest = fakeEndpoint.chatRequests.at(-1);
  assert.equal(chatRequest.headers.authorization, "Bearer legacy-secret-value");
  assert.equal(chatRequest.body.model, "pocketai-test-model");
  assert.equal(chatRequest.body.stream, true);
  assert.ok(Array.isArray(chatRequest.body.messages));
  assert.ok(Array.isArray(chatRequest.body.tools));
  const serializedMessages = JSON.stringify(chatRequest.body.messages);
  assert.match(serializedMessages, /selectedMultiply/);
  assert.match(serializedMessages, /Explain this code/);
}

async function assertSlashCommandRoundTrip(fakeEndpoint) {
  const endpointSnapshot = await sendTestPrompt("/endpoint");
  assert.match(lastTranscriptContent(endpointSnapshot), /Available endpoints:/);
  assert.match(
    lastTranscriptContent(endpointSnapshot),
    /Fake Legacy Secret Endpoint/,
  );
  assert.match(lastTranscriptContent(endpointSnapshot), /healthy/);
  assert.equal(endpointSnapshot.endpoints.length, 1);
  assert.equal(endpointSnapshot.endpoints[0].url, fakeEndpoint.baseUrl);

  const statusSnapshot = await sendTestPrompt("/status");
  assert.match(lastTranscriptContent(statusSnapshot), /PocketAI doctor:/);
  assert.match(
    lastTranscriptContent(statusSnapshot),
    /Fake Legacy Secret Endpoint/,
  );
  assert.match(lastTranscriptContent(statusSnapshot), /pocketai-test-model/);
  assert.match(lastTranscriptContent(statusSnapshot), /Structured tools: enabled/);

  const modelRequestCount = fakeEndpoint.modelRequests.length;
  const refreshSnapshot = await sendTestPrompt("/refresh");
  assert.equal(
    refreshSnapshot.status,
    "Refreshed models for Fake Legacy Secret Endpoint.",
  );
  assert.ok(
    fakeEndpoint.modelRequests.length > modelRequestCount,
    "Expected /refresh to request the fake endpoint model list.",
  );
  assert.deepEqual(refreshSnapshot.models, ["pocketai-test-model"]);
}

async function assertStructuredToolActionRoundTrip() {
  const snapshot = await sendTestPrompt(
    "Exercise structured action summaries by reading the workspace README.",
  );
  const assistantActionEntry = snapshot.transcript.find(
    (entry) => entry.assistantAction?.kind === "tool_action",
  );
  assert(assistantActionEntry, "Expected a structured assistant action entry.");
  assert.match(assistantActionEntry.content, /^\[PocketAI action: Reading/);
  assert.equal(assistantActionEntry.assistantAction.label, "Reading");
  assert.equal(assistantActionEntry.assistantAction.toolCount, 1);
  assert.equal(assistantActionEntry.assistantAction.actions[0].toolType, "read_file");
  assert.equal(assistantActionEntry.assistantAction.actions[0].target, "README.md");
  assert.equal(assistantActionEntry.toolCalls[0].type, "read_file");
  assert.equal(assistantActionEntry.toolCalls[0].status, "executed");

  const readResult = snapshot.transcript.find(
    (entry) =>
      entry.role === "tool" &&
      /PocketAI Extension Test Workspace/.test(entry.content),
  );
  assert(readResult, "Expected read_file tool output in the transcript.");

  assert.match(
    lastTranscriptContent(snapshot),
    /Structured action summary complete/,
  );
  assert(
    snapshot.harnessState.toolTimeline.some(
      (item) =>
        item.toolType === "read_file" &&
        item.status === "succeeded" &&
        item.target === "README.md",
    ),
    "Expected the harness Activity timeline to include the executed read_file call.",
  );
}

async function assertHoverSymbolRoundTrip() {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert(workspaceFolder, "Expected an extension-test workspace folder.");
  const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, "hover-target.paih");
  await vscode.workspace.fs.writeFile(
    fileUri,
    Buffer.from("hoverTargetSymbol\n", "utf8"),
  );
  const hoverProvider = vscode.languages.registerHoverProvider(
    { scheme: "file", pattern: "**/hover-target.paih" },
    {
      provideHover(document, position) {
        assert.equal(
          vscode.workspace.asRelativePath(document.uri, false),
          "hover-target.paih",
        );
        assert.equal(position.line, 0);
        return new vscode.Hover([
          new vscode.MarkdownString(
            [
              "```ts",
              "const hoverTargetSymbol: string",
              "```",
              "PocketAI hover coverage docs.",
            ].join("\n"),
          ),
        ]);
      },
    },
  );

  try {
    const snapshot = await sendTestPrompt(
      "Exercise hover symbol IDE coverage by inspecting hover-target.paih.",
    );
    assert.match(lastTranscriptContent(snapshot), /Hover symbol coverage complete/);
    const hoverTool = getLatestToolCall(snapshot, "hover_symbol");
    assert.equal(hoverTool.status, "executed");
    assert.equal(hoverTool.filePath, "hover-target.paih");
    assert.equal(hoverTool.line, 1);
    assert.equal(hoverTool.character, 0);
    assert.match(
      hoverTool.result || "",
      /Hover info for hover-target\.paih:1:0/,
    );
    assert.match(hoverTool.result || "", /hoverTargetSymbol: string/);
    assert.match(hoverTool.result || "", /PocketAI hover coverage docs/);
    assert(
      snapshot.harnessState.toolTimeline.some(
        (item) =>
          item.toolCallId === hoverTool.id &&
          item.status === "succeeded" &&
          item.toolType === "hover_symbol" &&
          item.filePath === "hover-target.paih",
      ),
      "Expected the Activity timeline to show hover_symbol success.",
    );
  } finally {
    hoverProvider.dispose();
  }
}

async function assertIdeToolPermissionDenyRoundTrip() {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert(workspaceFolder, "Expected an extension-test workspace folder.");
  const deniedUri = vscode.Uri.joinPath(workspaceFolder.uri, "ide-denied.paih");
  await vscode.workspace.fs.writeFile(
    deniedUri,
    Buffer.from("deniedActionTarget\n", "utf8"),
  );

  let providerCalled = false;
  const actionProvider = vscode.languages.registerCodeActionsProvider(
    { scheme: "file", pattern: "**/ide-denied.paih" },
    {
      provideCodeActions() {
        providerCalled = true;
        return [
          new vscode.CodeAction("Denied Action", vscode.CodeActionKind.QuickFix),
        ];
      },
    },
  );

  try {
    await vscode.commands.executeCommand("pocketai.test.setMode", "ask");

    const pendingSnapshot = await sendTestPrompt(
      "Exercise IDE permission deny coverage by applying a denied code action.",
    );
    const codeActionTool = getLatestToolCall(
      pendingSnapshot,
      "apply_code_action",
    );
    assert.equal(codeActionTool.status, "pending");
    assert.equal(codeActionTool.filePath, "ide-denied.paih");

    await vscode.workspace.getConfiguration("pocketai").update(
      "permissions",
      { allow: [], deny: ["apply_code_action(ide-denied.paih)"] },
      vscode.ConfigurationTarget.Global,
    );
    await vscode.commands.executeCommand(
      "pocketai.test.approveToolCall",
      codeActionTool.id,
    );
    const deniedSnapshot = await waitForSessionSnapshot(
      (snapshot) =>
        /IDE permission deny coverage complete/.test(
          lastTranscriptContent(snapshot),
        ),
      "IDE tool permission denial to finish with a final response",
    );
    const deniedTool = getLatestToolCall(deniedSnapshot, "apply_code_action");
    assert.equal(deniedTool.status, "executed");
    assert.match(
      deniedTool.result || "",
      /Blocked by permission rule: apply_code_action\(ide-denied\.paih\)/,
    );
    assert.equal(
      providerCalled,
      false,
      "Denied IDE tool should not invoke the code action provider.",
    );
    assert(
      deniedSnapshot.harnessState.toolTimeline.some(
        (item) =>
          item.toolCallId === codeActionTool.id &&
          item.status === "failed" &&
          item.toolType === "apply_code_action",
      ),
      "Expected the Activity timeline to show the denied IDE tool as failed.",
    );
  } finally {
    actionProvider.dispose();
    await vscode.workspace.getConfiguration("pocketai").update(
      "permissions",
      undefined,
      vscode.ConfigurationTarget.Global,
    );
  }
}

async function assertIdeToolWorktreeRootRoundTrip() {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert(workspaceFolder, "Expected an extension-test workspace folder.");

  const mainUri = vscode.Uri.joinPath(workspaceFolder.uri, "worktree-hover.paih");
  const worktreeRootUri = vscode.Uri.joinPath(
    workspaceFolder.uri,
    ".pocketai",
    "worktrees",
    "ide-hover",
  );
  const worktreeFileUri = vscode.Uri.joinPath(
    worktreeRootUri,
    "worktree-hover.paih",
  );

  await vscode.workspace.fs.writeFile(
    mainUri,
    Buffer.from("mainRootSymbol\n", "utf8"),
  );
  await vscode.workspace.fs.createDirectory(worktreeRootUri);
  await vscode.workspace.fs.writeFile(
    worktreeFileUri,
    Buffer.from("worktreeRootSymbol\n", "utf8"),
  );

  const hoverProvider = vscode.languages.registerHoverProvider(
    { scheme: "file", pattern: "**/worktree-hover.paih" },
    {
      provideHover(document) {
        return new vscode.Hover([
          new vscode.MarkdownString(
            [
              "```txt",
              document.getText().trim(),
              "```",
              `Resolved path: ${document.uri.fsPath}`,
            ].join("\n"),
          ),
        ]);
      },
    },
  );

  try {
    const entered = await sendTestPrompt("/worktree ide-hover");
    assert.match(entered.status, /Entered existing worktree/);
    assert.match(
      entered.worktreeRoot || "",
      /\.pocketai[/\\]worktrees[/\\]ide-hover$/,
    );

    const snapshot = await sendTestPrompt(
      "Exercise IDE worktree hover coverage by inspecting worktree-hover.paih.",
    );
    assert.match(
      lastTranscriptContent(snapshot),
      /IDE worktree hover coverage complete/,
    );
    const hoverTool = getLatestToolCall(snapshot, "hover_symbol");
    assert.equal(hoverTool.status, "executed");
    assert.equal(hoverTool.filePath, "worktree-hover.paih");
    assert.match(hoverTool.result || "", /worktreeRootSymbol/);
    assert.doesNotMatch(hoverTool.result || "", /mainRootSymbol/);
    assert.match(
      hoverTool.result || "",
      /\.pocketai[/\\]worktrees[/\\]ide-hover[/\\]worktree-hover\.paih/,
    );
  } finally {
    hoverProvider.dispose();
    await sendTestPrompt("/worktree exit");
  }
}

async function assertEditApprovalVisualStateRoundTrip() {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert(workspaceFolder, "Expected an extension-test workspace folder.");
  const editableUri = vscode.Uri.joinPath(
    workspaceFolder.uri,
    "editable-target.js",
  );
  await vscode.workspace.fs.writeFile(
    editableUri,
    Buffer.from("export const value = 1;\n", "utf8"),
  );
  const modeSnapshot = await vscode.commands.executeCommand(
    "pocketai.test.setMode",
    "ask",
  );
  assert.equal(modeSnapshot.mode, "ask");

  const pendingSnapshot = await sendTestPrompt(
    "Exercise edit approval visual coverage by updating editable-target.js.",
  );
  const assistantActionEntry = pendingSnapshot.transcript.find(
    (entry) =>
      entry.assistantAction?.kind === "tool_action" &&
      entry.assistantAction.label === "Preparing changes",
  );
  assert(assistantActionEntry, "Expected an edit assistant action entry.");
  assert.equal(assistantActionEntry.assistantAction.toolCount, 2);
  assert.match(assistantActionEntry.content, /^\[PocketAI action: Preparing changes/);

  const editTool = assistantActionEntry.toolCalls.find(
    (toolCall) => toolCall.type === "edit_file",
  );
  assert(editTool, "Expected a pending edit_file call.");
  assert.equal(editTool.filePath, "editable-target.js");
  assert.equal(editTool.status, "pending");

  assert.deepEqual(pendingSnapshot.harnessState.pendingApprovals, [
    {
      toolCallId: editTool.id,
      toolType: "edit_file",
      filePath: "editable-target.js",
    },
  ]);
  assert(
    pendingSnapshot.harnessState.pendingDiffs.some(
      (diff) =>
        diff.toolCallId === editTool.id &&
        diff.filePath === "editable-target.js" &&
        diff.status === "pending" &&
        diff.previewKind === "inline-diff",
    ),
    "Expected a pending inline diff for the edit.",
  );
  assert(
    pendingSnapshot.harnessState.changeSets.some(
      (changeSet) =>
        changeSet.status === "pending" &&
        changeSet.toolCallIds.includes(editTool.id) &&
        changeSet.filePaths.includes("editable-target.js"),
    ),
    "Expected a pending change set for the edit.",
  );
  assert(
    pendingSnapshot.harnessState.toolTimeline.some(
      (item) =>
        item.toolCallId === editTool.id &&
        item.toolType === "edit_file" &&
        item.status === "pending_approval" &&
        item.target === "editable-target.js",
    ),
    "Expected the Activity timeline to show the edit awaiting approval.",
  );

  await vscode.commands.executeCommand("pocketai.test.approveToolCall", editTool.id);
  const approvedSnapshot = await waitForSessionSnapshot(
    (snapshot) =>
      /Edit approval coverage complete/.test(lastTranscriptContent(snapshot)),
    "approved edit flow to finish with a final response",
  );

  const finalFile = Buffer.from(
    await vscode.workspace.fs.readFile(editableUri),
  ).toString("utf8");
  assert.equal(finalFile, "export const value = 2;\n");
  assert.equal(approvedSnapshot.harnessState.pendingApprovals.length, 0);
  assert(
    approvedSnapshot.harnessState.pendingDiffs.some(
      (diff) => diff.toolCallId === editTool.id && diff.status === "applied",
    ),
    "Expected the pending diff to be marked applied after approval.",
  );
  assert(
    approvedSnapshot.harnessState.changeSets.some(
      (changeSet) =>
        changeSet.toolCallIds.includes(editTool.id) &&
        changeSet.status === "applied",
    ),
    "Expected the change set to be marked applied after approval.",
  );
  assert(
    approvedSnapshot.harnessState.toolTimeline.some(
      (item) => item.toolCallId === editTool.id && item.status === "succeeded",
    ),
    "Expected the Activity timeline to show the approved edit as succeeded.",
  );
}

async function assertEditRejectionVisualStateRoundTrip() {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert(workspaceFolder, "Expected an extension-test workspace folder.");
  const editableUri = vscode.Uri.joinPath(
    workspaceFolder.uri,
    "reject-target.js",
  );
  await vscode.workspace.fs.writeFile(
    editableUri,
    Buffer.from("export const rejected = 1;\n", "utf8"),
  );
  await vscode.commands.executeCommand("pocketai.test.setMode", "ask");

  const pendingSnapshot = await sendTestPrompt(
    "Exercise edit rejection visual coverage by updating reject-target.js.",
  );
  const editTool = getPendingEditTool(pendingSnapshot, "reject-target.js");
  assert(
    pendingSnapshot.harnessState.pendingDiffs.some(
      (diff) => diff.toolCallId === editTool.id && diff.status === "pending",
    ),
    "Expected a pending diff before rejecting the edit.",
  );

  await vscode.commands.executeCommand("pocketai.test.rejectToolCall", editTool.id);
  const rejectedSnapshot = await waitForSessionSnapshot(
    (snapshot) =>
      /Edit rejection coverage complete/.test(lastTranscriptContent(snapshot)),
    "rejected edit flow to finish with a final response",
  );

  const finalFile = Buffer.from(
    await vscode.workspace.fs.readFile(editableUri),
  ).toString("utf8");
  assert.equal(finalFile, "export const rejected = 1;\n");
  assert.equal(rejectedSnapshot.harnessState.pendingApprovals.length, 0);
  assert(
    rejectedSnapshot.harnessState.pendingDiffs.some(
      (diff) => diff.toolCallId === editTool.id && diff.status === "rejected",
    ),
    "Expected the pending diff to be marked rejected.",
  );
  assert(
    rejectedSnapshot.harnessState.changeSets.some(
      (changeSet) =>
        changeSet.toolCallIds.includes(editTool.id) &&
        changeSet.status === "rejected",
    ),
    "Expected the change set to be marked rejected.",
  );
  assert(
    rejectedSnapshot.harnessState.toolTimeline.some(
      (item) => item.toolCallId === editTool.id && item.status === "rejected",
    ),
    "Expected the Activity timeline to show the rejected edit.",
  );
}

async function assertStaleEditVisualStateRoundTrip() {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert(workspaceFolder, "Expected an extension-test workspace folder.");
  const editableUri = vscode.Uri.joinPath(
    workspaceFolder.uri,
    "stale-target.js",
  );
  await vscode.workspace.fs.writeFile(
    editableUri,
    Buffer.from("export const stale = 1;\n", "utf8"),
  );
  await vscode.commands.executeCommand("pocketai.test.setMode", "ask");

  const pendingSnapshot = await sendTestPrompt(
    "Exercise stale edit visual coverage by updating stale-target.js.",
  );
  const editTool = getPendingEditTool(pendingSnapshot, "stale-target.js");
  const document = await vscode.workspace.openTextDocument(editableUri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length),
  );
  await editor.edit((edit) => {
    edit.replace(fullRange, "export const stale = 42;\n");
  });
  await document.save();

  await vscode.commands.executeCommand("pocketai.test.approveToolCall", editTool.id);
  const staleSnapshot = await waitForSessionSnapshot(
    (snapshot) =>
      /Stale edit coverage complete/.test(lastTranscriptContent(snapshot)),
    "stale edit flow to finish with a final response",
  );

  const finalFile = Buffer.from(
    await vscode.workspace.fs.readFile(editableUri),
  ).toString("utf8");
  assert.equal(finalFile, "export const stale = 42;\n");
  assert.equal(staleSnapshot.harnessState.pendingApprovals.length, 0);
  assert(
    staleSnapshot.harnessState.pendingDiffs.some(
      (diff) => diff.toolCallId === editTool.id && diff.status === "stale",
    ),
    "Expected the pending diff to be marked stale.",
  );
  assert(
    staleSnapshot.harnessState.changeSets.some(
      (changeSet) =>
        changeSet.toolCallIds.includes(editTool.id) &&
        changeSet.status === "stale",
    ),
    "Expected the change set to be marked stale.",
  );
  assert(
    staleSnapshot.harnessState.toolTimeline.some(
      (item) => item.toolCallId === editTool.id && item.status === "stale",
    ),
    "Expected the Activity timeline to show the stale edit.",
  );
}

async function assertMultiEditChangeSetApprovalRoundTrip() {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert(workspaceFolder, "Expected an extension-test workspace folder.");
  const firstUri = vscode.Uri.joinPath(workspaceFolder.uri, "multi-approve-a.js");
  const secondUri = vscode.Uri.joinPath(workspaceFolder.uri, "multi-approve-b.js");
  await vscode.workspace.fs.writeFile(
    firstUri,
    Buffer.from("export const alpha = 1;\n", "utf8"),
  );
  await vscode.workspace.fs.writeFile(
    secondUri,
    Buffer.from("export const beta = 1;\n", "utf8"),
  );
  await vscode.commands.executeCommand("pocketai.test.setMode", "ask");

  const pendingSnapshot = await sendTestPrompt(
    "Exercise multi-edit change set approval coverage by updating multi-approve-a.js and multi-approve-b.js.",
  );
  const changeSet = getPendingChangeSet(pendingSnapshot, [
    "multi-approve-a.js",
    "multi-approve-b.js",
  ]);
  assert.equal(changeSet.toolCallIds.length, 2);
  assert.equal(
    pendingSnapshot.harnessState.pendingApprovals.filter((approval) =>
      changeSet.toolCallIds.includes(approval.toolCallId),
    ).length,
    2,
  );
  assert.equal(
    pendingSnapshot.harnessState.pendingDiffs.filter(
      (diff) =>
        changeSet.toolCallIds.includes(diff.toolCallId) &&
        diff.status === "pending" &&
        diff.previewKind === "inline-diff",
    ).length,
    2,
  );
  assert.equal(
    pendingSnapshot.harnessState.toolTimeline.filter(
      (item) =>
        changeSet.toolCallIds.includes(item.toolCallId) &&
        item.status === "pending_approval",
    ).length,
    2,
  );

  await vscode.commands.executeCommand(
    "pocketai.test.approveChangeSet",
    changeSet.id,
  );
  const approvedSnapshot = await waitForSessionSnapshot(
    (snapshot) =>
      /Multi-edit change set approval complete/.test(lastTranscriptContent(snapshot)),
    "multi-edit change set approval to finish with a final response",
  );

  assert.equal(
    Buffer.from(await vscode.workspace.fs.readFile(firstUri)).toString("utf8"),
    "export const alpha = 2;\n",
  );
  assert.equal(
    Buffer.from(await vscode.workspace.fs.readFile(secondUri)).toString("utf8"),
    "export const beta = 2;\n",
  );
  assert.equal(
    approvedSnapshot.harnessState.pendingDiffs.filter(
      (diff) =>
        changeSet.toolCallIds.includes(diff.toolCallId) &&
        diff.status === "applied",
    ).length,
    2,
  );
  assert(
    approvedSnapshot.harnessState.changeSets.some(
      (item) => item.id === changeSet.id && item.status === "applied",
    ),
    "Expected the multi-edit change set to be applied.",
  );
  assert.equal(
    approvedSnapshot.harnessState.toolTimeline.filter(
      (item) =>
        changeSet.toolCallIds.includes(item.toolCallId) &&
        item.status === "succeeded",
    ).length,
    2,
  );
}

async function assertMultiEditChangeSetRejectionRoundTrip() {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert(workspaceFolder, "Expected an extension-test workspace folder.");
  const firstUri = vscode.Uri.joinPath(workspaceFolder.uri, "multi-reject-a.js");
  const secondUri = vscode.Uri.joinPath(workspaceFolder.uri, "multi-reject-b.js");
  await vscode.workspace.fs.writeFile(
    firstUri,
    Buffer.from("export const rejectAlpha = 1;\n", "utf8"),
  );
  await vscode.workspace.fs.writeFile(
    secondUri,
    Buffer.from("export const rejectBeta = 1;\n", "utf8"),
  );
  await vscode.commands.executeCommand("pocketai.test.setMode", "ask");

  const pendingSnapshot = await sendTestPrompt(
    "Exercise multi-edit change set rejection coverage by updating multi-reject-a.js and multi-reject-b.js.",
  );
  const changeSet = getPendingChangeSet(pendingSnapshot, [
    "multi-reject-a.js",
    "multi-reject-b.js",
  ]);

  await vscode.commands.executeCommand(
    "pocketai.test.rejectChangeSet",
    changeSet.id,
  );
  const rejectedSnapshot = await waitForSessionSnapshot(
    (snapshot) =>
      /Multi-edit change set rejection complete/.test(lastTranscriptContent(snapshot)),
    "multi-edit change set rejection to finish with a final response",
  );

  assert.equal(
    Buffer.from(await vscode.workspace.fs.readFile(firstUri)).toString("utf8"),
    "export const rejectAlpha = 1;\n",
  );
  assert.equal(
    Buffer.from(await vscode.workspace.fs.readFile(secondUri)).toString("utf8"),
    "export const rejectBeta = 1;\n",
  );
  assert.equal(
    rejectedSnapshot.harnessState.pendingDiffs.filter(
      (diff) =>
        changeSet.toolCallIds.includes(diff.toolCallId) &&
        diff.status === "rejected",
    ).length,
    2,
  );
  assert(
    rejectedSnapshot.harnessState.changeSets.some(
      (item) => item.id === changeSet.id && item.status === "rejected",
    ),
    "Expected the multi-edit change set to be rejected.",
  );
  assert.equal(
    rejectedSnapshot.harnessState.toolTimeline.filter(
      (item) =>
        changeSet.toolCallIds.includes(item.toolCallId) &&
        item.status === "rejected",
    ).length,
    2,
  );
}

async function assertSafeCommandAutoRunRoundTrip() {
  await vscode.commands.executeCommand("pocketai.test.setMode", "auto");

  const snapshot = await sendTestPrompt(
    "Exercise safe command auto-run coverage by running pwd.",
  );
  assert.match(lastTranscriptContent(snapshot), /Safe command auto-run complete/);
  const commandTool = getLatestToolCall(snapshot, "run_command", "pwd");
  assert.equal(commandTool.status, "executed");
  assert.equal(snapshot.harnessState.pendingApprovals.length, 0);
  assert(
    snapshot.harnessState.toolTimeline.some(
      (item) =>
        item.toolCallId === commandTool.id &&
        item.status === "succeeded" &&
        item.command === "pwd" &&
        item.commandRisk === "safe",
    ),
    "Expected the Activity timeline to show safe command success.",
  );
  assert(
    snapshot.harnessState.backgroundTasks.some(
      (task) =>
        task.toolCallId === commandTool.id &&
        task.kind === "foreground" &&
        task.status === "completed",
    ),
    "Expected the foreground command task to complete.",
  );
}

async function assertCommandApprovalRoundTrip() {
  await vscode.commands.executeCommand("pocketai.test.setMode", "ask");

  const pendingSnapshot = await sendTestPrompt(
    "Exercise command approval coverage by running an approved node command.",
  );
  const commandTool = getPendingCommandTool(
    pendingSnapshot,
    "node -e \"console.log('approved command path')\"",
  );
  assert.deepEqual(pendingSnapshot.harnessState.pendingApprovals, [
    {
      toolCallId: commandTool.id,
      toolType: "run_command",
      filePath: "",
      commandRisk: "writes",
    },
  ]);
  assert(
    pendingSnapshot.harnessState.toolTimeline.some(
      (item) =>
        item.toolCallId === commandTool.id &&
        item.status === "pending_approval" &&
        item.commandRisk === "writes",
    ),
    "Expected the Activity timeline to show command approval pending.",
  );

  await vscode.commands.executeCommand("pocketai.test.approveToolCall", commandTool.id);
  const approvedSnapshot = await waitForSessionSnapshot(
    (snapshot) =>
      /Command approval coverage complete/.test(lastTranscriptContent(snapshot)),
    "approved command flow to finish with a final response",
  );
  assert(
    approvedSnapshot.harnessState.toolTimeline.some(
      (item) => item.toolCallId === commandTool.id && item.status === "succeeded",
    ),
    "Expected the Activity timeline to show approved command success.",
  );
  assert(
    approvedSnapshot.harnessState.backgroundTasks.some(
      (task) =>
        task.toolCallId === commandTool.id &&
        task.status === "completed" &&
        /approved command path/.test(task.outputPreview),
    ),
    "Expected the approved command output to be tracked.",
  );
}

async function assertCommandRejectionRoundTrip() {
  await vscode.commands.executeCommand("pocketai.test.setMode", "ask");

  const pendingSnapshot = await sendTestPrompt(
    "Exercise command rejection coverage by running a rejected node command.",
  );
  const commandTool = getPendingCommandTool(
    pendingSnapshot,
    "node -e \"console.log('rejected command path')\"",
  );

  await vscode.commands.executeCommand("pocketai.test.rejectToolCall", commandTool.id);
  const rejectedSnapshot = await waitForSessionSnapshot(
    (snapshot) =>
      /Command rejection coverage complete/.test(lastTranscriptContent(snapshot)),
    "rejected command flow to finish with a final response",
  );
  assert(
    rejectedSnapshot.harnessState.toolTimeline.some(
      (item) => item.toolCallId === commandTool.id && item.status === "rejected",
    ),
    "Expected the Activity timeline to show rejected command.",
  );
  assert.equal(
    rejectedSnapshot.harnessState.backgroundTasks.some(
      (task) => task.toolCallId === commandTool.id,
    ),
    false,
    "Rejected command should not create a tracked command task.",
  );
}

async function assertFailedCommandTimelineRoundTrip() {
  await vscode.commands.executeCommand("pocketai.test.setMode", "auto");

  const snapshot = await sendTestPrompt(
    "Exercise failed command timeline coverage by running a missing node test.",
  );
  assert.match(lastTranscriptContent(snapshot), /Failed command coverage complete/);
  const commandTool = getLatestToolCall(
    snapshot,
    "run_command",
    "node --test missing-pocketai-test-file.test.js",
  );
  assert.equal(commandTool.status, "executed");
  assert.match(commandTool.result || "", /^Command failed/);
  assert(
    snapshot.harnessState.toolTimeline.some(
      (item) => item.toolCallId === commandTool.id && item.status === "failed",
    ),
    "Expected the Activity timeline to show failed command.",
  );
  assert(
    snapshot.harnessState.backgroundTasks.some(
      (task) =>
        task.toolCallId === commandTool.id &&
        task.status === "failed",
    ),
    "Expected the failed foreground command task to be tracked.",
  );
}

async function assertBackgroundCommandTaskRoundTrip() {
  await sendTestPrompt("/jobs clear");
  await vscode.commands.executeCommand("pocketai.test.setMode", "ask");

  const pendingSnapshot = await sendTestPrompt(
    "Exercise background command coverage by starting a tracked background task.",
  );
  const commandTool = getPendingCommandTool(
    pendingSnapshot,
    BACKGROUND_COMPLETE_COMMAND,
  );
  assert.equal(commandTool.background, true);

  await vscode.commands.executeCommand("pocketai.test.approveToolCall", commandTool.id);
  const startedSnapshot = await waitForSessionSnapshot(
    (snapshot) =>
      /Background command coverage complete/.test(lastTranscriptContent(snapshot)) &&
      !!findBackgroundTask(snapshot, BACKGROUND_COMPLETE_COMMAND),
    "background command flow to start and finish with a final response",
  );
  const startedTask = getBackgroundTask(
    startedSnapshot,
    BACKGROUND_COMPLETE_COMMAND,
  );
  assert.equal(startedTask.kind, "background");
  assert.equal(startedTask.toolCallId, commandTool.id);
  assert.equal(typeof startedTask.startedAt, "number");
  assert(startedTask.cwd, "Expected background task cwd to be tracked.");

  const completedSnapshot = await waitForSessionSnapshot(
    (snapshot) =>
      findBackgroundTask(snapshot, BACKGROUND_COMPLETE_COMMAND)?.status ===
      "completed",
    "background command to complete",
    8000,
  );
  const completedTask = getBackgroundTask(
    completedSnapshot,
    BACKGROUND_COMPLETE_COMMAND,
  );
  assert.equal(completedTask.kind, "background");
  assert.equal(completedTask.toolCallId, commandTool.id);
  assert.equal(completedTask.status, "completed");
  assert.equal(typeof completedTask.completedAt, "number");
  assert.match(completedTask.outputPreview, /background command complete/);

  const listSnapshot = await sendTestPrompt("/jobs");
  assert.match(lastTranscriptContent(listSnapshot), /Command tasks:/);
  assert.match(lastTranscriptContent(listSnapshot), new RegExp(escapeRegExp(completedTask.id)));
  assert.match(lastTranscriptContent(listSnapshot), /background command complete|completed/);

  const detailsSnapshot = await sendTestPrompt(`/jobs ${completedTask.id}`);
  assert.match(
    lastTranscriptContent(detailsSnapshot),
    new RegExp(`Background task ${escapeRegExp(completedTask.id)} \\(completed\\)`),
  );
  assert.match(lastTranscriptContent(detailsSnapshot), /background command complete/);

  const rerunSnapshot = await sendTestPrompt(`/jobs rerun ${completedTask.id}`);
  const rerunText = lastTranscriptContent(rerunSnapshot);
  assert.match(rerunText, /Reran background task/);
  const rerunTaskId = extractRerunTaskId(rerunText);
  const rerunCompleteSnapshot = await waitForSessionSnapshot(
    (snapshot) =>
      snapshot.harnessState.backgroundTasks.some(
        (task) => task.id === rerunTaskId && task.status === "completed",
      ),
    "rerun background command to complete",
    8000,
  );
  assert.match(
    getBackgroundTaskById(rerunCompleteSnapshot, rerunTaskId).outputPreview,
    /background command complete/,
  );

  const cancelPendingSnapshot = await sendTestPrompt(
    "Exercise background command cancel coverage by starting a cancellable background task.",
  );
  const cancelTool = getPendingCommandTool(
    cancelPendingSnapshot,
    BACKGROUND_CANCEL_COMMAND,
  );
  assert.equal(cancelTool.background, true);

  await vscode.commands.executeCommand("pocketai.test.approveToolCall", cancelTool.id);
  const cancelReadySnapshot = await waitForSessionSnapshot(
    (snapshot) =>
      /Background cancel coverage ready/.test(lastTranscriptContent(snapshot)) &&
      findBackgroundTask(snapshot, BACKGROUND_CANCEL_COMMAND)?.status === "running",
    "cancellable background command to start",
  );
  assert(
    cancelReadySnapshot.runtimeHealth.actions.includes("show-jobs"),
    "Expected running background commands to surface the Jobs status action.",
  );
  assert(
    cancelReadySnapshot.runtimeHealth.issues.some((issue) =>
      /still running/.test(issue),
    ),
    "Expected runtime health to mention running background commands.",
  );
  const cancelTask = getBackgroundTask(
    cancelReadySnapshot,
    BACKGROUND_CANCEL_COMMAND,
  );
  assert.equal(cancelTask.kind, "background");
  assert.equal(cancelTask.toolCallId, cancelTool.id);

  const cancelSnapshot = await sendTestPrompt(`/jobs cancel ${cancelTask.id}`);
  assert.match(lastTranscriptContent(cancelSnapshot), /Cancellation requested/);
  const cancelledSnapshot = await waitForSessionSnapshot(
    (snapshot) =>
      findBackgroundTask(snapshot, BACKGROUND_CANCEL_COMMAND)?.status ===
      "cancelled",
    "background command cancellation to be reflected",
  );
  assert.match(
    getBackgroundTask(cancelledSnapshot, BACKGROUND_CANCEL_COMMAND).outputPreview,
    /Cancelled by user/,
  );

  const clearSnapshot = await sendTestPrompt("/jobs clear");
  assert.match(
    lastTranscriptContent(clearSnapshot),
    /Cleared \d+ finished background commands?\./,
  );
  assert.deepEqual(clearSnapshot.harnessState.backgroundTasks, []);
}

async function assertRuntimeHealthStatusActionRoundTrip() {
  await vscode.workspace.getConfiguration("pocketai").update(
    "contextWindowSize",
    1,
    vscode.ConfigurationTarget.Global,
  );
  const snapshot = await vscode.commands.executeCommand(
    "pocketai.test.getSidebarSession",
  );
  assert(snapshot, "Expected a session snapshot with runtime health.");
  assert(
    snapshot.runtimeHealth.actions.includes("compact"),
    "Expected a full context to surface the Compact status action.",
  );
  assert(
    snapshot.runtimeHealth.issues.some((issue) =>
      /context is getting full/i.test(issue),
    ),
    "Expected runtime health to mention context pressure.",
  );
}

function getPendingEditTool(snapshot, filePath) {
  const assistantActionEntry = snapshot.transcript.find(
    (entry) =>
      entry.assistantAction?.kind === "tool_action" &&
      entry.toolCalls?.some(
        (toolCall) =>
          toolCall.type === "edit_file" &&
          toolCall.filePath === filePath &&
          toolCall.status === "pending",
      ),
  );
  assert(
    assistantActionEntry,
    `Expected an assistant action entry with a pending edit for ${filePath}.`,
  );
  const editTool = assistantActionEntry.toolCalls.find(
    (toolCall) => toolCall.type === "edit_file" && toolCall.filePath === filePath,
  );
  assert(editTool, `Expected a pending edit_file call for ${filePath}.`);
  assert.equal(editTool.status, "pending");
  return editTool;
}

function getPendingCommandTool(snapshot, command) {
  const toolCall = getLatestToolCall(snapshot, "run_command", command);
  assert.equal(toolCall.status, "pending");
  return toolCall;
}

function getLatestToolCall(snapshot, type, command) {
  for (let index = snapshot.transcript.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.transcript[index];
    const toolCall = entry.toolCalls?.find(
      (candidate) =>
        candidate.type === type &&
        (command === undefined || candidate.command === command),
    );
    if (toolCall) return toolCall;
  }
  assert.fail(
    `Expected latest ${type} tool call${command ? ` for ${command}` : ""}.`,
  );
}

function findBackgroundTask(snapshot, command) {
  return snapshot.harnessState.backgroundTasks.find(
    (task) => task.command === command,
  );
}

function getBackgroundTask(snapshot, command) {
  const task = findBackgroundTask(snapshot, command);
  assert(task, `Expected background task for command: ${command}`);
  return task;
}

function getBackgroundTaskById(snapshot, taskId) {
  const task = snapshot.harnessState.backgroundTasks.find(
    (candidate) => candidate.id === taskId,
  );
  assert(task, `Expected background task ${taskId}.`);
  return task;
}

function extractRerunTaskId(text) {
  const match = /\bas (bg_[a-z0-9]+):/.exec(text);
  assert(match, `Expected rerun task id in: ${text}`);
  return match[1];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getPendingChangeSet(snapshot, filePaths) {
  const expected = new Set(filePaths);
  const changeSet = snapshot.harnessState.changeSets.find(
    (item) =>
      item.status === "pending" &&
      item.filePaths.length === expected.size &&
      item.filePaths.every((filePath) => expected.has(filePath)),
  );
  assert(
    changeSet,
    `Expected pending change set for ${filePaths.join(", ")}.`,
  );
  return changeSet;
}

async function sendTestPrompt(prompt) {
  const snapshot = await vscode.commands.executeCommand(
    "pocketai.test.sendPrompt",
    prompt,
  );
  assert(snapshot, "Expected test prompt command to return a session snapshot.");
  return snapshot;
}

async function waitForSessionSnapshot(predicate, description, timeoutMs = 5000) {
  let latest;
  await waitFor(async () => {
    latest = await vscode.commands.executeCommand(
      "pocketai.test.getSidebarSession",
    );
    return latest && predicate(latest);
  }, description, timeoutMs);
  return latest;
}

function lastTranscriptContent(snapshot) {
  const lastEntry = snapshot.transcript.at(-1);
  assert(lastEntry, "Expected a transcript entry.");
  return lastEntry.content;
}

async function createFakeEndpoint() {
  const modelRequests = [];
  const chatRequests = [];
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/v1/models") {
      modelRequests.push({
        headers: request.headers,
      });
      sendJson(response, {
        data: [{ id: "pocketai-test-model" }],
      });
      return;
    }

    if (requestUrl.pathname === "/status") {
      sendJson(response, {
        ok: true,
        defaultModelId: "pocketai-test-model",
      });
      return;
    }

    if (requestUrl.pathname === "/api/tags") {
      sendJson(response, { models: [] });
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/v1/chat/completions"
    ) {
      const bodyText = await readRequestBody(request);
      chatRequests.push({
        headers: request.headers,
      body: JSON.parse(bodyText),
    });
      sendSseChatResponse(response, chatRequests.at(-1).body);
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert(address && typeof address === "object", "Expected fake server port.");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    modelRequests,
    chatRequests,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function sendJson(response, body) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function sendSseChatResponse(response, body) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const serializedMessages = JSON.stringify(body.messages);
  const lastMessageText = getLastMessageText(body.messages);
  const scenario = resolveFakeScenario(serializedMessages);
  if (
    scenario === "ide-permission-deny" &&
    /Blocked by permission rule: apply_code_action\(ide-denied\.paih\)/.test(
      lastMessageText,
    )
  ) {
    sendTextChatResponse(response, "IDE permission deny coverage complete.");
    return;
  }
  if (scenario === "ide-permission-deny") {
    sendStructuredApplyCodeActionToolCall(response);
    return;
  }
  if (
    scenario === "ide-worktree-hover" &&
    /Hover info for worktree-hover\.paih:1:0/.test(lastMessageText) &&
    /worktreeRootSymbol/.test(lastMessageText)
  ) {
    sendTextChatResponse(response, "IDE worktree hover coverage complete.");
    return;
  }
  if (scenario === "ide-worktree-hover") {
    sendStructuredWorktreeHoverToolCall(response);
    return;
  }
  if (
    scenario === "hover-symbol" &&
    /Hover info for hover-target\.paih:1:0/.test(lastMessageText)
  ) {
    sendTextChatResponse(response, "Hover symbol coverage complete.");
    return;
  }
  if (scenario === "hover-symbol") {
    sendStructuredHoverSymbolToolCall(response);
    return;
  }
  if (
    scenario === "background-command" &&
    /Command started in background/.test(lastMessageText)
  ) {
    sendTextChatResponse(response, "Background command coverage complete.");
    return;
  }
  if (scenario === "background-command") {
    sendStructuredRunCommandToolCall(response, {
      id: "call_cmd_background_complete",
      command: BACKGROUND_COMPLETE_COMMAND,
      background: true,
    });
    return;
  }
  if (
    scenario === "background-cancel" &&
    /Command started in background/.test(lastMessageText)
  ) {
    sendTextChatResponse(response, "Background cancel coverage ready.");
    return;
  }
  if (scenario === "background-cancel") {
    sendStructuredRunCommandToolCall(response, {
      id: "call_cmd_background_cancel",
      command: BACKGROUND_CANCEL_COMMAND,
      background: true,
    });
    return;
  }
  if (scenario === "safe-command" && /Command: `pwd`/.test(lastMessageText)) {
    sendTextChatResponse(response, "Safe command auto-run complete.");
    return;
  }
  if (scenario === "safe-command") {
    sendStructuredRunCommandToolCall(response, {
      id: "call_cmd_safe_pwd",
      command: "pwd",
    });
    return;
  }
  if (
    scenario === "command-approval" &&
    /approved command path/.test(lastMessageText)
  ) {
    sendTextChatResponse(response, "Command approval coverage complete.");
    return;
  }
  if (scenario === "command-approval") {
    sendStructuredRunCommandToolCall(response, {
      id: "call_cmd_approved",
      command: "node -e \"console.log('approved command path')\"",
    });
    return;
  }
  if (
    scenario === "command-rejection" &&
    /User rejected this change/.test(lastMessageText)
  ) {
    sendTextChatResponse(response, "Command rejection coverage complete.");
    return;
  }
  if (scenario === "command-rejection") {
    sendStructuredRunCommandToolCall(response, {
      id: "call_cmd_rejected",
      command: "node -e \"console.log('rejected command path')\"",
    });
    return;
  }
  if (
    scenario === "failed-command" &&
    /^Command failed/m.test(lastMessageText)
  ) {
    sendTextChatResponse(response, "Failed command coverage complete.");
    return;
  }
  if (scenario === "failed-command") {
    sendStructuredRunCommandToolCall(response, {
      id: "call_cmd_failed",
      command: "node --test missing-pocketai-test-file.test.js",
    });
    return;
  }
  if (
    scenario === "multi-edit-approval" &&
    /Successfully edited `multi-approve-b\.js`/.test(lastMessageText)
  ) {
    sendTextChatResponse(response, "Multi-edit change set approval complete.");
    return;
  }
  if (scenario === "multi-edit-approval") {
    sendStructuredMultiEditFileToolCalls(response, {
      idPrefix: "multi_approve",
      edits: [
        {
          path: "multi-approve-a.js",
          oldString: "export const alpha = 1;",
          newString: "export const alpha = 2;",
        },
        {
          path: "multi-approve-b.js",
          oldString: "export const beta = 1;",
          newString: "export const beta = 2;",
        },
      ],
    });
    return;
  }
  if (
    scenario === "multi-edit-rejection" &&
    /User rejected this change/.test(lastMessageText)
  ) {
    sendTextChatResponse(response, "Multi-edit change set rejection complete.");
    return;
  }
  if (scenario === "multi-edit-rejection") {
    sendStructuredMultiEditFileToolCalls(response, {
      idPrefix: "multi_reject",
      edits: [
        {
          path: "multi-reject-a.js",
          oldString: "export const rejectAlpha = 1;",
          newString: "export const rejectAlpha = 2;",
        },
        {
          path: "multi-reject-b.js",
          oldString: "export const rejectBeta = 1;",
          newString: "export const rejectBeta = 2;",
        },
      ],
    });
    return;
  }
  if (
    scenario === "stale-edit" &&
    /pending edit no longer matches the current file contents/.test(lastMessageText)
  ) {
    sendTextChatResponse(response, "Stale edit coverage complete.");
    return;
  }
  if (scenario === "stale-edit") {
    sendStructuredEditFileToolCalls(response, {
      idPrefix: "stale",
      path: "stale-target.js",
      oldString: "export const stale = 1;",
      newString: "export const stale = 2;",
    });
    return;
  }
  if (
    scenario === "edit-rejection" &&
    /User rejected this change/.test(lastMessageText)
  ) {
    sendTextChatResponse(response, "Edit rejection coverage complete.");
    return;
  }
  if (scenario === "edit-rejection") {
    sendStructuredEditFileToolCalls(response, {
      idPrefix: "reject",
      path: "reject-target.js",
      oldString: "export const rejected = 1;",
      newString: "export const rejected = 2;",
    });
    return;
  }
  if (
    scenario === "edit-approval" &&
    /Successfully edited `editable-target\.js`/.test(lastMessageText)
  ) {
    sendTextChatResponse(response, "Edit approval coverage complete.");
    return;
  }
  if (scenario === "edit-approval") {
    sendStructuredEditFileToolCalls(response, {
      idPrefix: "approve",
      path: "editable-target.js",
      oldString: "export const value = 1;",
      newString: "export const value = 2;",
    });
    return;
  }
  if (
    scenario === "structured-read" &&
    !/PocketAI Extension Test Workspace/.test(lastMessageText)
  ) {
    sendStructuredReadFileToolCall(response);
    return;
  }
  if (
    scenario === "structured-read" &&
    /PocketAI Extension Test Workspace/.test(lastMessageText)
  ) {
    sendTextChatResponse(response, "Structured action summary complete.");
    return;
  }
  sendTextChatResponse(response, "Fake endpoint saw the selected code.");
}

function getLastMessageText(messages) {
  const last = Array.isArray(messages) ? messages.at(-1) : undefined;
  const content = last?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part?.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function resolveFakeScenario(serializedMessages) {
  const scenarios = [
    ["hover-symbol", "Exercise hover symbol IDE coverage"],
    ["background-command", "Exercise background command coverage"],
    ["background-cancel", "Exercise background command cancel coverage"],
    ["ide-permission-deny", "Exercise IDE permission deny coverage"],
    ["ide-worktree-hover", "Exercise IDE worktree hover coverage"],
    ["safe-command", "Exercise safe command auto-run coverage"],
    ["command-approval", "Exercise command approval coverage"],
    ["command-rejection", "Exercise command rejection coverage"],
    ["failed-command", "Exercise failed command timeline coverage"],
    ["multi-edit-approval", "Exercise multi-edit change set approval coverage"],
    ["multi-edit-rejection", "Exercise multi-edit change set rejection coverage"],
    ["stale-edit", "Exercise stale edit visual coverage"],
    ["edit-rejection", "Exercise edit rejection visual coverage"],
    ["edit-approval", "Exercise edit approval visual coverage"],
    ["structured-read", "Exercise structured action summaries"],
  ];
  return scenarios
    .map(([name, marker]) => ({
      name,
      index: serializedMessages.lastIndexOf(marker),
    }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => b.index - a.index)[0]?.name || "";
}

function sendTextChatResponse(response, text) {
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    })}\n\n`,
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

function sendStructuredReadFileToolCall(response) {
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_read_readme",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: "",
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: JSON.stringify({ path: "README.md", limit: 20 }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 13, completion_tokens: 4 },
    })}\n\n`,
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

function sendStructuredHoverSymbolToolCall(response) {
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_hover_symbol",
                type: "function",
                function: {
                  name: "hover_symbol",
                  arguments: "",
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: JSON.stringify({
                    path: "hover-target.paih",
                    line: 1,
                    character: 0,
                  }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 15, completion_tokens: 5 },
    })}\n\n`,
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

function sendStructuredApplyCodeActionToolCall(response) {
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_apply_code_action_denied",
                type: "function",
                function: {
                  name: "apply_code_action",
                  arguments: "",
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: JSON.stringify({
                    path: "ide-denied.paih",
                    line: 1,
                    character: 0,
                    title: "Denied Action",
                  }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 15, completion_tokens: 5 },
    })}\n\n`,
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

function sendStructuredWorktreeHoverToolCall(response) {
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_hover_worktree",
                type: "function",
                function: {
                  name: "hover_symbol",
                  arguments: "",
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: JSON.stringify({
                    path: "worktree-hover.paih",
                    line: 1,
                    character: 0,
                  }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 15, completion_tokens: 5 },
    })}\n\n`,
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

function sendStructuredEditFileToolCalls(
  response,
  { idPrefix, path, oldString, newString },
) {
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call_read_${idPrefix}`,
                type: "function",
                function: {
                  name: "read_file",
                  arguments: "",
                },
              },
              {
                index: 1,
                id: `call_edit_${idPrefix}`,
                type: "function",
                function: {
                  name: "edit_file",
                  arguments: "",
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: JSON.stringify({
                    path,
                    limit: 20,
                  }),
                },
              },
              {
                index: 1,
                function: {
                  arguments: JSON.stringify({
                    path,
                    old_string: oldString,
                    new_string: newString,
                  }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 17, completion_tokens: 5 },
    })}\n\n`,
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

function sendStructuredRunCommandToolCall(response, { id, command, background }) {
  const args = { command };
  if (background !== undefined) args.background = background;
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: {
                  name: "run_command",
                  arguments: "",
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: JSON.stringify(args),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 19, completion_tokens: 5 },
    })}\n\n`,
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

function sendStructuredMultiEditFileToolCalls(response, { idPrefix, edits }) {
  const toolCalls = [];
  for (const [editIndex] of edits.entries()) {
    toolCalls.push({
      index: editIndex,
      id: `call_read_${idPrefix}_${editIndex}`,
      type: "function",
      function: {
        name: "read_file",
        arguments: "",
      },
    });
  }
  for (const [editIndex] of edits.entries()) {
    toolCalls.push({
      index: edits.length + editIndex,
      id: `call_edit_${idPrefix}_${editIndex}`,
      type: "function",
      function: {
        name: "edit_file",
        arguments: "",
      },
    });
  }

  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [
        {
          index: 0,
          delta: { tool_calls: toolCalls },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );

  const argumentCalls = [];
  for (const [editIndex, edit] of edits.entries()) {
    argumentCalls.push({
      index: editIndex,
      function: {
        arguments: JSON.stringify({
          path: edit.path,
          limit: 20,
        }),
      },
    });
  }
  for (const [editIndex, edit] of edits.entries()) {
    argumentCalls.push({
      index: edits.length + editIndex,
      function: {
        arguments: JSON.stringify({
          path: edit.path,
          old_string: edit.oldString,
          new_string: edit.newString,
        }),
      },
    });
  }

  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [
        {
          index: 0,
          delta: { tool_calls: argumentCalls },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 23, completion_tokens: 8 },
    })}\n\n`,
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function waitFor(predicate, description, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

module.exports = { run };
