const STORAGE_KEYS = {
  apiKey: "aws_nav_openrouter_api_key",
  selectedModel: "aws_nav_openrouter_selected_model",
} as const;

export async function getApiKey(): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.apiKey);
  const apiKey = result[STORAGE_KEYS.apiKey];

  return typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : null;
}

export async function getSelectedModel(): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.selectedModel);
  const selectedModel = result[STORAGE_KEYS.selectedModel];

  return typeof selectedModel === "string" && selectedModel.trim()
    ? selectedModel.trim()
    : null;
}

export async function clearConfiguration(): Promise<void> {
  await chrome.storage.local.remove([
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.selectedModel,
  ]);
}
