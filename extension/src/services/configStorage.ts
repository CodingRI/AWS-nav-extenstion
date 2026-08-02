import type {
  OpenRouterConfiguration,
  OpenRouterConfigurationStatus,
} from "@aws-nav/shared";

const STORAGE_KEYS = {
  apiKey: "aws_nav_openrouter_api_key",
  selectedModel: "aws_nav_openrouter_selected_model",
} as const;

function sanitizeApiKey(apiKey: string): string {
  return apiKey.trim();
}

export async function saveApiKey(apiKey: string): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.apiKey]: sanitizeApiKey(apiKey),
  });
}

export async function getApiKey(): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.apiKey);
  const apiKey = result[STORAGE_KEYS.apiKey];

  return typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : null;
}

export async function removeApiKey(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.apiKey);
}

export async function saveSelectedModel(modelId: string): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.selectedModel]: modelId.trim(),
  });
}

export async function getSelectedModel(): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.selectedModel);
  const selectedModel = result[STORAGE_KEYS.selectedModel];

  return typeof selectedModel === "string" && selectedModel.trim()
    ? selectedModel.trim()
    : null;
}

export async function removeSelectedModel(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.selectedModel);
}

export async function getConfiguration(): Promise<OpenRouterConfiguration | null> {
  const [apiKey, selectedModel] = await Promise.all([
    getApiKey(),
    getSelectedModel(),
  ]);

  if (!apiKey || !selectedModel) {
    return null;
  }

  return {
    apiKey,
    selectedModel,
    savedAt: Date.now(),
  };
}

export async function getConfigurationStatus(): Promise<OpenRouterConfigurationStatus> {
  const [apiKey, selectedModel] = await Promise.all([
    getApiKey(),
    getSelectedModel(),
  ]);

  return {
    hasApiKey: Boolean(apiKey),
    selectedModel,
    isConfigured: Boolean(apiKey && selectedModel),
  };
}

export async function isConfigured(): Promise<boolean> {
  const status = await getConfigurationStatus();
  return status.isConfigured;
}

export async function clearConfiguration(): Promise<void> {
  await chrome.storage.local.remove([
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.selectedModel,
  ]);
}
