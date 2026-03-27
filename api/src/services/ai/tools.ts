import { AgentModel, DeviceMetricsModel, DeviceLogsModel } from '../../db/models';

export const aiTools = [
  {
    type: 'function',
    function: {
      name: 'get_device_info',
      description: 'Get basic information about a device (name, status, online status)',
      parameters: {
        type: 'object',
        properties: {
          deviceUuid: {
            type: 'string',
            description: 'Device UUID',
          },
        },
        required: ['deviceUuid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_agent_metrics',
      description: 'Get device metrics like CPU, memory, storage usage',
      parameters: {
        type: 'object',
        properties: {
          deviceUuid: {
            type: 'string',
            description: 'Device UUID',
          },
          hours: {
            type: 'number',
            description: 'Number of hours to retrieve metrics for (default: 24)',
          },
        },
        required: ['deviceUuid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_agent_logs',
      description: 'Get recent logs from device containers',
      parameters: {
        type: 'object',
        properties: {
          deviceUuid: {
            type: 'string',
            description: 'Device UUID',
          },
          serviceName: {
            type: 'string',
            description: 'Optional: Filter by service/container name',
          },
          limit: {
            type: 'number',
            description: 'Number of log entries to retrieve (default: 50)',
          },
        },
        required: ['deviceUuid'],
      },
    },
  },
] as const;

export async function executeTool(toolName: string, args: any): Promise<string> {
  try {
    switch (toolName) {
      case 'get_device_info': {
        const device = await AgentModel.getByUuid(args.deviceUuid);
        if (!device) return 'Device not found';
        return JSON.stringify({
          name: device.agent_name,
          uuid: device.uuid,
          status: device.status,
          isOnline: device.is_online,
          lastSeen: device.last_connectivity_event,
        });
      }

      case 'get_agent_metrics': {
        const hours = args.hours || 24;
        const metrics = await DeviceMetricsModel.getRecent(args.deviceUuid, hours);
        if (!metrics || metrics.length === 0) {
          return 'No metrics available for this time period';
        }

        const avgCpu = metrics.reduce((sum, m) => sum + (m.cpu_usage || 0), 0) / metrics.length;
        const avgMem = metrics.reduce((sum, m) => sum + (m.memory_usage || 0), 0) / metrics.length;
        const latest = metrics[0];

        return JSON.stringify({
          timeRange: `Last ${hours} hours`,
          averageCpu: `${avgCpu.toFixed(1)}%`,
          averageMemory: `${avgMem.toFixed(0)} MB`,
          currentCpu: `${latest.cpu_usage?.toFixed(1) || 0}%`,
          currentMemory: `${latest.memory_usage || 0} MB`,
          memoryTotal: `${latest.memory_total || 0} MB`,
        });
      }

      case 'get_agent_logs': {
        const limit = args.limit || 50;
        const logs = await DeviceLogsModel.get(args.deviceUuid, {
          serviceName: args.serviceName,
          limit,
        });

        if (!logs || logs.length === 0) {
          return 'No logs available';
        }

        const formattedLogs = logs
          .slice(0, 20)
          .map((log) => `[${log.service_name}] ${log.message}`)
          .join('\n');

        return `Recent logs (showing ${Math.min(20, logs.length)} of ${logs.length}):\n${formattedLogs}`;
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (error: any) {
    return `Error executing tool: ${error.message}`;
  }
}
