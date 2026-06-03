import * as fs from "fs";
import * as path from "path";

export const PROCESS_VAULT_DIR = ".pocketai/vault";

export type ProcessVaultPaths = {
  root: string;
  sourcesDir: string;
  runsDir: string;
  readmeFile: string;
  evalsFile: string;
  learningsFile: string;
  schemaFile: string;
  indexSqlFile: string;
};

export type ProcessVaultResult = {
  status: string;
  transcript: string;
  filePath?: string;
  createdPaths?: string[];
};

type VaultEventKind = "init" | "source" | "run" | "eval" | "learning";

export function getProcessVaultPaths(rootPath: string): ProcessVaultPaths {
  const root = path.join(rootPath, PROCESS_VAULT_DIR);
  return {
    root,
    sourcesDir: path.join(root, "sources"),
    runsDir: path.join(root, "runs"),
    readmeFile: path.join(root, "README.qmd"),
    evalsFile: path.join(root, "evals.qmd"),
    learningsFile: path.join(root, "learnings.qmd"),
    schemaFile: path.join(root, "schema.sql"),
    indexSqlFile: path.join(root, "index.sql"),
  };
}

export function ensureProcessVault(
  rootPath: string,
  now: Date = new Date(),
): ProcessVaultResult {
  const paths = getProcessVaultPaths(rootPath);
  const createdPaths: string[] = [];

  ensureDir(paths.root, createdPaths);
  ensureDir(paths.sourcesDir, createdPaths);
  ensureDir(paths.runsDir, createdPaths);
  ensureFile(paths.readmeFile, buildReadmeQmd(now), createdPaths);
  ensureFile(paths.evalsFile, buildEvalsQmd(now), createdPaths);
  ensureFile(paths.learningsFile, buildLearningsQmd(now), createdPaths);
  ensureFile(paths.schemaFile, buildSchemaSql(), createdPaths);
  ensureFile(paths.indexSqlFile, buildIndexSqlHeader(), createdPaths);
  ensureGitignore(rootPath);

  if (createdPaths.length) {
    appendSqlEvent(paths, {
      kind: "init",
      title: "Process vault initialized",
      body: `Created ${createdPaths.length} vault path(s).`,
      filePath: relativeVaultPath(rootPath, paths.root),
      now,
    });
  }

  return {
    status: createdPaths.length
      ? `Process vault initialized (${createdPaths.length} path${createdPaths.length === 1 ? "" : "s"} created).`
      : "Process vault already initialized.",
    transcript: [
      "PocketAI process vault:",
      "",
      buildVaultPathList(rootPath, paths),
      "",
      createdPaths.length
        ? `Created:\n${createdPaths.map((item) => `- \`${relativeVaultPath(rootPath, item)}\``).join("\n")}`
        : "No new files were needed.",
    ].join("\n"),
    filePath: paths.readmeFile,
    createdPaths,
  };
}

export function buildProcessVaultStatus(rootPath: string): ProcessVaultResult {
  const paths = getProcessVaultPaths(rootPath);
  if (!fs.existsSync(paths.root)) {
    return {
      status: "Process vault is not initialized.",
      transcript: [
        "PocketAI process vault is not initialized.",
        "",
        "Use `/vault init` to create `.pocketai/vault/` with QMD notes and SQL export files.",
      ].join("\n"),
    };
  }

  const sources = listQmdFiles(paths.sourcesDir);
  const runs = listQmdFiles(paths.runsDir);
  return {
    status: `Process vault ready: ${sources.length} source packet${sources.length === 1 ? "" : "s"}, ${runs.length} run log${runs.length === 1 ? "" : "s"}.`,
    transcript: [
      "PocketAI process vault:",
      "",
      buildVaultPathList(rootPath, paths),
      "",
      `- Source packets: ${sources.length}`,
      `- Run logs: ${runs.length}`,
      `- Latest source: ${sources[0] ? `\`${relativeVaultPath(rootPath, sources[0])}\`` : "none yet"}`,
      `- Latest run: ${runs[0] ? `\`${relativeVaultPath(rootPath, runs[0])}\`` : "none yet"}`,
      "",
      "Commands:",
      "- `/vault source <topic>` creates a research/source packet template",
      "- `/vault run <objective>` creates an eval-driven run log",
      "- `/vault learn <text>` records a learning",
      "- `/evals <pass/fail check>` appends a project eval",
    ].join("\n"),
  };
}

export function createSourcePacket(
  rootPath: string,
  topic: string,
  now: Date = new Date(),
): ProcessVaultResult {
  ensureProcessVault(rootPath, now);
  const paths = getProcessVaultPaths(rootPath);
  const title = topic.trim() || "Research Topic";
  const filePath = path.join(
    paths.sourcesDir,
    `${timestampSlug(now)}-${slugifyVaultName(title)}.qmd`,
  );
  fs.writeFileSync(filePath, buildSourcePacketQmd(title, now), "utf-8");
  appendSqlEvent(paths, {
    kind: "source",
    title,
    body: "Created research/source packet template.",
    filePath: relativeVaultPath(rootPath, filePath),
    now,
  });

  return {
    status: `Source packet created: ${relativeVaultPath(rootPath, filePath)}`,
    transcript: [
      "Source packet created.",
      "",
      `Path: \`${relativeVaultPath(rootPath, filePath)}\``,
      "",
      "Use `/research <topic>` when you want the model to fill this kind of packet with sourced material before implementation.",
    ].join("\n"),
    filePath,
  };
}

