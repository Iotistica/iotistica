import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface FleetContextType {
  selectedFleetId: string;
  setSelectedFleetId: (fleetId: string) => void;
}

const FleetContext = createContext<FleetContextType | undefined>(undefined);

export function FleetProvider({ children }: { children: ReactNode }) {
  // Initialize from localStorage
  const [selectedFleetId, setSelectedFleetId] = useState<string>(() => {
    try {
      const stored = localStorage.getItem('selectedFleetId');
      return stored || '';
    } catch {
      return '';
    }
  });

  // Persist to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem('selectedFleetId', selectedFleetId);
    } catch (error) {
      console.error('Failed to save selectedFleetId to localStorage:', error);
    }
  }, [selectedFleetId]);

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
