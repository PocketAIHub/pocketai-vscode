import { normalizeBaseUrl } from "./helpers";
import { isOpenCodeGoEndpoint } from "./opencode-go";
import {
  CLAUDE_BRIDGE_URL,
  CODEX_APP_SERVER_URL,
  CODEX_BRIDGE_URL,
  CURSOR_BRIDGE_URL,
  DEEPSEEK_BRIDGE_URL,
  LOCAL_POCKETAI_URL,
  OPENCODE_BRIDGE_URL,
} from "./provider-constants";

export type EndpointProviderKind =
  | "local-pocketai"
  | "codex-app-server"
  | "codex-bridge"
  | "claude-bridge"
  | "cursor-bridge"
  | "opencode-bridge"
  | "deepseek-bridge"
  | "openai-compatible";

export type EndpointCapabilities = {
  kind: EndpointProviderKind;
  label: string;
  description: string;
  supportsStructuredTools: boolean;
  supportsReasoningEffort: boolean;
  requiresBridgeBootstrap: boolean;
  usesReportedUsageForContext: boolean;
};

export function getEndpointProviderKind(url: string): EndpointProviderKind {
  const normalizedUrl = normalizeBaseUrl(url);
  if (normalizedUrl === normalizeBaseUrl(CODEX_APP_SERVER_URL)) {
    return "codex-app-server";
  }
  if (normalizedUrl === normalizeBaseUrl(CODEX_BRIDGE_URL)) {
    return "codex-bridge";
  }
  if (normalizedUrl === normalizeBaseUrl(CLAUDE_BRIDGE_URL)) {
    return "claude-bridge";
  }
  if (normalizedUrl === normalizeBaseUrl(CURSOR_BRIDGE_URL)) {
    return "cursor-bridge";
  }
  if (normalizedUrl === normalizeBaseUrl(OPENCODE_BRIDGE_URL)) {
    return "opencode-bridge";
  }
  if (normalizedUrl === normalizeBaseUrl(DEEPSEEK_BRIDGE_URL)) {
    return "deepseek-bridge";
  }
  if (normalizedUrl === normalizeBaseUrl(LOCAL_POCKETAI_URL)) {
    return "local-pocketai";
  }
  return "openai-compatible";
}

export function getEndpointCapabilities(
  url: string,
  options?: { structuredToolsEnabled?: boolean },
): EndpointCapabilities {
  const kind = getEndpointProviderKind(url);
  const structuredToolsEnabled = options?.structuredToolsEnabled ?? true;
  const profile = getEndpointProviderProfile(kind);

  return {
    kind,
    label: profile.label,
    description: profile.description,
    supportsStructuredTools:
      kind !== "codex-app-server" && structuredToolsEnabled,
    supportsReasoningEffort:
      kind === "codex-bridge" ||
      kind === "codex-app-server" ||
      kind === "deepseek-bridge",
    requiresBridgeBootstrap:
      kind === "codex-app-server" ||
      kind === "codex-bridge" ||
      kind === "claude-bridge" ||
      kind === "cursor-bridge" ||
      kind === "opencode-bridge" ||
      kind === "deepseek-bridge",
    // OpenCode Go reports usage in a way that can look much larger than the
    // user-visible transcript for tiny chats, so use our local estimate for
    // context pressure instead of trusting the provider totals.
    usesReportedUsageForContext:
      kind !== "codex-app-server" &&
      kind !== "codex-bridge" &&
      kind !== "claude-bridge" &&
      kind !== "cursor-bridge" &&
      kind !== "opencode-bridge" &&
      kind !== "deepseek-bridge" &&
      !isOpenCodeGoEndpoint(url),
  };
}

export function getEndpointProviderProfile(kind: EndpointProviderKind): {
  label: string;
  description: string;
} {
  switch (kind) {
    case "local-pocketai":
      return {
        label: "Local LLM",
        description: "Local PocketAI-compatible endpoint",
      };
    case "codex-app-server":
      return {
        label: "Codex App Server",
        description: "Native Codex app-server integration with streamed turns",
      };
    case "codex-bridge":
      return {
        label: "Codex Bridge",
        description: "Codex bridge endpoint with model and reasoning controls",
      };
    case "claude-bridge":
      return {
        label: "Claude Bridge",
        description: "Claude bridge endpoint with PocketAI-compatible tools",
      };
    case "cursor-bridge":
      return {
        label: "Cursor Bridge",
        description: "Cursor bridge endpoint with Composer model controls",
      };
    case "opencode-bridge":
      return {
        label: "OpenCode Bridge",
        description: "OpenCode bridge endpoint with provider/model controls",
      };
    case "deepseek-bridge":
      return {
        label: "DeepSeek Bridge",
        description: "DeepSeek V4 API bridge with provider/model controls",
      };
    case "openai-compatible":
    default:
      return {
        label: "OpenAI-compatible",
        description: "OpenAI-compatible chat endpoint",
      };
  }
}