export function createRunLog(
  rootPath: string,
  objective: string,
  now: Date = new Date(),
): ProcessVaultResult {
  ensureProcessVault(rootPath, now);
  const paths = getProcessVaultPaths(rootPath);
  const title = objective.trim() || "Project Run";
  const filePath = path.join(
    paths.runsDir,
    `${timestampSlug(now)}-${slugifyVaultName(title)}.qmd`,
  );
  fs.writeFileSync(filePath, buildRunLogQmd(title, now), "utf-8");
  appendSqlEvent(paths, {
    kind: "run",
    title,
    body: "Created eval-driven run log.",
    filePath: relativeVaultPath(rootPath, filePath),
    now,
  });

  return {
    status: `Run log created: ${relativeVaultPath(rootPath, filePath)}`,
    transcript: [
      "Eval-driven run log created.",
      "",
      `Path: \`${relativeVaultPath(rootPath, filePath)}\``,
      "",
      "Track each attempt, command, failure, status check, and final evidence here.",
    ].join("\n"),
    filePath,
  };
}

export function appendProjectEval(
  rootPath: string,
  text: string,
  now: Date = new Date(),
): ProcessVaultResult {
  ensureProcessVault(rootPath, now);
  const paths = getProcessVaultPaths(rootPath);
  const body = text.trim();
  if (!body) {
    return {
      status: "Usage: /evals <pass/fail check>",
      transcript: "Usage: `/evals <pass/fail check>`",
    };
  }

  const id = `eval-${timestampSlug(now)}`;
  fs.appendFileSync(
    paths.evalsFile,
    [
      "",
      `## ${id}`,
      "",
      "- Status: pending",
      "- Pass condition:",
      `  ${body}`,
      "- Evidence:",
      "  _Add the command output, screenshot, user acceptance, or manual check that proves this passed._",
      "",
    ].join("\n"),
    "utf-8",
  );
  appendSqlEvent(paths, {
    kind: "eval",
    title: id,
    body,
    filePath: relativeVaultPath(rootPath, paths.evalsFile),
    now,
  });
  appendSqlEval(paths, { id, body, now });

  return {
    status: `Eval added: ${id}`,
    transcript: [
      "Project eval added.",
      "",
      `- ID: \`${id}\``,
      `- File: \`${relativeVaultPath(rootPath, paths.evalsFile)}\``,
      `- Pass condition: ${body}`,
    ].join("\n"),
    filePath: paths.evalsFile,
  };
}

export function appendVaultLearning(
  rootPath: string,
  text: string,
  now: Date = new Date(),
): ProcessVaultResult {
  ensureProcessVault(rootPath, now);
  const paths = getProcessVaultPaths(rootPath);
  const body = text.trim();
  if (!body) {
    return {
      status: "Usage: /vault learn <text>",
      transcript: "Usage: `/vault learn <text>`",
    };
  }

  const title = `learning-${timestampSlug(now)}`;
  fs.appendFileSync(
    paths.learningsFile,
    [
      "",
      `## ${title}`,
      "",
      body,
      "",
      "- Reuse trigger: _When should the agent remember this?_",
      "- Evidence: _What proved it?_",
      "",
    ].join("\n"),
    "utf-8",
  );
  appendSqlEvent(paths, {
    kind: "learning",
    title,
    body,
    filePath: relativeVaultPath(rootPath, paths.learningsFile),
    now,
  });

  return {
    status: `Learning saved: ${title}`,
    transcript: [
      "Learning saved.",
      "",
      `- File: \`${relativeVaultPath(rootPath, paths.learningsFile)}\``,
      `- Learning: ${body}`,
    ].join("\n"),
    filePath: paths.learningsFile,
  };
}

