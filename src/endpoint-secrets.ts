import type { EndpointConfig } from "./types";
import { normalizeEndpointInputUrl } from "./opencode-go";

export const ENDPOINT_API_KEY_SECRET_PREFIX = "pocketai.endpointApiKey.";

export type EndpointSecretMigration = {
  changed: boolean;
  endpoints: EndpointConfig[];
  secrets: Array<{
    url: string;
    apiKey: string;
    secretKey: string;
  }>;
};

export function getEndpointApiKeySecretKey(endpointUrl: string): string {
  return `${ENDPOINT_API_KEY_SECRET_PREFIX}${normalizeEndpointInputUrl(endpointUrl)}`;
}

export function buildEndpointSecretMigration(
  endpoints: readonly EndpointConfig[],
): EndpointSecretMigration {
  let changed = false;
  const secrets: EndpointSecretMigration["secrets"] = [];
  const sanitizedEndpoints = endpoints.map((endpoint) => {
    const normalizedUrl = normalizeEndpointInputUrl(endpoint.url);
    const apiKey = endpoint.apiKey?.trim() ?? "";
    if (apiKey) {
      secrets.push({
        url: normalizedUrl,
        apiKey,
        secretKey: getEndpointApiKeySecretKey(normalizedUrl),
      });
    }

    if (Object.prototype.hasOwnProperty.call(endpoint, "apiKey")) {
      const { apiKey: _apiKey, ...rest } = endpoint;
      changed = true;
      return rest;
    }

    return endpoint;
  });

  return {
    changed,
    endpoints: sanitizedEndpoints,
    secrets,
  };
}
