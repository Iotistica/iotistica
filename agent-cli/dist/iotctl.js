#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("./core");
const help_1 = require("./help");
const db_1 = require("./commands/db");
const config_1 = require("./commands/config");
const apps_1 = require("./commands/apps");
const services_1 = require("./commands/services");
const discovery_1 = require("./commands/discovery");
const adapters_1 = require("./commands/adapters");
const provision_1 = require("./commands/provision");
const system_1 = require("./commands/system");
const device_1 = require("./commands/device");
function buildCommands(args) {
    const commands = {
        provision: {
            _default: (key) => {
                if (!key) {
                    throw new core_1.CLIError('Provisioning key is required', 1, {
                        usage: 'iotctl provision <key> --api <endpoint> [--name <device-name>] [--type <device-type>]',
                    });
                }
                return (0, provision_1.provisionWithKey)(key);
            },
            status: provision_1.provisionStatus,
        },
        deprovision: {
            _default: provision_1.deprovision,
        },
        'factory-reset': {
            _default: provision_1.factoryReset,
        },
        config: {
            'set-api': config_1.configSetApi,
            'get-api': config_1.configGetApi,
            set: config_1.configSet,
            get: config_1.configGet,
            show: config_1.configShow,
            reset: config_1.configReset,
        },
        apps: {
            list: apps_1.appsList,
            start: apps_1.appsStart,
            stop: apps_1.appsStop,
            restart: apps_1.appsRestart,
            info: apps_1.appsInfo,
            purge: apps_1.appsPurge,
        },
        services: {
            list: services_1.servicesList,
            start: services_1.servicesStart,
            stop: services_1.servicesStop,
            restart: services_1.servicesRestart,
            logs: (serviceId) => {
                const followLogs = args.includes('--follow') || args.includes('-f');
                return (0, services_1.servicesLogs)(serviceId, followLogs);
            },
            info: services_1.servicesInfo,
        },
        status: {
            _default: device_1.showStatusEnhanced,
        },
        discover: {
            _default: discovery_1.discover,
        },
        devices: {
            list: discovery_1.devicesList,
            show: discovery_1.endpointsShow,
            _default: discovery_1.devicesList,
        },
        endpoints: {
            list: discovery_1.endpointsList,
            show: discovery_1.endpointsShow,
            add: discovery_1.endpointsAdd,
            remove: discovery_1.endpointsRemove,
            clean: discovery_1.endpointsClean,
            _default: discovery_1.endpointsList,
        },
        adapters: {
            list: adapters_1.adaptersList,
            show: adapters_1.adaptersShow,
            add: adapters_1.adaptersAdd,
            remove: adapters_1.adaptersRemove,
            enable: adapters_1.adaptersEnable,
            disable: adapters_1.adaptersDisable,
            'add-mqtt': adapters_1.mqttAdd,
            'add-modbus': adapters_1.modbusAdd,
            'add-opcua': adapters_1.opcuaAdd,
            'add-snmp': adapters_1.snmpAdd,
            _default: adapters_1.adaptersList,
        },
        mqtt: {
            users: provision_1.mqttListUsers,
            _default: provision_1.mqttListUsers,
        },
        diagnostics: {
            _default: device_1.runDiagnostics,
        },
        db: {
            backup: db_1.dbBackup,
            list: db_1.dbList,
            verify: db_1.dbVerify,
            restore: db_1.dbRestore,
            prune: db_1.dbPrune,
            _default: db_1.dbList,
        },
        buffer: {
            status: device_1.bufferStatus,
            _default: device_1.bufferStatus,
        },
        memory: {
            _default: device_1.memoryDiagnostics,
        },
        diag: {
            _default: device_1.runDiagnostics,
        },
        restart: {
            _default: device_1.restart,
        },
        update: {
            _default: (version) => (0, device_1.agentUpdate)(version),
        },
        logs: {
            _default: () => {
                const follow = args.includes('--follow') || args.includes('-f');
                const linesIndex = args.indexOf('-n');
                const lines = linesIndex !== -1 && args[linesIndex + 1] ? parseInt(args[linesIndex + 1], 10) : 50;
                return (0, system_1.showLogs)(follow, lines);
            },
        },
        help: {
            _default: () => (0, help_1.showHelp)(commands),
        },
        '--help': {
            _default: () => (0, help_1.showHelp)(commands),
        },
        '-h': {
            _default: () => (0, help_1.showHelp)(commands),
        },
        version: {
            _default: system_1.showVersion,
        },
        '--version': {
            _default: system_1.showVersion,
        },
        '-v': {
            _default: system_1.showVersion,
        },
    };
    return commands;
}
async function main() {
    const args = process.argv.slice(2);
    const commands = buildCommands(args);
    if (args.length === 0) {
        (0, help_1.showHelp)(commands);
        return;
    }
    const command = args[0];
    const subcommand = args[1];
    const arg1 = args[2];
    const arg2 = args[3];
    const commandGroup = commands[command];
    if (!commandGroup) {
        throw new core_1.CLIError('Unknown command', 1, {
            command,
            hint: 'Use "iotctl help" for usage information',
        });
    }
    if (subcommand && commandGroup[subcommand]) {
        await commandGroup[subcommand](arg1, arg2);
    }
    else if (commandGroup._default) {
        await commandGroup._default(subcommand, arg1, arg2);
    }
    else {
        throw new core_1.CLIError(`Unknown ${command} command`, 1, {
            command: subcommand,
            hint: 'Use "iotctl help" for usage information',
        });
    }
}
function handleError(error) {
    if (error instanceof core_1.CLIError) {
        core_1.logger.error(error.message, undefined, error.context);
    }
    else {
        core_1.logger.error('Unexpected error', error);
    }
}
main().catch((error) => {
    handleError(error);
    process.exit(error.exitCode ?? 1);
});
//# sourceMappingURL=iotctl.js.map