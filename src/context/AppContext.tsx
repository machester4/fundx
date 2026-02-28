import React, { createContext, useContext } from "react";

interface AppContextValue {
  verbose: boolean;
}

const AppContext = createContext<AppContextValue>({ verbose: false });

interface AppProviderProps {
  verbose?: boolean;
  children: React.ReactNode;
}

export function AppProvider({ verbose = false, children }: AppProviderProps) {
  return (
    <AppContext.Provider value={{ verbose }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext(): AppContextValue {
  return useContext(AppContext);
}