export function resolveVaultOpenPath(
  rootPath: string,
  target: string,
): string | undefined {
  const paths = getProcessVaultPaths(rootPath);
  const normalized = target.trim().toLowerCase();
  if (!normalized || normalized === "readme" || normalized === "home") {
    return paths.readmeFile;
  }
  if (normalized === "evals" || normalized === "eval") return paths.evalsFile;
  if (normalized === "learnings" || normalized === "learning") {
    return paths.learningsFile;
  }
  if (normalized === "schema") return paths.schemaFile;
  if (normalized === "sql" || normalized === "index") return paths.indexSqlFile;
  return undefined;
}

export function slugifyVaultName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "item";
}

function ensureDir(dirPath: string, createdPaths: string[]) {
  if (fs.existsSync(dirPath)) return;
  fs.mkdirSync(dirPath, { recursive: true });
  createdPaths.push(dirPath);
}

function ensureFile(filePath: string, content: string, createdPaths: string[]) {
  if (fs.existsSync(filePath)) return;
  fs.writeFileSync(filePath, content, "utf-8");
  createdPaths.push(filePath);
}

function ensureGitignore(rootPath: string) {
  try {
    const gitignorePath = path.join(rootPath, ".gitignore");
    if (!fs.existsSync(gitignorePath)) return;
    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".pocketai/")) {
      fs.appendFileSync(gitignorePath, "\n# PocketAI local state\n.pocketai/\n");
    }
  } catch {
    // The vault still works if .gitignore is unavailable.
  }
}

function listQmdFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath)
    .filter((name) => name.endsWith(".qmd"))
    .map((name) => path.join(dirPath, name))
    .sort((a, b) => b.localeCompare(a));
}

function buildVaultPathList(rootPath: string, paths: ProcessVaultPaths): string {
  return [
    `- Root: \`${relativeVaultPath(rootPath, paths.root)}\``,
    `- Sources: \`${relativeVaultPath(rootPath, paths.sourcesDir)}\``,
    `- Runs: \`${relativeVaultPath(rootPath, paths.runsDir)}\``,
    `- Evals: \`${relativeVaultPath(rootPath, paths.evalsFile)}\``,
    `- Learnings: \`${relativeVaultPath(rootPath, paths.learningsFile)}\``,
    `- SQL schema: \`${relativeVaultPath(rootPath, paths.schemaFile)}\``,
    `- SQL export: \`${relativeVaultPath(rootPath, paths.indexSqlFile)}\``,
  ].join("\n");
}

function relativeVaultPath(rootPath: string, filePath: string): string {
  const relative = path.relative(rootPath, filePath).split(path.sep).join("/");
  return relative || ".";
}

