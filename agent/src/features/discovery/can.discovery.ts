/**
 * CAN Bus Discovery Plugin
 * 
 * Discovers CAN devices by listening for messages
 * Passive discovery - listens to CAN bus traffic
 */

import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';
import { BaseDiscoveryPlugin, DiscoveredDevice } from './base.discovery';
import { generateCANFingerprint } from './fingerprint';

export interface CANDiscoveryOptions {
  interface?: string; // e.g., 'can0', 'vcan0'
  listenDuration?: number; // ms to listen (discovery phase)
}

export class CANDiscoveryPlugin extends BaseDiscoveryPlugin {
  constructor(logger?: AgentLogger) {
    super('can', logger);
  }

  /**
   * Phase 1: Passive listen to detect message IDs
   */
  async discover(options?: CANDiscoveryOptions): Promise<DiscoveredDevice[]> {
    const discovered: DiscoveredDevice[] = [];

    this.logger?.debugSync('Starting CAN discovery', {
      component: LogComponents.discovery + "] [" + this.protocol as any,
      protocol: this.protocol,
      phase: 'discovery'
    });

    const canInterface = options?.interface || 'can0';
    const listenDuration = options?.listenDuration || 5000;

    try {
      // Dynamic import - socketcan may not be available on all platforms
      // @ts-ignore - socketcan is an optional Linux-only dependency
      const socketcan = await import('socketcan');
      const channel = socketcan.createRawChannel(canInterface, true);

      const seenIds = new Set<number>();
      const messageCaptures: Map<number, any[]> = new Map();

      channel.addListener('onMessage', (msg: any) => {
        if (!seenIds.has(msg.id)) {
          seenIds.add(msg.id);
          this.logger?.debugSync(`Discovered CAN ID: 0x${msg.id.toString(16)}`, {
            component: LogComponents.discovery + "] [" + this.protocol as any,
            phase: 'discovery'
          });
        }

        // Capture for validation
        if (!messageCaptures.has(msg.id)) {
          messageCaptures.set(msg.id, []);
        }
        messageCaptures.get(msg.id)!.push({
          timestamp: Date.now(),
          data: msg.data
        });
      });

      channel.start();
      await new Promise(resolve => setTimeout(resolve, listenDuration));
      channel.stop();

      // Create discovered devices
      for (const canId of Array.from(seenIds)) {
        // Format CAN ID as pattern (e.g., "0x18FEF100")
        const canIdPattern = `0x${canId.toString(16).toUpperCase().padStart(8, '0')}`;
        
        // Generate cryptographic fingerprint
        const fingerprint = generateCANFingerprint(canIdPattern);

        discovered.push({
          name: `can_id_0x${canId.toString(16)}`,
          protocol: 'can' as const,
          fingerprint,
          connection: {
            interface: canInterface,
            filters: [{ id: canId, mask: 0x7FF }]
          },
          dataPoints: [{
            id: canId,
            name: `message_0x${canId.toString(16)}`,
            signals: []
          }],
          confidence: 'low',
          discoveredAt: new Date().toISOString(),
          validated: false,
          metadata: {
            canId,
            canIdPattern,
            canInterface,
            messageCaptures: messageCaptures.get(canId) || [],
            discoveryMethod: 'broadcast'
          }
        });
      }

      this.logger?.debugSync(`Discovered ${discovered.length} CAN IDs`, {
        component: LogComponents.discovery + "] [" + this.protocol as any,
        interface: canInterface,
        phase: 'discovery'
      });
    } catch (error) {
      this.logger?.warnSync('CAN discovery failed', {
        component: LogComponents.discovery + "] [" + this.protocol as any,
        error: (error as Error).message
      });
    }

    return discovered;
  }

  /**
   * Phase 2: Validate messages (pattern analysis)
   */
  async validate(device: DiscoveredDevice, timeout = 10000): Promise<any> {
    this.logger?.debugSync('Validating CAN messages', {
      component: LogComponents.discovery + "] [" + this.protocol as any,
      canId: device.metadata?.canId,
      phase: 'validation'
    });

    const messages = device.metadata?.messageCaptures || [];
    if (messages.length === 0) {
      return null;
    }

    const capabilities: string[] = [];

    // Analyze message frequency
    if (messages.length > 1) {
      const intervals = [];
      for (let i = 1; i < messages.length; i++) {
        intervals.push(messages[i].timestamp - messages[i - 1].timestamp);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const variance = intervals.reduce((sum, val) => sum + Math.pow(val - avgInterval, 2), 0) / intervals.length;
      
      if (variance < avgInterval * 0.1) {
        capabilities.push(`periodic_${Math.round(avgInterval)}ms`);
      } else {
        capabilities.push('sporadic');
      }
    }

    // Check data patterns
    const dataHashes = new Set(messages.map((m: any) => JSON.stringify(m.data)));
    if (dataHashes.size === 1) {
      capabilities.push('static_data');
    } else {
      capabilities.push('dynamic_data');
    }

    // Check for common protocols
    const canId = device.metadata?.canId;
    if (canId >= 0x7E0 && canId <= 0x7EF) {
      capabilities.push('obd2');
    } else if ((canId & 0x1FFFF000) === 0x18F00000) {
      capabilities.push('j1939');
    }

    return {
      capabilities,
      messageCount: messages.length,
      dataVariability: dataHashes.size / messages.length
    };
  }

  /**
   * Check if CAN interface is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Check if socketcan module is available (Linux only)
      // @ts-ignore - socketcan is an optional Linux-only dependency
      await import('socketcan');
      // TODO: Check if CAN interface exists (e.g., can0)
      return true;
    } catch {
      // socketcan not available (Windows, macOS, or not installed)
      return false;
    }
  }
}

