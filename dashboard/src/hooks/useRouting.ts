import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useCallback, useMemo } from 'react';

/**
 * Simple routing hook for URL-based navigation
 * No UI changes, just URL synchronization with existing design
 */
export function useRouting() {
  const navigate = useNavigate();
  const params = useParams<{ fleetId?: string; agentId?: string; view?: string }>();
  const location = useLocation();

  // Parse current path to determine view
  const currentPath = useMemo(() => {
    const path = location.pathname;
    const segments = path.split('/').filter(Boolean);

    // Agent view: /fleets/:fleetId/agents/:agentId/:view?
    if (segments[0] === 'fleets' && segments[1] && segments[2] === 'agents' && segments[3]) {
      return {
        type: 'agent' as const,
        fleetId: segments[1],
        agentId: segments[3],
        view: segments[4]
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

  const navigateToAgent = useCallback((agentId: string, fleetId?: string, view?: string) => {
    const fleet = fleetId || 'unassigned';
    const targetView = view ? `/${view}` : '';
    navigate(`/fleets/${fleet}/agents/${agentId}${targetView}`);
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
