#!/usr/bin/env node

import { CLIError, logger } from './core';
import { showHelp } from './help';
import { CommandMap } from './command-types';
import { dbBackup, dbList, dbPrune, dbRestore, dbVerify } from './commands/db';
import { configGet, configGetApi, configReset, configSet, configSetApi, configShow } from './commands/config';
import { appsInfo, appsList, appsPurge, appsRestart, appsStart, appsStop } from './commands/apps';
import { servicesInfo, servicesList, servicesLogs, servicesRestart, servicesStart, servicesStop } from './commands/services';
import { devicesList, discover, endpointsList, endpointsShow } from './commands/discovery';
import { factoryReset, mqttListUsers, provisionStatus, provisionWithKey, deprovision } from './commands/provision';
import { bufferStatus, memoryDiagnostics, restart, runDiagnostics, showLogs, showStatusEnhanced, showVersion } from './commands/system';

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
      list: devicesList,
      show: endpointsShow,
      _default: devicesList,
    },
    endpoints: {
      list: endpointsList,
      show: endpointsShow,
      _default: endpointsList,
    },
    mqtt: {
      users: mqttListUsers,
      _default: mqttListUsers,
    },
    diagnostics: {
      _default: runDiagnostics,
    },
    db: {
      backup: dbBackup,
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const commands = buildCommands(args);

  if (args.length === 0) {
    showHelp(commands);
    return;
  }

  const command = args[0];
  const subcommand = args[1];
  const arg1 = args[2];
  const arg2 = args[3];

  const commandGroup = commands[command];
  if (!commandGroup) {
    throw new CLIError('Unknown command', 1, {
      command,
      hint: 'Use "iotctl help" for usage information',
    });
  }

  if (subcommand && commandGroup[subcommand]) {
    await commandGroup[subcommand](arg1, arg2);
  } else if (commandGroup._default) {
    await commandGroup._default(subcommand, arg1, arg2);
  } else {
    throw new CLIError(`Unknown ${command} command`, 1, {
      command: subcommand,
      hint: 'Use "iotctl help" for usage information',
    });
  }
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
