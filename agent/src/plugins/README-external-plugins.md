# External Protocol Plugins

The adapter manager supports external protocol plugin modules loaded from config module paths.

## Standard framework for new plugins

Use the same structure as built-in protocols:

1. `client`: one instance per device connection
2. `adapter`: orchestrates clients, polling/subscriptions, and emits adapter events
3. `manifest`: plugin identity/version/API compatibility

### Client contract

Keep all protocol/device I/O in a client class with a stable lifecycle:

- `connect(): Promise<void>`
- `disconnect(): Promise<void>`
- `isConnected(): boolean`
- `read(request?): Promise<DeviceDataPoint[]>`

The agent now exposes this as `IProtocolClient` in `agent/src/plugins/types.ts`.
Built-in protocol clients implement this contract, and adapters call `read()` as the
standardized entry point.

### Adapter contract

Your adapter must satisfy the runtime adapter interface used by `AdapterManager`:

- `start()`
- `stop()`
- `isRunning()`
- `getDeviceStatuses()`
- `on(event, listener)`

Emitted events should follow built-ins:

- `started`
- `stopped`
- `data`
- `device-connected`
- `device-disconnected`
- `device-error`

## Runtime contract

A plugin module must export:

- `createPlugin(context)`

`context` contains:

- `apiVersion`: runtime plugin API version string (currently `1.0.0`)
- `logger`: plugin-scoped logger (`info`, `warn`, `error`, `debug`)

`createPlugin(context)` must return:

- `manifest`
- `createStarter(manager, options)`

The starter should call `manager.attachAdapter(protocol, adapter, uuidMap)`.

## Config

Adapter config supports:

- `plugins: ExternalPluginConfig[]`

Each config item:

- `modulePath`: absolute path or path relative to process cwd
- `enabled`: optional, defaults to true
- `options`: optional plugin-specific object
- `allowBuiltInOverride`: optional, defaults to false

## Version guard

The loader validates plugin `manifest.apiVersion` major version compatibility with runtime API version.

## Sample scaffold

See:

- `agent/src/plugins/examples/sample-external-plugin/manifest.json`
- `agent/src/plugins/examples/sample-external-plugin/index.mjs`

This sample intentionally uses the same client + adapter pattern as Modbus/BACnet.
