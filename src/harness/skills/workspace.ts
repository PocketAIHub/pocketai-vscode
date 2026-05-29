import * as fs from "fs";
import * as path from "path";

export type WorkspaceSkillSupportKind =
  | "references"
  | "templates"
  | "scripts"
  | "assets";

export type WorkspaceSkillSupportFile = {
  path: string;
  absolutePath: string;
  kind: WorkspaceSkillSupportKind;
  sizeBytes: number;
};

export type WorkspaceSkillFrontmatter = {
  name?: string;
  description?: string;
  platforms?: string[];
  tags?: string[];
  category?: string;
  relatedSkills?: string[];
};

export type ParsedWorkspaceSkill = {
  frontmatter: WorkspaceSkillFrontmatter;
  body: string;
};

export type InstalledWorkspaceSkill = {
  id: string;
  path?: string;
};

export type WorkspaceSkillCandidate = {
  id: string;
  name: string;
  description: string;
  sourcePath: string;
  skillFile: string;
  skillDir: string;
  supportFileCount: number;
  supportFiles: WorkspaceSkillSupportFile[];
  category?: string;
  tags?: string[];
  relatedSkills?: string[];
  conflict: "none" | "installed";
  conflictPath?: string;
};

export type WorkspaceSkillScanResult =
  | {
      ok: true;
      scanPath: string;
      candidates: WorkspaceSkillCandidate[];
    }
  | {
      ok: false;
      scanPath: string;
      error: string;
    };

export type WorkspaceSkillInstallResult =
  | {
      ok: true;
      id: string;
      name: string;
      installedPath: string;
      supportFileCount: number;
      skippedSymlinkCount: number;
    }
  | {
      ok: false;
      error: string;
    };

export type ManagedWorkspaceSkill = {
  id: string;
  name: string;
  description: string;
  path: string;
  skillFile: string;
  skillDir: string;
  status: "enabled" | "disabled";
  supportFileCount: number;
  supportFiles: WorkspaceSkillSupportFile[];
  category?: string;
  tags?: string[];
  relatedSkills?: string[];
  markerError?: string;
};

export type WorkspaceSkillManageAction = "list" | "enable" | "disable";

export type WorkspaceSkillManageResult =
  | {
      ok: true;
      action: "list";
      skills: ManagedWorkspaceSkill[];
    }
  | {
      ok: true;
      action: "enable" | "disable";
      skill: ManagedWorkspaceSkill;
      markerPath: string;
      changed: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export const WORKSPACE_SKILL_DISABLED_MARKER = ".pocketai-disabled";
const MAX_SKILL_FILE_VIEW_BYTES = 1024 * 1024;

const JUNK_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);

export const WORKSPACE_SKILL_SUPPORT_DIRS: WorkspaceSkillSupportKind[] = [
  "references",
  "templates",
  "scripts",
  "assets",
];

type FrontmatterValue = string | string[];

export function findWorkspaceSkillRoots(
  workspaceRoots: readonly string[],
): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();

  for (const workspaceRoot of workspaceRoots) {
    let current = path.resolve(workspaceRoot);

    while (true) {
      const skillsRoot = path.join(current, ".pocketai", "skills");
      if (isDirectory(skillsRoot)) {
        const resolved = path.resolve(skillsRoot);
        if (!seen.has(resolved)) {
          seen.add(resolved);
          roots.push(skillsRoot);
        }
      }

      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return roots;
}

export function discoverWorkspaceSkillFiles(skillsRoot: string): string[] {
  const root = path.resolve(skillsRoot);
  const skillFiles = new Set<string>();

  function walk(directory: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (JUNK_DIRS.has(entry.name)) continue;
        walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;

      const lowerName = entry.name.toLowerCase();
      if (lowerName === "skill.md") {
        skillFiles.add(absolutePath);
      } else if (
        path.resolve(directory) === root &&
        lowerName.endsWith(".md")
      ) {
        skillFiles.add(absolutePath);
      }
    }
  }

  walk(root);
  return Array.from(skillFiles).sort((a, b) => a.localeCompare(b));
}

export function readWorkspaceSkillSupportFiles(
  skillDir: string,
): WorkspaceSkillSupportFile[] {
  const supportFiles: WorkspaceSkillSupportFile[] = [];

  for (const kind of WORKSPACE_SKILL_SUPPORT_DIRS) {
    const supportRoot = path.join(skillDir, kind);
    if (!isDirectory(supportRoot)) continue;
    collectSupportFiles(skillDir, supportRoot, kind, supportFiles);
  }

  return supportFiles.sort((a, b) => a.path.localeCompare(b.path));
}

