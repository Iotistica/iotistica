# Sample External Plugin

This package demonstrates the external protocol plugin contract used by the agent PluginLoader.

## What it includes

- `manifest.json`: plugin metadata and API compatibility declaration.
- `index.mjs`: exports `createPlugin(context)` and returns `manifest` + `createStarter(...)`.
- API version guard inside `createPlugin`.

## Agent config example

Add this to the adapter manager config source:

```json
{
  "plugins": [
    {
      "modulePath": "agent/plugins/sample-external-plugin/index.mjs",
      "enabled": true,
      "options": {
        "deviceName": "demo_external_device"
      }
    }
  ]
}
```

## Notes

- The sample emits one synthetic `heartbeat` datapoint at startup.
- Use `allowBuiltInOverride: true` only when intentionally replacing a built-in protocol starter.
