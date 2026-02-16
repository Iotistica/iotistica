import { Device } from '../components/AgentSidebar';

/**
 * Simple utility to check if device actions (Add App, Add Job, Add Sensor) are allowed
 * @param deviceStatus - The current status of the device
 * @returns true if actions are allowed, false otherwise
 */
export const canPerformDeviceActions = (deviceStatus: Device['status'] | undefined): boolean => {
  // Only allow actions when device is online or has a warning
  // Disable for: pending (not activated) and offline
  return deviceStatus === 'online' || deviceStatus === 'warning';
};

/**
 * Get a user-friendly message for disabled actions
 * @param deviceStatus - The current status of the device
 * @returns Message explaining why actions are disabled
 */
export const getDisabledActionMessage = (deviceStatus: Device['status'] | undefined): string => {
  if (deviceStatus === 'pending') {
    return 'Device is pending activation. Please wait for the device to come online.';
  }
  if (deviceStatus === 'offline') {
    return 'Device is offline. Actions will be available when the device reconnects.';
  }
  return 'Device actions are not available at this time.';
};
