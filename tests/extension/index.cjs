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

async function sendTestPrompt(prompt) {
  const snapshot = await vscode.commands.executeCommand(
    "pocketai.test.sendPrompt",
    prompt,
  );
  assert(snapshot, "Expected test prompt command to return a session snapshot.");
  return snapshot;
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
      sendSseChatResponse(response);
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

function sendSseChatResponse(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(
    `data: ${JSON.stringify({
      model: "pocketai-test-model",
      choices: [
        {
          index: 0,
          delta: { content: "Fake endpoint saw the selected code." },
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
