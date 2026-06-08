const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

async function importScript(name) {
  return import(pathToFileURL(path.join(root, "scripts", name)));
}

test("CLI bridge scripts advertise streaming chat completions", async () => {
  const scripts = [
    "claude-openai-bridge.mjs",
    "cursor-openai-bridge.mjs",
    "opencode-openai-bridge.mjs",
    "deepseek-openai-bridge.mjs",
  ];

  for (const script of scripts) {
    const mod = await importScript(script);
    assert.deepEqual(mod.createBridgeInfoPayload().capabilities, {
      streamingChatCompletions: true,
    });
  }
});

test("Cursor and Claude bridge scripts use live streaming CLI formats", async () => {
  const cursor = await importScript("cursor-openai-bridge.mjs");
  const cursorArgs = cursor.buildCursorArgs({
    prompt: "hello",
    model: "composer-2.5",
    stream: true,
  });
  assert.equal(cursorArgs[cursorArgs.indexOf("--output-format") + 1], "stream-json");

  const claude = await importScript("claude-openai-bridge.mjs");
  const claudeArgs = claude.buildClaudeArgs({
    prompt: "hello",
    model: "sonnet",
    stream: true,
  });
  assert.equal(claudeArgs[claudeArgs.indexOf("--output-format") + 1], "stream-json");
  assert.equal(claudeArgs.includes("--include-partial-messages"), true);
});

test("OpenCode bridge script uses JSON run events and DeepSeek keeps VS Code port", async () => {
  const opencode = await importScript("opencode-openai-bridge.mjs");
  const opencodeArgs = opencode.buildOpenCodeArgs({
    prompt: "hello",
    model: "opencode-go/glm-5.1",
  });
  assert.equal(opencodeArgs[opencodeArgs.indexOf("--format") + 1], "json");

  const deepseekSource = fs.readFileSync(
    path.join(root, "scripts", "deepseek-openai-bridge.mjs"),
    "utf8",
  );
  assert.match(deepseekSource, /DEEPSEEK_BRIDGE_PORT \|\| "39464"/);
});
