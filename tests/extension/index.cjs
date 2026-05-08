const assert = require("node:assert/strict");
const http = require("node:http");
const vscode = require("vscode");

const EXTENSION_ID = "trevorwood.pocketai-vscode";

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
    await assertEditApprovalVisualStateRoundTrip();
    await assertEditRejectionVisualStateRoundTrip();
    await assertStaleEditVisualStateRoundTrip();
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
  if (
    /Exercise stale edit visual coverage/.test(serializedMessages) &&
    /pending edit no longer matches the current file contents/.test(serializedMessages)
  ) {
    sendTextChatResponse(response, "Stale edit coverage complete.");
    return;
  }
  if (/Exercise stale edit visual coverage/.test(serializedMessages)) {
    sendStructuredEditFileToolCalls(response, {
      idPrefix: "stale",
      path: "stale-target.js",
      oldString: "export const stale = 1;",
      newString: "export const stale = 2;",
    });
    return;
  }
  if (
    /Exercise edit rejection visual coverage/.test(serializedMessages) &&
    /User rejected this change/.test(serializedMessages)
  ) {
    sendTextChatResponse(response, "Edit rejection coverage complete.");
    return;
  }
  if (/Exercise edit rejection visual coverage/.test(serializedMessages)) {
    sendStructuredEditFileToolCalls(response, {
      idPrefix: "reject",
      path: "reject-target.js",
      oldString: "export const rejected = 1;",
      newString: "export const rejected = 2;",
    });
    return;
  }
  if (
    /Exercise edit approval visual coverage/.test(serializedMessages) &&
    /Successfully edited `editable-target\.js`/.test(serializedMessages)
  ) {
    sendTextChatResponse(response, "Edit approval coverage complete.");
    return;
  }
  if (/Exercise edit approval visual coverage/.test(serializedMessages)) {
    sendStructuredEditFileToolCalls(response, {
      idPrefix: "approve",
      path: "editable-target.js",
      oldString: "export const value = 1;",
      newString: "export const value = 2;",
    });
    return;
  }
  if (
    /Exercise structured action summaries/.test(serializedMessages) &&
    !/PocketAI Extension Test Workspace/.test(serializedMessages)
  ) {
    sendStructuredReadFileToolCall(response);
    return;
  }
  if (
    /Exercise structured action summaries/.test(serializedMessages) &&
    /PocketAI Extension Test Workspace/.test(serializedMessages)
  ) {
    sendTextChatResponse(response, "Structured action summary complete.");
    return;
  }
  sendTextChatResponse(response, "Fake endpoint saw the selected code.");
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
