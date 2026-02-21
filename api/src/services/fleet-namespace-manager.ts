/**
 * Fleet Namespace Manager
 * 
 * Discovers pre-provisioned fleet namespaces from Kubernetes and tracks capacity
 * 
 * Architecture:
 * - Helm creates namespaces (fleet-test, fleet-pool-01, etc)
 * - API discovers them via K8s labels
 * - Monitors capacity (quota limits vs current usage)
 * - Suggests best namespace for new fleet/agent
 */

import * as k8s from '@kubernetes/client-node';
import { logger } from '../utils/logger.js';
import { query } from '../db/connection.js';

export interface FleetNamespace {
  name: string;
  maxAgents: number;
  maxDevices: number;
  currentAgents: number;
  currentDevices: number;
  cpuQuota: {
    request: string;
    limit: string;
    used: string;
  };
  memoryQuota: {
    request: string;
    limit: string;
    used: string;
  };
  available: boolean;
  utilizationPercent: number;
}

export class FleetNamespaceManager {
  private k8sApi: k8s.CoreV1Api | null = null;
  private k8sAvailable: boolean = false;

  constructor() {
    try {
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      this.k8sApi = kc.makeApiClient(k8s.CoreV1Api);
      this.k8sAvailable = true;
      logger.info('FleetNamespaceManager initialized with K8s access');
    } catch (error) {
      logger.warn('FleetNamespaceManager initialized WITHOUT K8s access (will return empty list)', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Discover all pre-provisioned fleet namespaces from Kubernetes
   * 
   * Reads namespaces with label: iotistica.com/fleet-namespace=true
   * Extracts capacity from labels and ResourceQuota
   */
  async discoverNamespaces(): Promise<FleetNamespace[]> {
    if (!this.k8sAvailable || !this.k8sApi) {
      logger.warn('Kubernetes not available - cannot discover fleet namespaces');
      return [];
    }

    try {
      // Query namespaces with fleet label
      const namespacesResponse = await this.k8sApi.listNamespace(
        undefined, // pretty
        undefined, // allowWatchBookmarks
        undefined, // continue
        undefined, // fieldSelector
        'iotistica.com/fleet-namespace=true' // labelSelector
      );

      const fleetNamespaces: FleetNamespace[] = [];

      for (const ns of namespacesResponse.body.items) {
        const name = ns.metadata?.name;
        if (!name) continue;

        // Extract capacity from labels
        const labels = ns.metadata?.labels || {};
        const maxAgents = parseInt(labels['iotistica.com/max-agents'] || '0');
        const maxDevices = parseInt(labels['iotistica.com/max-devices'] || '0');

        // Get ResourceQuota to check current usage
        let cpuQuota, memoryQuota, currentAgents = 0;
        try {
          const quotaResponse = await this.k8sApi.listNamespacedResourceQuota(name);
          const quota = quotaResponse.body.items[0]; // Assumes one quota per namespace

          if (quota?.status) {
            cpuQuota = {
              request: quota.spec?.hard?.['requests.cpu'] || '0',
              limit: quota.spec?.hard?.['limits.cpu'] || '0',
              used: quota.status.used?.['requests.cpu'] || '0'
            };
            memoryQuota = {
              request: quota.spec?.hard?.['requests.memory'] || '0',
              limit: quota.spec?.hard?.['limits.memory'] || '0',
              used: quota.status.used?.['requests.memory'] || '0'
            };
            currentAgents = parseInt(quota.status.used?.['pods'] || '0');
          }
        } catch (error) {
          logger.warn('Failed to get ResourceQuota for namespace', { name, error });
        }

        // Query database for device count in this namespace
        const deviceCountResult = await query(
          `SELECT COUNT(*) as device_count 
           FROM fleets f 
           JOIN devices d ON d.fleet_id = f.id 
           WHERE f.k8s_namespace = $1`,
          [name]
        );
        const currentDevices = parseInt(deviceCountResult.rows[0]?.device_count || '0');

        // Calculate utilization (based on agent count vs max)
        const utilizationPercent = maxAgents > 0 ? (currentAgents / maxAgents) * 100 : 0;
        const available = currentAgents < maxAgents;

        fleetNamespaces.push({
          name,
          maxAgents,
          maxDevices,
          currentAgents,
          currentDevices,
          cpuQuota: cpuQuota || { request: '0', limit: '0', used: '0' },
          memoryQuota: memoryQuota || { request: '0', limit: '0', used: '0' },
          available,
          utilizationPercent
        });

        logger.debug('Discovered fleet namespace', {
          name,
          maxAgents,
          currentAgents,
          available,
          utilizationPercent: `${utilizationPercent.toFixed(1)}%`
        });
      }

      return fleetNamespaces.sort((a, b) => a.utilizationPercent - b.utilizationPercent);

    } catch (error) {
      logger.error('Failed to discover fleet namespaces', {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Find best available namespace for new fleet/agent
   * 
   * Strategy: Pick namespace with lowest utilization
   */
  async findAvailableNamespace(requiredDevices: number = 0): Promise<string | null> {
    const namespaces = await this.discoverNamespaces();
    
    // Filter to available namespaces
    const available = namespaces.filter(ns => 
      ns.available && 
      (requiredDevices === 0 || ns.maxDevices - ns.currentDevices >= requiredDevices)
    );

    if (available.length === 0) {
      logger.warn('No available fleet namespaces found', {
        totalNamespaces: namespaces.length,
        requiredDevices
      });
      return null;
    }

    // Return namespace with lowest utilization
    const selected = available[0];
    logger.info('Selected fleet namespace', {
      namespace: selected.name,
      utilization: `${selected.utilizationPercent.toFixed(1)}%`,
      available: `${selected.maxAgents - selected.currentAgents}/${selected.maxAgents} agents`
    });

    return selected.name;
  }

  /**
   * Sync fleet namespace metadata to database (for caching/UI performance)
   * 
   * Creates/updates fleet_namespaces table with capacity info
   */
  async syncNamespacesToDatabase(): Promise<void> {
    const namespaces = await this.discoverNamespaces();
    
    // Create table if not exists
    await query(`
      CREATE TABLE IF NOT EXISTS fleet_namespaces (
        name VARCHAR(63) PRIMARY KEY,
        max_agents INTEGER NOT NULL,
        max_devices INTEGER NOT NULL,
        current_agents INTEGER NOT NULL DEFAULT 0,
        current_devices INTEGER NOT NULL DEFAULT 0,
        cpu_quota_request VARCHAR(20),
        memory_quota_request VARCHAR(20),
        available BOOLEAN NOT NULL DEFAULT true,
        utilization_percent NUMERIC(5,2),
        last_synced TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Upsert namespace data
    for (const ns of namespaces) {
      await query(`
        INSERT INTO fleet_namespaces (
          name, max_agents, max_devices, current_agents, current_devices,
          cpu_quota_request, memory_quota_request, available, utilization_percent, last_synced
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (name) DO UPDATE SET
          current_agents = $4,
          current_devices = $5,
          available = $8,
          utilization_percent = $9,
          last_synced = NOW()
      `, [
        ns.name,
        ns.maxAgents,
        ns.maxDevices,
        ns.currentAgents,
        ns.currentDevices,
        ns.cpuQuota.request,
        ns.memoryQuota.request,
        ns.available,
        ns.utilizationPercent
      ]);
    }

    logger.info('Synced fleet namespaces to database', { count: namespaces.length });
  }
}

// Singleton instance
export const fleetNamespaceManager = new FleetNamespaceManager();
