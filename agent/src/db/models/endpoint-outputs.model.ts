/**
 * Sensor Output Configuration Model
 * Manages output configurations for protocol adapters (Modbus, CAN, OPC-UA)
 */

import { models } from '../connection';

export interface DeviceEndpointOutput {
  id?: number;
  protocol: 'modbus' | 'can' | 'opcua' | 'snmp';
  socket_path: string;
  data_format: string;
  delimiter: string;
  include_timestamp: boolean;
  include_device_name: boolean;
  buffer_capacity?: number; // Buffer capacity in bytes (default 1MB for large OPC UA messages)
  logging?: Record<string, any>;
  created_at?: Date;
  updated_at?: Date;
}

export class EndpointOutputModel {
  private static table = 'endpoint_outputs';

  /**
   * Get output configuration for a protocol
   */
  static async getOutput(protocol: string): Promise<DeviceEndpointOutput | null> {
    // Exclude 'logging' column to avoid loading massive TEXT fields
    const output = await models(this.table)
      .where('protocol', protocol)
      .select('id', 'protocol', 'socket_path', 'data_format', 'delimiter', 
              'include_timestamp', 'include_device_name', 'buffer_capacity', 
              'created_at', 'updated_at')
      .first();
    return output || null;
  }

  /**
   * Set output configuration for a protocol
   */
  static async setOutput(output: DeviceEndpointOutput): Promise<DeviceEndpointOutput | null> {
    const existing = await this.getOutput(output.protocol);

    const outputData = {
      ...output,
      logging: output.logging ? JSON.stringify(output.logging) : null,
    };

    if (existing) {
      await models(this.table)
        .where('protocol', output.protocol)
        .update({
          ...outputData,
          updated_at: new Date(),
        });
    } else {
      await models(this.table).insert(outputData);
    }

    return await this.getOutput(output.protocol);
  }

  /**
   * Delete output configuration for a protocol
   */
  static async delete(protocol: string): Promise<boolean> {
    const deleted = await models(this.table)
      .where('protocol', protocol)
      .delete();
    return deleted > 0;
  }

  /**
   * Get all output configurations
   */
  static async getAll(): Promise<DeviceEndpointOutput[]> {
    // Exclude 'logging' column to avoid loading massive TEXT fields
    return await models(this.table)
      .select('id', 'protocol', 'socket_path', 'data_format', 'delimiter', 
              'include_timestamp', 'include_device_name', 'buffer_capacity', 
              'created_at', 'updated_at')
      .orderBy('protocol');
  }
}
