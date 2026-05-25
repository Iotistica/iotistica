#!/usr/bin/env node

import { CLIError, logger } from './core';
import { showHelp } from './help';
import { CommandMap } from './command-types';
import { dbBackup, dbList, dbPrune, dbRestore, dbStats, dbVerify } from './commands/db';
import { configGet, configGetApi, configReset, configSet, configSetApi, configShow } from './commands/config';
import { appsInfo, appsList, appsPurge, appsRestart, appsStart, appsStop } from './commands/apps';
import { servicesInfo, servicesList, servicesLogs, servicesRestart, servicesStart, servicesStop } from './commands/services';
import { discover, endpointsClean } from './commands/discovery';
import { adaptersList, adaptersShow, adaptersAdd, adaptersRemove, adaptersEnable, adaptersDisable, mqttAdd, modbusAdd, opcuaAdd, snmpAdd } from './commands/adapters';
import { factoryReset, mqttListUsers, provisionStatus, provisionWithKey, deprovision } from './commands/provision';
import { showLogs, showVersion } from './commands/system';
import { bufferStatus, memoryDiagnostics, restart, runDiagnostics, showStatusEnhanced, agentUpdate, agentPullTargetState } from './commands/agent';
import {
  publishMqttAdd,
  publishDestinationsList,
  publishSubscriptionsAdd,
  publishSubscriptionsList,
} from './commands/publish';

function buildCommands(args: string[]): CommandMap {
  const commands: CommandMap = {
    provision: {
      _default: (key?: string) => {
        if (!key) {
          throw new CLIError('Provisioning key is required', 1, {
            usage: 'iotctl provision <key> --api <endpoint> [--name <device-name>] [--type <device-type>]',
          });
        }
        return provisionWithKey(key);
      },
      status: provisionStatus,
    },
    deprovision: {
      _default: deprovision,
    },
    'factory-reset': {
      _default: factoryReset,
    },
    config: {
      'set-api': configSetApi,
      'get-api': configGetApi,
      set: configSet,
      get: configGet,
      show: configShow,
      reset: configReset,
    },
    apps: {
      list: appsList,
      start: appsStart,
      stop: appsStop,
      restart: appsRestart,
      info: appsInfo,
      purge: appsPurge,
    },
    services: {
      list: servicesList,
      start: servicesStart,
      stop: servicesStop,
      restart: servicesRestart,
      logs: (serviceId: string) => {
        const followLogs = args.includes('--follow') || args.includes('-f');
        return servicesLogs(serviceId, followLogs);
      },
      info: servicesInfo,
    },
    status: {
      _default: showStatusEnhanced,
    },
    discover: {
      _default: discover,
    },
    devices: {
      list: adaptersList,
      show: adaptersShow,
      enable: adaptersEnable,
      disable: adaptersDisable,
      add: adaptersAdd,
      remove: adaptersRemove,
      clean: endpointsClean,
      'add-mqtt': mqttAdd,
      'add-modbus': modbusAdd,
      'add-opcua': opcuaAdd,
      'add-snmp': snmpAdd,
      _default: adaptersList,
    },
    mqtt: {
      users: mqttListUsers,
      _default: mqttListUsers,
    },
    publish: {
      destinations: {
        list: publishDestinationsList,
        _default: publishDestinationsList,
      },
      subscriptions: {
        add: publishSubscriptionsAdd,
        list: publishSubscriptionsList,
        _default: publishSubscriptionsList,
      },
      add: {
        mqtt: publishMqttAdd,
      },
      _default: () => showHelp(commands),
    },
    diagnostics: {
      _default: runDiagnostics,
    },
    agent: {
      status: showStatusEnhanced,
      restart,
      diagnostics: runDiagnostics,
      pull: agentPullTargetState,
      update: (version?: string) => agentUpdate(version),
      _default: showStatusEnhanced,
    },
    db: {
      backups: {
        list: dbList,
        _default: dbList,
      },
      backup: dbBackup,
      stats: dbStats,
      info: dbStats,
      list: dbList,
      verify: dbVerify,
      restore: dbRestore,
      prune: dbPrune,
      _default: dbList,
    },
    buffer: {
      status: bufferStatus,
      _default: bufferStatus,
    },
    memory: {
      _default: memoryDiagnostics,
    },
    diag: {
      _default: runDiagnostics,
    },
    restart: {
      _default: restart,
    },
    update: {
      _default: (version?: string) => agentUpdate(version),
    },
    logs: {
      _default: () => {
        const follow = args.includes('--follow') || args.includes('-f');
        const linesIndex = args.indexOf('-n');
        const lines = linesIndex !== -1 && args[linesIndex + 1] ? parseInt(args[linesIndex + 1], 10) : 50;
        return showLogs(follow, lines);
      },
    },
    help: {
      _default: () => showHelp(commands),
    },
    '--help': {
      _default: () => showHelp(commands),
    },
    '-h': {
      _default: () => showHelp(commands),
    },
    version: {
      _default: showVersion,
    },
    '--version': {
      _default: showVersion,
    },
    '-v': {
      _default: showVersion,
    },
  };

  return commands;
}

async function executeCommand(node: any, args: string[]): Promise<void> {
  if (typeof node === 'function') {
    await node(...args);
    return;
  }

  const [subcommand, ...rest] = args;
  if (subcommand && node[subcommand]) {
    await executeCommand(node[subcommand], rest);
    return;
  }

  if (node._default) {
    await node._default(...args);
    return;
  }

  throw new CLIError('Unknown command', 1, {
    hint: 'Use "iotctl help" for usage information',
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const commands = buildCommands(args);

  if (args.length === 0) {
    showHelp(commands);
    return;
  }

  const command = args[0];
  const commandGroup = commands[command];
  if (!commandGroup) {
    throw new CLIError('Unknown command', 1, {
      command,
      hint: 'Use "iotctl help" for usage information',
    });
  }

  await executeCommand(commandGroup, args.slice(1));
}

function handleError(error: any): void {
  if (error instanceof CLIError) {
    logger.error(error.message, undefined, error.context);
  } else {
    logger.error('Unexpected error', error);
  }
}

main().catch((error) => {
  handleError(error);
  process.exit(error.exitCode ?? 1);
});