export function scanWorkspaceSkillCandidates(
  scanPath: string,
  installedSkills: readonly InstalledWorkspaceSkill[] = [],
): WorkspaceSkillScanResult {
  const resolvedScanPath = path.resolve(scanPath);
  const stat = safeLstat(resolvedScanPath);
  if (!stat) {
    return {
      ok: false,
      scanPath: resolvedScanPath,
      error: `Skill scan path does not exist: ${resolvedScanPath}`,
    };
  }
  if (stat.isSymbolicLink()) {
    return {
      ok: false,
      scanPath: resolvedScanPath,
      error: `Skill scan path is a symlink and was not scanned: ${resolvedScanPath}`,
    };
  }
  if (!stat.isDirectory() && !stat.isFile()) {
    return {
      ok: false,
      scanPath: resolvedScanPath,
      error: `Skill scan path is not a regular file or directory: ${resolvedScanPath}`,
    };
  }

  const skillFiles = stat.isFile()
    ? isSkillMarkdownFile(resolvedScanPath)
      ? [resolvedScanPath]
      : []
    : discoverWorkspaceSkillFiles(resolvedScanPath);
  const installedById = new Map(
    installedSkills.map((skill) => [normalizeSkillId(skill.id), skill]),
  );

  const candidates = skillFiles
    .map((skillFile) => readSkillCandidate(skillFile, installedById))
    .filter((candidate): candidate is WorkspaceSkillCandidate => !!candidate)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { ok: true, scanPath: resolvedScanPath, candidates };
}

export function listManagedWorkspaceSkills(
  workspaceRoots: readonly string[],
): ManagedWorkspaceSkill[] {
  const skillsRoots = findWorkspaceSkillRoots(workspaceRoots);
  return listManagedWorkspaceSkillsFromRoots(skillsRoots);
}

