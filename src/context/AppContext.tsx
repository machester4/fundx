import React, { createContext, useContext, useState, useEffect } from "react";
import { Box, Text } from "ink";
import { loadGlobalConfig } from "../config.js";

interface AppContextValue {
  verbose: boolean;
}

const AppContext = createContext<AppContextValue>({ verbose: false });

interface AppProviderProps {
  verbose?: boolean;
  children: React.ReactNode;
}

export function AppProvider({ verbose = false, children }: AppProviderProps) {
  const [swsWarning, setSwsWarning] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const config = await loadGlobalConfig();
        const expiresAt = config.sws?.token_expires_at;
        if (!expiresAt) return;

        const hoursLeft =
          (new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60);

        if (hoursLeft <= 0) {
          setSwsWarning(
            "SWS token expired — run `fundx sws login` to renew",
          );
        } else if (hoursLeft <= 24) {
          setSwsWarning(
            `SWS token expires in ${Math.round(hoursLeft)}h — run \`fundx sws login\` to renew`,
          );
        }
      } catch {
        // Silently ignore config load errors
      }
    })();
  }, []);

  return (
    <AppContext.Provider value={{ verbose }}>
      {swsWarning && (
        <Box paddingX={1} marginBottom={1}>
          <Text color="yellow">⚠ {swsWarning}</Text>
        </Box>
      )}
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext(): AppContextValue {
  return useContext(AppContext);
}
