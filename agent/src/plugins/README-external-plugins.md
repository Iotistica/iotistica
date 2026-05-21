# External Protocol Plugins

The adapter manager supports external protocol plugin modules loaded from config module paths.

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

- `agent/plugins/sample-external-plugin/manifest.json`
- `agent/plugins/sample-external-plugin/index.mjs`
