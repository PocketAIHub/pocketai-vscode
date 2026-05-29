export type McpResource = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
};

export type McpResourceTemplate = {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
};

export type McpPrompt = {
  name: string;
  description?: string;
  arguments?: Array<{
    name?: string;
    description?: string;
    required?: boolean;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type McpResourceContent = {
  uri?: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  [key: string]: unknown;
};

export type McpResourceReadResult = {
  contents?: McpResourceContent[];
  [key: string]: unknown;
};

export type McpPromptMessage = {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
};

export type McpPromptGetResult = {
  description?: string;
  messages?: McpPromptMessage[];
  [key: string]: unknown;
};

const MCP_TEXT_LIMIT = 12000;
const MCP_OUTPUT_LIMIT = 24000;

export function formatMcpResourceList(
  serverName: string,
  resources: readonly McpResource[],
): string {
  if (resources.length === 0) {
    return `MCP resources from server "${serverName}": none.`;
  }

  return truncateOutput([
    `MCP resources from server "${serverName}" (${resources.length}):`,
    ...resources.map((resource) => {
      const metadata = [
        resource.mimeType ? `mime: ${resource.mimeType}` : "",
        resource.name ? `name: ${resource.name}` : "",
      ].filter(Boolean);
      const suffix = metadata.length ? ` [${metadata.join("; ")}]` : "";
      const description = resource.description ? `: ${resource.description}` : "";
      return `- ${resource.uri}${suffix}${description}`;
    }),
  ].join("\n"));
}

export function formatMcpResourceTemplateList(
  serverName: string,
  templates: readonly McpResourceTemplate[],
): string {
  if (templates.length === 0) {
    return `MCP resource templates from server "${serverName}": none.`;
  }

  return truncateOutput([
    `MCP resource templates from server "${serverName}" (${templates.length}):`,
    ...templates.map((template) => {
      const metadata = [
        template.mimeType ? `mime: ${template.mimeType}` : "",
        template.name ? `name: ${template.name}` : "",
      ].filter(Boolean);
      const suffix = metadata.length ? ` [${metadata.join("; ")}]` : "";
      const description = template.description ? `: ${template.description}` : "";
      return `- ${template.uriTemplate}${suffix}${description}`;
    }),
  ].join("\n"));
}

export function formatMcpPromptList(
  serverName: string,
  prompts: readonly McpPrompt[],
): string {
  if (prompts.length === 0) {
    return `MCP prompts from server "${serverName}": none.`;
  }

  return truncateOutput([
    `MCP prompts from server "${serverName}" (${prompts.length}):`,
    ...prompts.map((prompt) => {
      const args = prompt.arguments?.length
        ? ` [args: ${prompt.arguments
            .map((arg) => `${arg.name || "arg"}${arg.required ? "*" : ""}`)
            .join(", ")}]`
        : "";
      const description = prompt.description ? `: ${prompt.description}` : "";
      return `- ${prompt.name}${args}${description}`;
    }),
  ].join("\n"));
}

export function formatMcpResourceRead(
  serverName: string,
  uri: string,
  result: McpResourceReadResult,
): string {
  const contents = result.contents ?? [];
  if (contents.length === 0) {
    return `MCP resource from server "${serverName}": ${uri}\n(empty result)`;
  }

  return truncateOutput([
    `MCP resource from server "${serverName}": ${uri}`,
    ...contents.map((content, index) =>
      [
        `--- content ${index + 1}${formatContentMetadata(content)} ---`,
        formatMcpContentValue(content),
      ].join("\n"),
    ),
  ].join("\n\n"));
}

export function formatMcpPromptGet(
  serverName: string,
  promptName: string,
  result: McpPromptGetResult,
): string {
  const messages = result.messages ?? [];
  const header = [
    `MCP prompt from server "${serverName}": ${promptName}`,
    result.description ? `Description: ${result.description}` : "",
    "Returned as tool output only; not activated as instructions.",
  ].filter(Boolean);

  if (messages.length === 0) {
    return `${header.join("\n")}\n(empty prompt)`;
  }

  return truncateOutput([
    header.join("\n"),
    ...messages.map((message, index) =>
      [
        `--- message ${index + 1}${message.role ? ` [${message.role}]` : ""} ---`,
        formatUnknownMcpContent(message.content),
      ].join("\n"),
    ),
  ].join("\n\n"));
}

function formatContentMetadata(content: McpResourceContent): string {
  const metadata = [
    content.uri ? `uri=${content.uri}` : "",
    content.mimeType ? `mime=${content.mimeType}` : "",
  ].filter(Boolean);
  return metadata.length ? ` [${metadata.join("; ")}]` : "";
}

function formatMcpContentValue(content: McpResourceContent): string {
  if (typeof content.text === "string") {
    return truncateText(content.text);
  }

  if (typeof content.blob === "string") {
    return `[binary/blob content omitted; encoded length ${content.blob.length} chars${content.mimeType ? `; mime ${content.mimeType}` : ""}]`;
  }

  return formatUnknownMcpContent(content);
}

function formatUnknownMcpContent(content: unknown): string {
  if (typeof content === "string") return truncateText(content);

  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      return truncateText(record.text);
    }
    if (typeof record.blob === "string" || typeof record.data === "string") {
      const encoded = String(record.blob ?? record.data);
      const mime =
        typeof record.mimeType === "string"
          ? `; mime ${record.mimeType}`
          : "";
      return `[binary/blob content omitted; encoded length ${encoded.length} chars${mime}]`;
    }
  }

  return truncateText(JSON.stringify(content ?? null, null, 2));
}

function truncateText(value: string): string {
  if (value.length <= MCP_TEXT_LIMIT) return value;
  return `${value.slice(0, MCP_TEXT_LIMIT).trimEnd()}\n\n[truncated ${value.length - MCP_TEXT_LIMIT} characters]`;
}

function truncateOutput(value: string): string {
  if (value.length <= MCP_OUTPUT_LIMIT) return value;
  return `${value.slice(0, MCP_OUTPUT_LIMIT).trimEnd()}\n\n[truncated ${value.length - MCP_OUTPUT_LIMIT} output characters]`;
}