export function listManagedWorkspaceSkillsFromRoots(
  skillsRoots: readonly string[],
): ManagedWorkspaceSkill[] {
  const skillFiles = new Set<string>();

  for (const skillsRoot of skillsRoots) {
    const rootStat = safeLstat(skillsRoot);
    if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      continue;
    }
    for (const skillFile of discoverWorkspaceSkillFiles(skillsRoot)) {
      skillFiles.add(skillFile);
    }
  }

  return Array.from(skillFiles)
    .map((skillFile) => readManagedWorkspaceSkill(skillFile))
    .filter((skill): skill is ManagedWorkspaceSkill => !!skill)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function manageWorkspaceSkill(options: {
  workspaceRoots: readonly string[];
  action: WorkspaceSkillManageAction;
  skillId?: string;
  builtinSkillIds?: readonly string[];
}): WorkspaceSkillManageResult {
  const managedSkills = listManagedWorkspaceSkills(options.workspaceRoots);
  if (options.action === "list") {
    return { ok: true, action: "list", skills: managedSkills };
  }

  const skillId = normalizeSkillId(options.skillId || "");
  if (!skillId) {
    return {
      ok: false,
      error: `No skill id was provided for skill_manage ${options.action}.`,
    };
  }

  const skill = managedSkills.find((candidate) => candidate.id === skillId);
  const isBuiltinSkill = options.builtinSkillIds?.some(
    (builtinId) => normalizeSkillId(builtinId) === skillId,
  );

  if (!skill && isBuiltinSkill) {
    return {
      ok: false,
      error: `Cannot ${options.action} built-in skill "${skillId}". Only installed workspace skills can be managed.`,
    };
  }

  if (!skill) {
    return {
      ok: false,
      error: `Unknown installed workspace skill "${skillId}". Use skill_manage list to inspect installed skills.`,
    };
  }

  const marker = resolveDisabledMarkerPath(skill.skillDir);
  if (!marker.ok) return { ok: false, error: marker.error };
  if (skill.markerError) return { ok: false, error: skill.markerError };

  if (options.action === "disable") {
    if (skill.status === "disabled") {
      return {
        ok: true,
        action: "disable",
        skill,
        markerPath: marker.path,
        changed: false,
      };
    }

    try {
      fs.writeFileSync(
        marker.path,
        "Disabled by PocketAI skill_manage.\n",
        { flag: "wx" },
      );
    } catch (error) {
      return {
        ok: false,
        error: `Could not disable skill "${skill.id}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    return {
      ok: true,
      action: "disable",
      skill: { ...skill, status: "disabled" },
      markerPath: marker.path,
      changed: true,
    };
  }

  if (skill.status === "enabled") {
    return {
      ok: true,
      action: "enable",
      skill,
      markerPath: marker.path,
      changed: false,
    };
  }

  try {
    fs.unlinkSync(marker.path);
  } catch (error) {
    return {
      ok: false,
      error: `Could not enable skill "${skill.id}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return {
    ok: true,
    action: "enable",
    skill: { ...skill, status: "enabled" },
    markerPath: marker.path,
    changed: true,
  };
}

export function isWorkspaceSkillDisabled(skillDir: string): boolean {
  const state = readDisabledMarkerState(skillDir);
  return state.status === "disabled";
}

export function resolveWorkspaceSkillsRoot(workspaceRoot: string): string {
  return (
    findWorkspaceSkillRoots([workspaceRoot])[0] ??
    path.join(path.resolve(workspaceRoot), ".pocketai", "skills")
  );
}

export function installWorkspaceSkillFromPath(options: {
  sourcePath: string;
  workspaceRoot: string;
  desiredId?: string;
}): WorkspaceSkillInstallResult {
  const resolvedSourcePath = path.resolve(options.sourcePath);
  const source = resolveInstallSource(resolvedSourcePath);
  if (!source.ok) return { ok: false, error: source.error };

  let rawPrompt: string;
  try {
    rawPrompt = fs.readFileSync(source.skillFile, "utf-8").trim();
  } catch (error) {
    return {
      ok: false,
      error: `Could not read skill file "${source.skillFile}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!rawPrompt) {
    return { ok: false, error: `Skill file is empty: ${source.skillFile}` };
  }

  const parsed = parseWorkspaceSkill(rawPrompt);
  const fallbackId = skillBaseNameForPath(source.skillFile);
  const id = normalizeSkillId(
    options.desiredId || parsed.frontmatter.name || fallbackId,
  );
  if (!id) {
    return {
      ok: false,
      error: `Could not determine a safe skill id for ${source.skillFile}.`,
    };
  }

  const skillsRoot = resolveWorkspaceSkillsRoot(options.workspaceRoot);
  const skillsRootStat = safeLstat(skillsRoot);
  if (skillsRootStat?.isSymbolicLink()) {
    return {
      ok: false,
      error: `Workspace skills root is a symlink and cannot be used for install: ${skillsRoot}`,
    };
  }
  if (skillsRootStat && !skillsRootStat.isDirectory()) {
    return {
      ok: false,
      error: `Workspace skills root is not a directory: ${skillsRoot}`,
    };
  }

  const destinationDir = path.join(skillsRoot, id);
  if (!isPathInside(skillsRoot, destinationDir)) {
    return {
      ok: false,
      error: `Rejected install destination outside skills root: ${destinationDir}`,
    };
  }

  if (fs.existsSync(destinationDir)) {
    return {
      ok: false,
      error: `Skill "${id}" is already installed at ${destinationDir}. Remove it first or choose a different id.`,
    };
  }

  const stagingDir = path.join(
    skillsRoot,
    `.${id}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.copyFileSync(source.skillFile, path.join(stagingDir, "SKILL.md"));

    let skippedSymlinkCount = 0;
    for (const supportDir of WORKSPACE_SKILL_SUPPORT_DIRS) {
      const sourceSupportDir = path.join(source.skillDir, supportDir);
      const supportStat = safeLstat(sourceSupportDir);
      if (!supportStat) continue;
      if (supportStat.isSymbolicLink()) {
        skippedSymlinkCount += 1;
        continue;
      }
      if (!supportStat.isDirectory()) continue;

      skippedSymlinkCount += copyDirectorySkippingSymlinks(
        sourceSupportDir,
        path.join(stagingDir, supportDir),
      );
    }

    if (fs.existsSync(destinationDir)) {
      throw new Error(`Install destination was created concurrently: ${destinationDir}`);
    }
    fs.mkdirSync(skillsRoot, { recursive: true });
    fs.renameSync(stagingDir, destinationDir);

    const supportFiles = readWorkspaceSkillSupportFiles(destinationDir);
    return {
      ok: true,
      id,
      name: humanizeSkillName(id),
      installedPath: destinationDir,
      supportFileCount: supportFiles.length,
      skippedSymlinkCount,
    };
  } catch (error) {
    safeRemoveDirectory(stagingDir);
    return {
      ok: false,
      error: `Could not install skill "${id}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export function parseWorkspaceSkill(prompt: string): ParsedWorkspaceSkill {
  if (!prompt.startsWith("---")) {
    return { frontmatter: {}, body: prompt };
  }

  const rest = prompt.slice(3);
  const endMatch = rest.match(/\n---\s*\n/);
  if (!endMatch || endMatch.index === undefined) {
    return { frontmatter: {}, body: prompt };
  }

  const frontmatterText = rest.slice(0, endMatch.index);
  const body = rest.slice(endMatch.index + endMatch[0].length);
  return {
    frontmatter: parseSimpleFrontmatter(frontmatterText),
    body,
  };
}

export function skillMatchesCurrentPlatform(
  platforms: string[] | undefined,
): boolean {
  if (!platforms || platforms.length === 0) return true;

  const current = normalizePlatform(process.platform);
  return platforms.some(
    (platformName) => normalizePlatform(platformName) === current,
  );
}

export function normalizeSkillRelativePath(value: string): string | undefined {
  const raw = value.trim().replace(/\\/g, "/");
  if (
    !raw ||
    raw.startsWith("/") ||
    /^[a-zA-Z]:\//.test(raw) ||
    raw.split("/").includes("..")
  ) {
    return undefined;
  }

  const normalized = path.posix.normalize(raw).replace(/^\/+/, "");
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".."
  ) {
    return undefined;
  }

  return normalized;
}

export function normalizeSkillId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
}

export function isPathInside(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(
    path.resolve(rootPath),
    path.resolve(targetPath),
  );
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function isSkillFileTooLargeForView(filePath: string): boolean {
  try {
    return fs.statSync(filePath).size > MAX_SKILL_FILE_VIEW_BYTES;
  } catch {
    return false;
  }
}

function collectSupportFiles(
  skillDir: string,
  directory: string,
  kind: WorkspaceSkillSupportKind,
  supportFiles: WorkspaceSkillSupportFile[],
) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (JUNK_DIRS.has(entry.name)) continue;
      collectSupportFiles(skillDir, absolutePath, kind, supportFiles);
      continue;
    }

    if (!entry.isFile()) continue;

    try {
      const stat = fs.statSync(absolutePath);
      supportFiles.push({
        path: toPosixRelativePath(skillDir, absolutePath),
        absolutePath,
        kind,
        sizeBytes: stat.size,
      });
    } catch {
      // Ignore files that disappear during discovery.
    }
  }
}

function readSkillCandidate(
  skillFile: string,
  installedById: ReadonlyMap<string, InstalledWorkspaceSkill>,
): WorkspaceSkillCandidate | undefined {
  try {
    const rawPrompt = fs.readFileSync(skillFile, "utf-8").trim();
    if (!rawPrompt) return undefined;

    const parsed = parseWorkspaceSkill(rawPrompt);
    if (!skillMatchesCurrentPlatform(parsed.frontmatter.platforms)) {
      return undefined;
    }

    const skillDir = path.dirname(skillFile);
    const fallbackId = skillBaseNameForPath(skillFile);
    const id = normalizeSkillId(parsed.frontmatter.name || fallbackId);
    if (!id) return undefined;

    const supportFiles = readWorkspaceSkillSupportFiles(skillDir);
    const installed = installedById.get(id);

    return {
      id,
      name: humanizeSkillName(id),
      description:
        parsed.frontmatter.description ||
        summarizeSkillText(parsed.body || rawPrompt),
      sourcePath: skillFile,
      skillFile,
      skillDir,
      supportFileCount: supportFiles.length,
      supportFiles,
      category: parsed.frontmatter.category,
      tags: parsed.frontmatter.tags,
      relatedSkills: parsed.frontmatter.relatedSkills,
      conflict: installed ? "installed" : "none",
      conflictPath: installed?.path,
    };
  } catch {
    return undefined;
  }
}

function readManagedWorkspaceSkill(
  skillFile: string,
): ManagedWorkspaceSkill | undefined {
  try {
    const rawPrompt = fs.readFileSync(skillFile, "utf-8").trim();
    if (!rawPrompt) return undefined;

    const parsed = parseWorkspaceSkill(rawPrompt);
    const skillDir = path.dirname(skillFile);
    const fallbackId = skillBaseNameForPath(skillFile);
    const id = normalizeSkillId(parsed.frontmatter.name || fallbackId);
    if (!id) return undefined;

    const supportFiles = readWorkspaceSkillSupportFiles(skillDir);
    const markerState = readDisabledMarkerState(skillDir);

    return {
      id,
      name: humanizeSkillName(id),
      description:
        parsed.frontmatter.description ||
        summarizeSkillText(parsed.body || rawPrompt),
      path: skillFile,
      skillFile,
      skillDir,
      status: markerState.status,
      supportFileCount: supportFiles.length,
      supportFiles,
      category: parsed.frontmatter.category,
      tags: parsed.frontmatter.tags,
      relatedSkills: parsed.frontmatter.relatedSkills,
      markerError: markerState.error,
    };
  } catch {
    return undefined;
  }
}

function readDisabledMarkerState(
  skillDir: string,
): { status: "enabled" | "disabled"; error?: string } {
  const marker = resolveDisabledMarkerPath(skillDir);
  if (!marker.ok) return { status: "disabled", error: marker.error };

  const markerStat = safeLstat(marker.path);
  if (!markerStat) return { status: "enabled" };
  if (markerStat.isSymbolicLink()) {
    return {
      status: "disabled",
      error: `Disabled marker is a symlink and cannot be managed safely: ${marker.path}`,
    };
  }
  if (!markerStat.isFile()) {
    return {
      status: "disabled",
      error: `Disabled marker is not a regular file: ${marker.path}`,
    };
  }

  return { status: "disabled" };
}

function resolveDisabledMarkerPath(
  skillDir: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const skillDirStat = safeLstat(skillDir);
  if (!skillDirStat) {
    return { ok: false, error: `Skill directory does not exist: ${skillDir}` };
  }
  if (skillDirStat.isSymbolicLink()) {
    return {
      ok: false,
      error: `Skill directory is a symlink and cannot be managed safely: ${skillDir}`,
    };
  }
  if (!skillDirStat.isDirectory()) {
    return {
      ok: false,
      error: `Skill path is not a directory: ${skillDir}`,
    };
  }

  const markerPath = path.join(skillDir, WORKSPACE_SKILL_DISABLED_MARKER);
  if (
    path.basename(markerPath) !== WORKSPACE_SKILL_DISABLED_MARKER ||
    !isPathInside(skillDir, markerPath)
  ) {
    return {
      ok: false,
      error: `Rejected disabled marker path outside skill directory: ${markerPath}`,
    };
  }

  return { ok: true, path: markerPath };
}

function resolveInstallSource(
  sourcePath: string,
):
  | { ok: true; skillFile: string; skillDir: string }
  | { ok: false; error: string } {
  const stat = safeLstat(sourcePath);
  if (!stat) {
    return { ok: false, error: `Skill install path does not exist: ${sourcePath}` };
  }
  if (stat.isSymbolicLink()) {
    return {
      ok: false,
      error: `Skill install path is a symlink and was not installed: ${sourcePath}`,
    };
  }

  if (stat.isDirectory()) {
    const skillFile = path.join(sourcePath, "SKILL.md");
    const skillStat = safeLstat(skillFile);
    if (!skillStat) {
      return {
        ok: false,
        error: `Skill directory does not contain SKILL.md: ${sourcePath}`,
      };
    }
    if (skillStat.isSymbolicLink()) {
      return {
        ok: false,
        error: `Skill file is a symlink and was not installed: ${skillFile}`,
      };
    }
    if (!skillStat.isFile()) {
      return { ok: false, error: `SKILL.md is not a regular file: ${skillFile}` };
    }
    return { ok: true, skillFile, skillDir: sourcePath };
  }

  if (!stat.isFile()) {
    return {
      ok: false,
      error: `Skill install path is not a regular file or directory: ${sourcePath}`,
    };
  }
  if (!isSkillMarkdownFile(sourcePath)) {
    return {
      ok: false,
      error: `Skill install path must be a SKILL.md or .md file: ${sourcePath}`,
    };
  }

  return { ok: true, skillFile: sourcePath, skillDir: path.dirname(sourcePath) };
}

function copyDirectorySkippingSymlinks(
  sourceDir: string,
  destinationDir: string,
): number {
  let skippedSymlinkCount = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch {
    return skippedSymlinkCount;
  }

  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    if (!isPathInside(destinationDir, destinationPath)) continue;
    if (entry.isSymbolicLink()) {
      skippedSymlinkCount += 1;
      continue;
    }
    if (entry.isDirectory()) {
      if (JUNK_DIRS.has(entry.name)) continue;
      skippedSymlinkCount += copyDirectorySkippingSymlinks(
        sourcePath,
        destinationPath,
      );
      continue;
    }
    if (!entry.isFile()) continue;
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
  }

  return skippedSymlinkCount;
}

function parseSimpleFrontmatter(text: string): WorkspaceSkillFrontmatter {
  const fields = parseYamlSubset(text);

  return {
    name: readStringField(fields, "name", "metadata.hermes.name"),
    description: readStringField(
      fields,
      "description",
      "metadata.hermes.description",
    ),
    platforms: readListField(fields, "platforms", "metadata.hermes.platforms"),
    tags: readListField(fields, "tags", "metadata.hermes.tags"),
    category: readStringField(fields, "category", "metadata.hermes.category"),
    relatedSkills: readListField(
      fields,
      "related_skills",
      "relatedSkills",
      "metadata.hermes.related_skills",
      "metadata.hermes.relatedSkills",
    ),
  };
}

function isSkillMarkdownFile(filePath: string): boolean {
  const lowerName = path.basename(filePath).toLowerCase();
  return lowerName === "skill.md" || lowerName.endsWith(".md");
}

function skillBaseNameForPath(filePath: string): string {
  return path.basename(filePath).toLowerCase() === "skill.md"
    ? path.basename(path.dirname(filePath))
    : path.basename(filePath, path.extname(filePath));
}

function humanizeSkillName(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function summarizeSkillText(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Reusable workflow.";
  const firstSentence = cleaned.split(/(?<=[.!?])\s+/)[0] || cleaned;
  return firstSentence.length > 140
    ? `${firstSentence.slice(0, 137).trimEnd()}...`
    : firstSentence;
}

function safeLstat(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch {
    return undefined;
  }
}

function safeRemoveDirectory(directory: string) {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup for failed staging installs.
  }
}

function parseYamlSubset(text: string): Map<string, FrontmatterValue> {
  const fields = new Map<string, FrontmatterValue>();
  const stack: Array<{ indent: number; key: string }> = [];
  let pendingListPath: string[] | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;

    const indent = countIndent(rawLine);
    const line = rawLine.trim();

    while (stack.length && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    if (line.startsWith("- ") && pendingListPath) {
      appendListField(fields, pendingListPath, line.slice(2));
      continue;
    }

    pendingListPath = undefined;
    const separator = line.indexOf(":");
    if (separator < 0) continue;

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!key) continue;

    const currentPath = [...stack.map((item) => item.key), key];
    if (rawValue) {
      fields.set(currentPath.join("."), parseFrontmatterValue(rawValue));
      continue;
    }

    stack.push({ indent, key });
    pendingListPath = currentPath;
  }

  return fields;
}

function readStringField(
  fields: Map<string, FrontmatterValue>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = fields.get(key);
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  return undefined;
}

function readListField(
  fields: Map<string, FrontmatterValue>,
  ...keys: string[]
): string[] | undefined {
  for (const key of keys) {
    const value = fields.get(key);
    if (Array.isArray(value)) {
      const items = value.map((item) => item.trim()).filter(Boolean);
      if (items.length) return items;
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      return [value.trim()];
    }
  }

  return undefined;
}

function appendListField(
  fields: Map<string, FrontmatterValue>,
  pathParts: string[],
  value: string,
) {
  const key = pathParts.join(".");
  const existing = fields.get(key);
  const list = Array.isArray(existing) ? existing : [];
  const item = parseScalarValue(value);
  if (item) fields.set(key, [...list, item]);
}

function parseFrontmatterValue(value: string): FrontmatterValue {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => parseScalarValue(item))
      .filter(Boolean);
  }

  return parseScalarValue(trimmed);
}

function parseScalarValue(value: string): string {
  const trimmed = stripInlineComment(value.trim());
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stripInlineComment(value: string): string {
  if (value.startsWith("\"") || value.startsWith("'")) return value;
  const commentIndex = value.indexOf(" #");
  return commentIndex >= 0 ? value.slice(0, commentIndex).trimEnd() : value;
}

function normalizePlatform(platformName: string): string {
  const normalized = platformName.trim().toLowerCase();
  if (normalized === "darwin") return "macos";
  if (normalized === "win32") return "windows";
  return normalized;
}

function countIndent(value: string): number {
  const match = value.match(/^\s*/);
  return match ? match[0].replace(/\t/g, "  ").length : 0;
}

function toPosixRelativePath(rootPath: string, targetPath: string): string {
  return path.relative(rootPath, targetPath).split(path.sep).join("/");
}

function isDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}
