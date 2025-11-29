/**
 * Sensor Output Configuration Model
 * Manages output configurations for protocol adapters (Modbus, CAN, OPC-UA)
 */

import { models } from '../connection';

export interface DeviceSensorOutput {
  id?: number;
  protocol: 'modbus' | 'can' | 'opcua' | 'snmp';
  socket_path: string;
  data_format: string;
  delimiter: string;
  include_timestamp: boolean;
  include_device_name: boolean;
  logging?: Record<string, any>;
  created_at?: Date;
  updated_at?: Date;
}

export class SensorOutputModel {
  private static table = 'endpoint_outputs';

  /**
   * Get output configuration for a protocol
   */
  static async getOutput(protocol: string): Promise<DeviceSensorOutput | null> {
    const output = await models(this.table)
      .where('protocol', protocol)
      .first();
    return output || null;
  }

  /**
   * Set output configuration for a protocol
   */
  static async setOutput(output: DeviceSensorOutput): Promise<DeviceSensorOutput | null> {
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
  static async getAll(): Promise<DeviceSensorOutput[]> {
    return await models(this.table).select('*').orderBy('protocol');
  }
}
