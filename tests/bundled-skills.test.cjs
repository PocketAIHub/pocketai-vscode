const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadSkillRegistryWithVscodeStub() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") {
      return { workspace: { workspaceFolders: [] } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const registryPath = require.resolve("../dist/harness/skills/registry.js");
    delete require.cache[registryPath];
    return require(registryPath);
  } finally {
    Module._load = originalLoad;
  }
}

test("bundled Hermes SKILL.md files load without workspace .pocketai skills", () => {
  const { formatHarnessSkillView, listHarnessSkills } =
    loadSkillRegistryWithVscodeStub();

  const skills = listHarnessSkills();
  const codex = skills.find((skill) => skill.id === "codex");
  const githubPr = skills.find((skill) => skill.id === "github-pr-workflow");

  assert.equal(codex?.source, "builtin");
  assert.match(codex?.content || "", /name: codex/);
  assert.equal(githubPr?.source, "builtin");
  assert.ok(
    githubPr?.supportFiles?.some(
      (file) => file.path === "templates/pr-body-feature.md",
    ),
  );

  const supportFileView = formatHarnessSkillView(
    githubPr,
    "templates/pr-body-feature.md",
  );
  assert.match(supportFileView, /Source: builtin/);
  assert.match(supportFileView, /--- BEGIN SKILL FILE ---/);
});
