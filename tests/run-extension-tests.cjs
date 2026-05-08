const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runTests } = require("@vscode/test-electron");

function findLocalVSCodeExecutable() {
  if (process.env.VSCODE_TEST_EXECUTABLE) {
    return process.env.VSCODE_TEST_EXECUTABLE;
  }

  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
          path.join(
            os.homedir(),
            "Applications",
            "Visual Studio Code.app",
            "Contents",
            "MacOS",
            "Electron",
          ),
        ]
      : [];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "..");
  const extensionTestsPath = path.resolve(__dirname, "extension", "index.cjs");
  const vscodeExecutablePath = findLocalVSCodeExecutable();
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), "pocketai-vscode-test-"),
  );
  const userDataPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "pocketai-vscode-user-data-"),
  );

  fs.writeFileSync(
    path.join(workspacePath, "README.md"),
    "# PocketAI Extension Test Workspace\n",
  );

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
      launchArgs: [
        workspacePath,
        "--user-data-dir",
        userDataPath,
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
      ],
    });
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