function timestampSlug(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function buildReadmeQmd(now: Date): string {
  return [
    "---",
    'title: "PocketAI Process Vault"',
    `date: "${now.toISOString()}"`,
    'kind: "vault-index"',
    "---",
    "",
    "# PocketAI Process Vault",
    "",
    "This vault stores durable source material for agent-led project work.",
    "",
    "## Workflow",
    "",
    "1. Research before implementation and save a source packet in `sources/`.",
    "2. Use `/grill-me` to uncover assumptions, unknowns, risks, and missing evals.",
    "3. Write pass/fail evals in `evals.qmd` before major implementation runs.",
    "4. Track attempts in `runs/` until the eval evidence says the work is done.",
    "5. Save reusable discoveries in `learnings.qmd` and PocketAI memory.",
    "",
    "## Files",
    "",
    "- `sources/` - research packets and source material",
    "- `runs/` - eval-driven run logs",
    "- `evals.qmd` - project success criteria",
    "- `learnings.qmd` - reusable lessons from completed or stuck runs",
    "- `schema.sql` and `index.sql` - portable SQL index/export",
    "",
  ].join("\n");
}

function buildEvalsQmd(now: Date): string {
  return [
    "---",
    'title: "Project Evals"',
    `date: "${now.toISOString()}"`,
    'kind: "evals"',
    "---",
    "",
    "# Project Evals",
    "",
    "Each eval should be observable, pass/fail, and tied to evidence.",
    "",
    "## Template",
    "",
    "- Status: pending",
    "- Pass condition: _What must be true?_",
    "- Evidence: _What command, screenshot, artifact, or acceptance proves it?_",
    "- Failure signal: _What would show this did not work?_",
    "",
  ].join("\n");
}

function buildLearningsQmd(now: Date): string {
  return [
    "---",
    'title: "Agent Learnings"',
    `date: "${now.toISOString()}"`,
    'kind: "learnings"',
    "---",
    "",
    "# Agent Learnings",
    "",
    "Capture durable lessons, project preferences, known traps, and unblocking moves.",
    "",
  ].join("\n");
}

function buildSourcePacketQmd(title: string, now: Date): string {
  return [
    "---",
    `title: "Source Packet: ${escapeYamlString(title)}"`,
    `date: "${now.toISOString()}"`,
    'kind: "source-packet"',
    "---",
    "",
    `# ${title}`,
    "",
    "## Research Question",
    "",
    "_What decision or implementation should this research inform?_",
    "",
    "## Sources",
    "",
    "- _URL, doc, paper, issue, code path, or person_",
    "",
    "## Claims",
    "",
    "- _Claim_",
    "  - Evidence:",
    "  - Confidence:",
    "",
    "## Decisions",
    "",
    "- _Decision made or option rejected_",
    "",
    "## Open Unknowns",
    "",
    "- _Unknown_",
    "  - Why it matters:",
    "  - How to resolve:",
    "",
  ].join("\n");
}

function buildRunLogQmd(title: string, now: Date): string {
  return [
    "---",
    `title: "Run: ${escapeYamlString(title)}"`,
    `date: "${now.toISOString()}"`,
    'kind: "run-log"',
    'status: "active"',
    "---",
    "",
    `# ${title}`,
    "",
    "## Objective",
    "",
    "_What should be true when this run is complete?_",
    "",
    "## Source Material",
    "",
    "- _Link to source packets, docs, specs, or previous learnings_",
    "",
    "## Evals",
    "",
    "- _Which eval IDs or checks must pass?_",
    "",
    "## Attempts",
    "",
    "### Attempt 1",
    "",
    "- Plan:",
    "- Commands:",
    "- Result:",
    "- Evidence:",
    "- Learning:",
    "",
    "## Stuck Protocol",
    "",
    "If progress stalls, read relevant memory, run `/grill-me`, add missing research, then update this log with the new unblock path.",
    "",
  ].join("\n");
}

function buildSchemaSql(): string {
  return [
    "-- PocketAI process vault schema.",
    "-- Import with: sqlite3 vault.db < schema.sql",
    "",
    "CREATE TABLE IF NOT EXISTS vault_events (",
    "  id TEXT PRIMARY KEY,",
    "  kind TEXT NOT NULL,",
    "  title TEXT NOT NULL,",
    "  body TEXT NOT NULL,",
    "  file_path TEXT NOT NULL,",
    "  created_at TEXT NOT NULL",
    ");",
    "",
    "CREATE TABLE IF NOT EXISTS vault_evals (",
    "  id TEXT PRIMARY KEY,",
    "  status TEXT NOT NULL,",
    "  pass_condition TEXT NOT NULL,",
    "  evidence TEXT NOT NULL DEFAULT '',",
    "  created_at TEXT NOT NULL,",
    "  updated_at TEXT NOT NULL",
    ");",
    "",
  ].join("\n");
}

function buildIndexSqlHeader(): string {
  return [
    "-- PocketAI process vault append-only SQL export.",
    "-- Import schema.sql first, then this file.",
    "",
  ].join("\n");
}

function appendSqlEvent(
  paths: ProcessVaultPaths,
  event: {
    kind: VaultEventKind;
    title: string;
    body: string;
    filePath: string;
    now: Date;
  },
) {
  const id = `${event.kind}-${timestampSlug(event.now)}-${slugifyVaultName(event.title).slice(0, 32)}`;
  fs.appendFileSync(
    paths.indexSqlFile,
    [
      "INSERT OR REPLACE INTO vault_events (id, kind, title, body, file_path, created_at) VALUES (",
      `  ${sqlQuote(id)}, ${sqlQuote(event.kind)}, ${sqlQuote(event.title)}, ${sqlQuote(event.body)}, ${sqlQuote(event.filePath)}, ${sqlQuote(event.now.toISOString())}`,
      ");",
      "",
    ].join("\n"),
    "utf-8",
  );
}

function appendSqlEval(
  paths: ProcessVaultPaths,
  event: { id: string; body: string; now: Date },
) {
  fs.appendFileSync(
    paths.indexSqlFile,
    [
      "INSERT OR REPLACE INTO vault_evals (id, status, pass_condition, evidence, created_at, updated_at) VALUES (",
      `  ${sqlQuote(event.id)}, 'pending', ${sqlQuote(event.body)}, '', ${sqlQuote(event.now.toISOString())}, ${sqlQuote(event.now.toISOString())}`,
      ");",
      "",
    ].join("\n"),
    "utf-8",
  );
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function escapeYamlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
