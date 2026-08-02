import { useCallback, useEffect, useState } from "react";
import type { OpenRouterConfigurationStatus } from "@aws-nav/shared";
import {
  clearConfiguration,
  getConfigurationStatus,
} from "../../src/services/configStorage";

interface UseOpenRouterConfigurationResult {
  configurationStatus: OpenRouterConfigurationStatus | null;
  isLoading: boolean;
  recoveryMessage: string | null;
  refreshConfiguration: () => Promise<void>;
  disconnect: () => Promise<void>;
  markConfigurationInvalid: (message: string) => Promise<void>;
  clearRecoveryMessage: () => void;
}

export function useOpenRouterConfiguration(): UseOpenRouterConfigurationResult {
  const [configurationStatus, setConfigurationStatus] =
    useState<OpenRouterConfigurationStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);

  const refreshConfiguration = useCallback(async () => {
    setIsLoading(true);
    try {
      const status = await getConfigurationStatus();
      setConfigurationStatus(status);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await clearConfiguration();
    await refreshConfiguration();
  }, [refreshConfiguration]);

  const markConfigurationInvalid = useCallback(
    async (message: string) => {
      await clearConfiguration();
      setRecoveryMessage(message);
      await refreshConfiguration();
    },
    [refreshConfiguration],
  );

  const clearRecoveryMessage = useCallback(() => {
    setRecoveryMessage(null);
  }, []);

  useEffect(() => {
    void refreshConfiguration();
  }, [refreshConfiguration]);

  return {
    configurationStatus,
    isLoading,
    recoveryMessage,
    refreshConfiguration,
    disconnect,
    markConfigurationInvalid,
    clearRecoveryMessage,
  };
}
