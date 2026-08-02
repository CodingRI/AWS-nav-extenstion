import type {
  NextStepRequest,
  NextStepResponse,
  OpenRouterChatCompletionResponse,
  OpenRouterModel,
  OpenRouterModelsResponse,
  OpenRouterRawModel,
  OpenRouterValidationResult,
} from "@aws-nav/shared";
import {
  getApiKey,
  getSelectedModel,
  clearConfiguration,
} from "./backgroundStorage";
import {
  OpenRouterRequestError,
  getAuthInvalidatedError,
  getMissingConfigurationError,
  getNetworkUnavailableError,
  mapOpenRouterHttpError,
} from "./errors";
import {
  buildNavigationPrompt,
  buildNavigationSystemPrompt,
  extractResponseText,
  parseNextStepResponse,
} from "./navigationPrompt";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL_PREFERENCES = [
  "openai/gpt-4o-mini",
  "openai/gpt-4.1-mini",
  "google/gemini-2.0-flash-001",
  "anthropic/claude-3.5-haiku",
  "openai/gpt-4o",
  "openai/gpt-5",
] as const;

function getExtensionReferer(): string {
  try {
    return chrome.runtime.getURL("/");
  } catch {
    return "chrome-extension://aws-navigation-assistant/";
  }
}

function getCommonHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": getExtensionReferer(),
    "X-Title": chrome.runtime.getManifest().name,
  };
}

async function parseJsonResponse<T>(response: Response): Promise<T | null> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  return (await response.json()) as T;
}

function toDisplayModel(model: OpenRouterRawModel): OpenRouterModel {
  const provider = model.id.includes("/") ? model.id.split("/")[0] ?? "openrouter" : "openrouter";

  return {
    id: model.id,
    name: model.name?.trim() || model.id,
    provider,
    description: model.description?.trim() || undefined,
    contextLength: model.context_length,
    promptPricing: model.pricing?.prompt,
    completionPricing: model.pricing?.completion,
  };
}

export function getSuggestedModel(models: OpenRouterModel[]): string {
  const byId = new Set(models.map((model) => model.id));

  for (const preferredModel of DEFAULT_MODEL_PREFERENCES) {
    if (byId.has(preferredModel)) {
      return preferredModel;
    }
  }

  return (
    [...models]
      .sort((left, right) => left.name.localeCompare(right.name))
      .at(0)?.id ?? DEFAULT_MODEL_PREFERENCES[0]
  );
}

export class OpenRouterClient {
  async validateApiKey(apiKey: string): Promise<OpenRouterValidationResult> {
    const models = await this.fetchModels(apiKey.trim(), {
      clearConfigurationOn401: false,
    });

    return {
      models,
      suggestedModel: getSuggestedModel(models),
    };
  }

  async listModels(): Promise<OpenRouterModel[]> {
    const apiKey = await getApiKey();

    if (!apiKey) {
      throw new OpenRouterRequestError(getMissingConfigurationError());
    }

    return this.fetchModels(apiKey, {
      clearConfigurationOn401: true,
    });
  }

  async generateNextStep(request: NextStepRequest): Promise<NextStepResponse> {
    const [apiKey, selectedModel] = await Promise.all([
      getApiKey(),
      getSelectedModel(),
    ]);

    if (!apiKey || !selectedModel) {
      throw new OpenRouterRequestError(getMissingConfigurationError());
    }

    const response = await this.fetchWithFriendlyErrors(
      OPENROUTER_CHAT_URL,
      {
        method: "POST",
        headers: getCommonHeaders(apiKey),
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            {
              role: "system",
              content: buildNavigationSystemPrompt(),
            },
            {
              role: "user",
              content: buildNavigationPrompt(request),
            },
          ],
          temperature: 0.2,
          max_tokens: 1500,
          response_format: {
            type: "json_object",
          },
        }),
      },
      {
        clearConfigurationOn401: true,
      },
    );

    const data =
      (await parseJsonResponse<OpenRouterChatCompletionResponse>(response)) ?? {};
    const responseText = extractResponseText(data);
    return parseNextStepResponse(responseText, request);
  }

  private async fetchModels(
    apiKey: string,
    options: {
      clearConfigurationOn401: boolean;
    },
  ): Promise<OpenRouterModel[]> {
    const response = await this.fetchWithFriendlyErrors(
      OPENROUTER_MODELS_URL,
      {
        method: "GET",
        headers: getCommonHeaders(apiKey),
      },
      options,
    );

    const data = await parseJsonResponse<OpenRouterModelsResponse>(response);
    const models = (data?.data ?? []).map(toDisplayModel);

    if (models.length === 0) {
      throw new OpenRouterRequestError(
        mapOpenRouterHttpError(response.status || 500),
      );
    }

    return models;
  }

  private async fetchWithFriendlyErrors(
    input: RequestInfo | URL,
    init: RequestInit,
    options: {
      clearConfigurationOn401: boolean;
    },
  ): Promise<Response> {
    try {
      const response = await fetch(input, init);

      if (response.ok) {
        return response;
      }

      if (response.status === 401) {
        throw new OpenRouterRequestError(
          options.clearConfigurationOn401
            ? getAuthInvalidatedError()
            : mapOpenRouterHttpError(response.status),
        );
      }

      throw new OpenRouterRequestError(mapOpenRouterHttpError(response.status));
    } catch (error) {
      if (error instanceof OpenRouterRequestError) {
        if (error.details.shouldClearConfiguration) {
          await clearConfiguration();
        }
        throw error;
      }

      throw new OpenRouterRequestError(getNetworkUnavailableError());
    }
  }
}

export const openRouterClient = new OpenRouterClient();
