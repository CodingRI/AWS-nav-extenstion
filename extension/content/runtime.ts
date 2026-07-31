import type { ExtensionMessage } from "@aws-nav/shared";

export async function sendRuntimeMessage<TResponse>(
  message: ExtensionMessage,
): Promise<TResponse> {
  return new Promise<TResponse>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: TResponse) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(response);
    });
  });
}
