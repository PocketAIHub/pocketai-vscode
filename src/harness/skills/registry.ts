import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { listBuiltinHarnessSkills } from "./builtins";
import {
  discoverWorkspaceSkillFiles,
  findWorkspaceSkillRoots,
  isPathInside,
  isSkillFileTooLargeForView,
  isWorkspaceSkillDisabled,
  normalizeSkillId,
  normalizeSkillRelativePath,
  parseWorkspaceSkill,
  readWorkspaceSkillSupportFiles,
  skillMatchesCurrentPlatform,
  type WorkspaceSkillSupportFile,
} from "./workspace";

export type HarnessSkillDescriptor = {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "workspace";
  prompt: string;
  path?: string;
  content?: string;
  skillDir?: string;
  platforms?: string[];
  tags?: string[];
  category?: string;
  relatedSkills?: string[];
  supportFiles?: WorkspaceSkillSupportFile[];
};

export function listHarnessSkills(): HarnessSkillDescriptor[] {
  return [...listBuiltinSkills(), ...listWorkspaceSkills()];
}

export function getHarnessSkillById(skillId: string): HarnessSkillDescriptor | undefined {
  const normalized = normalizeSkillId(skillId);
  return listHarnessSkills().find((skill) => skill.id === normalized);
}

function listBuiltinSkills(): HarnessSkillDescriptor[] {
  return listBuiltinHarnessSkills().map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: "builtin",
    prompt: skill.prompt,
    content: skill.prompt,
    supportFiles: [],
  }));
}

