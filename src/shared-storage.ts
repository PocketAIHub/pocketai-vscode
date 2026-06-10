import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type SharedProjectStorage = {
  projectId: string;
  projectRoot: string;
  workspaceRoot: string;
  memoryDir: string;
  vaultDir: string;
  skillsDir: string;
  mcpFile: string;
};

export const POCKETAI_HOME_ENV = "POCKETAI_HOME";

export function getPocketAiSharedRoot(): string {
  const override = process.env[POCKETAI_HOME_ENV]?.trim();
  if (override) return path.resolve(expandHome(override));

  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "PocketAI");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      "PocketAI",
    );
  }
  return path.join(
    process.env.XDG_DATA_HOME || path.join(home, ".local", "share"),
    "PocketAI",
  );
}

export function getSharedProjectStorage(
  workspaceRoot: string,
): SharedProjectStorage {
  const canonicalRoot = canonicalWorkspacePath(workspaceRoot);
  const projectId = projectIdForWorkspaceRoot(canonicalRoot);
  const projectRoot = path.join(getPocketAiSharedRoot(), "projects", projectId);
  return {
    projectId,
    projectRoot,
    workspaceRoot: canonicalRoot,
    memoryDir: path.join(projectRoot, "memory"),
    vaultDir: path.join(projectRoot, "vault"),
    skillsDir: path.join(projectRoot, "skills"),
    mcpFile: path.join(projectRoot, "mcp.json"),
  };
}

export function ensureSharedProjectStorage(
  workspaceRoot: string,
): SharedProjectStorage {
  const storage = getSharedProjectStorage(workspaceRoot);
  fs.mkdirSync(storage.projectRoot, { recursive: true });
  const metadataPath = path.join(storage.projectRoot, "project.json");
  if (!fs.existsSync(metadataPath)) {
    fs.writeFileSync(
      metadataPath,
      `${JSON.stringify(
        {
          version: 1,
          projectId: storage.projectId,
          workspaceRoot: storage.workspaceRoot,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
  }
  return storage;
}

export function legacyPocketAiDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".pocketai");
}

export function formatSharedProjectPath(
  workspaceRoot: string,
  filePath: string,
): string {
  const normalizedFile = path.resolve(filePath);
  const workspaceRelative = relativeInside(workspaceRoot, normalizedFile);
  if (workspaceRelative !== undefined) return workspaceRelative || ".";

  const storage = getSharedProjectStorage(workspaceRoot);
  const projectRelative = relativeInside(storage.projectRoot, normalizedFile);
  if (projectRelative !== undefined) {
    return `PocketAI project storage/${projectRelative || "."}`;
  }

  return normalizedFile;
}

export function copyDirectoryContentsIfMissing(
  sourceDir: string,
  destinationDir: string,
): void {
  if (!fs.existsSync(sourceDir) || fs.existsSync(destinationDir)) return;
  copyDirectory(sourceDir, destinationDir);
}

function canonicalWorkspacePath(workspaceRoot: string): string {
  const resolved = path.resolve(expandHome(workspaceRoot));
  try {
    return normalizeForProjectId(fs.realpathSync.native(resolved));
  } catch {
    return normalizeForProjectId(resolved);
  }
}

function projectIdForWorkspaceRoot(canonicalRoot: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(canonicalRoot)
    .digest("hex")
    .slice(0, 12);
  const slug =
    path
      .basename(canonicalRoot)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project";
  return `${slug}-${hash}`;
}

function normalizeForProjectId(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function relativeInside(rootPath: string, targetPath: string): string | undefined {
  const relative = path
    .relative(path.resolve(rootPath), path.resolve(targetPath))
    .split(path.sep)
    .join("/");
  if (
    relative === "" ||
    (!!relative && !relative.startsWith("../") && relative !== "..")
  ) {
    return relative;
  }
  return undefined;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function copyDirectory(sourceDir: string, destinationDir: string): void {
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile() && !fs.existsSync(destinationPath)) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}
