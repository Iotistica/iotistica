import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useCallback, useMemo } from 'react';

/**
 * Simple routing hook for URL-based navigation
 * No UI changes, just URL synchronization with existing design
 */
export function useRouting() {
  const navigate = useNavigate();
  const params = useParams<{ fleetId?: string; agentId?: string }>();
  const location = useLocation();

  // Parse current path to determine view
  const currentPath = useMemo(() => {
    const path = location.pathname;
    const segments = path.split('/').filter(Boolean);

    // Agent view: /fleets/:fleetId/agents/:agentId
    if (segments[0] === 'fleets' && segments[1] && segments[2] === 'agents' && segments[3]) {
      return {
        type: 'agent' as const,
        fleetId: segments[1],
        agentId: segments[3]
      };
    }

    // Fleet view: /fleets/:fleetId
    if (segments[0] === 'fleets' && segments[1]) {
      return {
        type: 'fleet' as const,
        fleetId: segments[1]
      };
    }

    // Global view
    const view = segments[0] || 'fleets';
    return {
      type: 'global' as const,
      view
    };
  }, [location.pathname]);

  // Navigation functions
  const navigateToFleet = useCallback((fleetId: string) => {
    navigate(`/fleets/${fleetId}`);
  }, [navigate]);

  const navigateToAgent = useCallback((agentId: string, fleetId?: string) => {
    const fleet = fleetId || 'unassigned';
    navigate(`/fleets/${fleet}/agents/${agentId}`);
  }, [navigate]);

  const navigateToGlobal = useCallback((view: string) => {
    navigate(`/${view}`);
  }, [navigate]);

  return {
    currentPath,
    params,
    navigateToFleet,
    navigateToAgent,
    navigateToGlobal
  };
}
