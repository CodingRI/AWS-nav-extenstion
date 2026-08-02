import type {
  OpenRouterClientError,
  OpenRouterErrorCode,
} from "@aws-nav/shared";

export class OpenRouterRequestError extends Error {
  readonly details: OpenRouterClientError;

  constructor(details: OpenRouterClientError) {
    super(details.message);
    this.name = "OpenRouterRequestError";
    this.details = details;
  }
}

export function createOpenRouterError(
  code: OpenRouterErrorCode,
  message: string,
  status?: number,
  shouldClearConfiguration = false,
): OpenRouterClientError {
  return {
    code,
    message,
    status,
    shouldClearConfiguration,
  };
}

export function mapOpenRouterHttpError(status: number): OpenRouterClientError {
  switch (status) {
    case 401:
      return createOpenRouterError(
        "invalid_key",
        "Invalid OpenRouter API key.",
        status,
      );
    case 402:
      return createOpenRouterError(
        "out_of_credits",
        "Your OpenRouter balance appears to be exhausted.",
        status,
      );
    case 429:
      return createOpenRouterError(
        "rate_limited",
        "Rate limit exceeded.",
        status,
      );
    default:
      return createOpenRouterError(
        "server_error",
        "OpenRouter returned an unexpected error. Please try again.",
        status,
      );
  }
}

export function getNetworkUnavailableError(): OpenRouterClientError {
  return createOpenRouterError(
    "network_error",
    "Unable to reach OpenRouter.\nCheck your internet connection.",
  );
}

export function getMissingConfigurationError(): OpenRouterClientError {
  return createOpenRouterError(
    "not_configured",
    "OpenRouter is not configured yet.",
  );
}

export function getAuthInvalidatedError(): OpenRouterClientError {
  return createOpenRouterError(
    "auth_invalidated",
    "Your API key is no longer valid.\nPlease reconnect your OpenRouter account.",
    401,
    true,
  );
}
