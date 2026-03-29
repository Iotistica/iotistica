export function showHelp(): void {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║                           iotctl - IoT Control                             ║
║                        Iotistica Device Management CLI                      ║
╚═══════════════════════════════════════════════════════════════════════════╝

PROVISIONING COMMANDS:

  provision <key>                   Provision device with provisioning key
                                    Options: --api <endpoint> --name <name> --type <type>
                                    Example: iotctl provision abc123 --api https://api.iotistic.com

  provision status                  Show device provisioning status

  deprovision [--yes]               Remove cloud registration (keeps UUID and deviceApiKey)
                                    Clears: deviceId, MQTT credentials, cloud endpoint
                                    Preserves: UUID, deviceApiKey for re-provisioning
                                    --yes : Skip confirmation prompt

  factory-reset [--yes]             WARNING: Complete data wipe
                                    Deletes: All apps, services, state, sensors, credentials
                                    Preserves: Only device UUID
                                    This action cannot be undone!
                                    --yes : Skip confirmation prompt

CONFIGURATION COMMANDS:

  config set-api <url>              Update cloud API endpoint
                                    Example: iotctl config set-api https://api.example.com

  config get-api                    Show current API endpoint

  config set <key> <value>          Set any configuration value
                                    Example: iotctl config set pollInterval 60000

  config get <key>                  Get specific configuration value

  config show                       Show all configuration settings

  config reset                      Reset to default configuration


DEVICE MANAGEMENT:

  status                            Show device status, lifecycle state, and health

  restart                           Restart agent services (API and MQTT stay running)

  logs [--follow] [-n <lines>]      Show device logs
                                    --follow, -f : Follow log output
                                    -n <lines>   : Number of lines to show


CONTAINER/APPLICATION MANAGEMENT:

  apps list                         List all applications and their services

  apps start <appId>                Start all services in an application

  apps stop <appId>                 Stop all services in an application

  apps restart <appId>              Restart all services in an application

  apps info <appId>                 Show application details

  apps purge <appId> [--yes]        Purge application data (volumes)
                                    --yes : Skip confirmation prompt

  services list [<appId>]           List all services (optionally filtered by app)

  services start <serviceId>        Start a specific service container

  services stop <serviceId>         Stop a specific service container

  services restart <serviceId>      Restart a specific service container

  services logs <serviceId> [-f]    View logs from a specific service
                                    -f, --follow : Follow log output

  services info <serviceId>         Show detailed service information


SYSTEM:

  diagnostics, diag                 Run system diagnostics (API, lifecycle, database, MQTT, cloud)

  buffer status                     Show offline buffer summary

  memory                            Show agent process memory diagnostics and leak detection status

  db backup [--name <name>]         Create SQLite backup with integrity and checksum gates

  db list                           List available SQLite backups

  db verify [<file>|latest]         Verify backup integrity and checksum metadata

  db restore <file|latest> [--yes]  Restore SQLite backup with pre-restore safety backup
                                    Use --force-live to override API-running safety gate

  db prune [--keep <count>]         Prune old backups (default keep: 24)

  help                              Show this help message

  version                           Show CLI version


EXAMPLES:

  # Set cloud API endpoint
  iotctl config set-api https://cloud.iotistica.com

  # View current configuration
  iotctl config show

  # Check device status
  iotctl status

  # List all running applications and services
  iotctl apps list

  # Start/stop entire application stack
  iotctl apps start 1001
  iotctl apps stop 1001

  # List all services (containers)
  iotctl services list

  # List services for specific app
  iotctl services list 1001


DISCOVERY:

  discover [protocol]               Run device discovery for all or specific protocol
                                    Protocols: modbus, opcua, snmp, mqtt, bacnet, can
                                    --validate : Include validation phase (slower, reads device info)
                                    --protocol <name> : Specify protocol to discover
                                    Examples:
                                      iotctl discover                    # All protocols
                                      iotctl discover modbus             # Modbus only


DEVICES (SENSORS):

  devices list [protocol]           List physical/logical devices discovered behind endpoints
                                    Shows device name, UUID prefix, and last seen time
                                    Optional protocol filter: modbus, opcua, mqtt, bacnet, snmp
                                    Examples:
                                      iotctl devices list                # All devices
                                      iotctl devices list modbus         # Modbus slaves only
                                      iotctl devices list opcua          # OPC-UA devices only

  devices show <name>               Show detailed endpoint information including
                                    connection details, data points, and metadata

ENDPOINTS (CONNECTIONS):

  endpoints list [protocol]         List all configured protocol endpoints (connections)
                                    Examples:
                                      iotctl endpoints list              # All endpoints
                                      iotctl endpoints list opcua        # OPC-UA endpoints only

  endpoints show <name>             Show detailed endpoint information


MQTT MANAGEMENT:

  mqtt users                        List all MQTT users from device database
                                    Shows: username, superuser status, active status
                                    Example: iotctl mqtt users


EXAMPLES:

  # Manage individual service container
  iotctl services start myapp-web-1
  iotctl services restart myapp-api-2
  iotctl services logs myapp-web-1 -f

  # Follow agent logs in real-time
  iotctl logs --follow

  # Set custom poll interval (60 seconds)
  iotctl config set pollInterval 60000

  # List MQTT users synced from target endpoints
  iotctl mqtt users

`);
}