function listWorkspaceSkills(): HarnessSkillDescriptor[] {
  const workspaceRoots =
    vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  if (workspaceRoots.length === 0) return [];

  const skillsRoots = findWorkspaceSkillRoots(workspaceRoots);
  const skillFiles = new Set<string>();

  for (const skillsRoot of skillsRoots) {
    for (const filePath of discoverWorkspaceSkillFiles(skillsRoot)) {
      skillFiles.add(filePath);
    }
  }

  return Array.from(skillFiles)
    .map((filePath) => readWorkspaceSkill(filePath))
    .filter((skill): skill is HarnessSkillDescriptor => !!skill)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readWorkspaceSkill(filePath: string): HarnessSkillDescriptor | undefined {
  try {
    const rawPrompt = fs.readFileSync(filePath, "utf-8").trim();
    if (!rawPrompt) return undefined;

    const baseName = path.basename(path.dirname(filePath)) === "skills"
      ? path.basename(filePath, path.extname(filePath))
      : path.basename(path.dirname(filePath));
    const parsed = parseWorkspaceSkill(rawPrompt);
    if (!skillMatchesCurrentPlatform(parsed.frontmatter.platforms)) {
      return undefined;
    }

    const skillId = parsed.frontmatter.name || baseName;
    const name = humanizeSkillName(skillId);
    const description =
      parsed.frontmatter.description ||
      summarizeSkill(parsed.body || rawPrompt);
    const skillDir = path.dirname(filePath);
    if (isWorkspaceSkillDisabled(skillDir)) {
      return undefined;
    }

    const supportFiles = readWorkspaceSkillSupportFiles(skillDir);

    return {
      id: normalizeSkillId(skillId),
      name,
      description,
      source: "workspace",
      prompt: buildWorkspaceSkillPrompt(rawPrompt, filePath, supportFiles),
      path: filePath,
      content: rawPrompt,
      skillDir,
      platforms: parsed.frontmatter.platforms,
      tags: parsed.frontmatter.tags,
      category: parsed.frontmatter.category,
      relatedSkills: parsed.frontmatter.relatedSkills,
      supportFiles,
    };
  } catch {
    return undefined;
  }
}

export function formatHarnessSkillView(
  skill: HarnessSkillDescriptor,
  requestedPath?: string,
): string {
  const supportFiles = skill.supportFiles ?? [];

  if (requestedPath?.trim()) {
    if (skill.source !== "workspace" || !skill.skillDir) {
      return `Skill "${skill.name}" is built in and does not have workspace support files.`;
    }

    const normalizedPath = normalizeSkillRelativePath(requestedPath);
    if (!normalizedPath) {
      return `Rejected support file path "${requestedPath}" because it is not a safe relative path inside the skill directory.`;
    }

    const supportFile = supportFiles.find((file) => file.path === normalizedPath);
    if (!supportFile) {
      return [
        `Unknown support file "${normalizedPath}" for skill "${skill.name}".`,
        formatSupportFileList(supportFiles),
      ].join("\n\n");
    }

    const fileContent = readSafeSkillFile(
      skill.skillDir,
      supportFile.absolutePath,
    );
    if ("error" in fileContent) return fileContent.error;

    return formatSkillFileView(
      skill,
      normalizedPath,
      supportFiles,
      fileContent.content,
    );
  }

  const mainContent = skill.source === "workspace" && skill.path && skill.skillDir
    ? readSafeSkillFile(skill.skillDir, skill.path)
    : { content: skill.content ?? skill.prompt };
  if ("error" in mainContent) return mainContent.error;

  return formatSkillFileView(
    skill,
    skill.path ? path.basename(skill.path) : "builtin prompt",
    supportFiles,
    mainContent.content,
  );
}

function humanizeSkillName(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function summarizeSkill(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Reusable workflow.";
  const firstSentence = cleaned.split(/(?<=[.!?])\s+/)[0] || cleaned;
  return firstSentence.length > 140
    ? `${firstSentence.slice(0, 137).trimEnd()}...`
    : firstSentence;
}

function buildWorkspaceSkillPrompt(
  prompt: string,
  filePath: string,
  supportFiles: WorkspaceSkillSupportFile[],
): string {
  const skillDir = path.dirname(filePath);
  const supportSummary =
    supportFiles.length === 0
      ? "- No support files were found for this skill."
      : `- Support files (${supportFiles.length}) are available through skill_view: ${supportFiles
          .slice(0, 20)
          .map((file) => file.path)
          .join(", ")}${supportFiles.length > 20 ? ", ..." : ""}`;
  return [
    "PocketAI workspace skill adaptation:",
    `- This skill was loaded from ${filePath}.`,
    `- If it references supporting files, look under ${skillDir}/references, ${skillDir}/templates, ${skillDir}/scripts, or ${skillDir}/assets.`,
    supportSummary,
    "- Use skill_view to read the full skill file or any listed support file before relying on support-file details.",
    "- Translate Hermes tool names to PocketAI tools: terminal/execute_code -> run_command; process -> run_command with bg_status/bg_cancel; search_files -> grep/glob/list_files; patch -> edit_file; delegate_task -> task; todo -> todo_write; web_extract -> web_fetch.",
    "",
    prompt,
  ].join("\n");
}

function formatSkillFileView(
  skill: HarnessSkillDescriptor,
  fileLabel: string,
  supportFiles: WorkspaceSkillSupportFile[],
  content: string,
): string {
  const metadata = [
    `Skill: ${skill.name} (${skill.id})`,
    `Source: ${skill.source}`,
    skill.category ? `Category: ${skill.category}` : "",
    skill.tags?.length ? `Tags: ${skill.tags.join(", ")}` : "",
    skill.relatedSkills?.length
      ? `Related skills: ${skill.relatedSkills.join(", ")}`
      : "",
    skill.skillDir ? `Skill directory: ${skill.skillDir}` : "",
    `File: ${fileLabel}`,
  ].filter(Boolean);

  return [
    metadata.join("\n"),
    formatSupportFileList(supportFiles),
    "--- BEGIN SKILL FILE ---",
    content,
    "--- END SKILL FILE ---",
  ].join("\n\n");
}

function formatSupportFileList(
  supportFiles: WorkspaceSkillSupportFile[],
): string {
  if (supportFiles.length === 0) return "Support files: none.";

  return [
    `Support files (${supportFiles.length}):`,
    ...supportFiles.map(
      (file) => `- ${file.path} [${file.kind}, ${formatBytes(file.sizeBytes)}]`,
    ),
  ].join("\n");
}

function readSafeSkillFile(
  skillDir: string,
  filePath: string,
): { content: string } | { error: string } {
  try {
    const realSkillDir = fs.realpathSync(skillDir);
    const realFilePath = fs.realpathSync(filePath);
    if (!isPathInside(realSkillDir, realFilePath)) {
      return {
        error: `Rejected file "${filePath}" because it is outside the skill directory.`,
      };
    }

    if (!fs.statSync(realFilePath).isFile()) {
      return { error: `Skill file "${filePath}" is not a regular file.` };
    }
    if (isSkillFileTooLargeForView(realFilePath)) {
      return {
        error: `Skill file "${filePath}" is too large to display safely.`,
      };
    }

    return { content: fs.readFileSync(realFilePath, "utf-8") };
  } catch (error) {
    return {
      error: `Could not read skill file "${filePath}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
