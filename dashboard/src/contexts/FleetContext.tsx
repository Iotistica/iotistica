import { createContext, useContext, useState, ReactNode } from 'react';

interface FleetContextType {
  selectedFleetId: string;
  setSelectedFleetId: (fleetId: string) => void;
}

const FleetContext = createContext<FleetContextType | undefined>(undefined);

export function FleetProvider({ children }: { children: ReactNode }) {
  const [selectedFleetId, setSelectedFleetId] = useState<string>('');

  return (
    <FleetContext.Provider value={{ selectedFleetId, setSelectedFleetId }}>
      {children}
    </FleetContext.Provider>
  );
}

export function useFleet() {
  const context = useContext(FleetContext);
  if (context === undefined) {
    throw new Error('useFleet must be used within a FleetProvider');
  }
  return context;
}
