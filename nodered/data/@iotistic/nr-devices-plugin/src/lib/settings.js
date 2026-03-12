// Settings object - user-configurable via plugin UI
// Falls back to Node-RED's global settings if not configured
const settings = {
    iotisticURL: null  // User will configure via settings UI
}

function init (RED) {
    // Use user-configured URL if available, otherwise fall back to env var, then RED.settings
    if (!settings.iotisticURL) {
        if (process.env.IOTISTIC_BASE_URL) {
            settings.iotisticURL = process.env.IOTISTIC_BASE_URL.replace(/\/$/, '')
            console.log('[nr-devices-plugin] Using iotisticURL from IOTISTIC_BASE_URL env:', settings.iotisticURL)
        } else if (RED.settings && RED.settings.iotisticURL) {
            settings.iotisticURL = RED.settings.iotisticURL
            console.log('[nr-devices-plugin] Using iotisticURL from Node-RED settings:', settings.iotisticURL)
        } else {
            settings.iotisticURL = 'https://api.iotistic.ca'
            console.log('[nr-devices-plugin] Using default iotisticURL:', settings.iotisticURL)
        }
    } else {
        console.log('[nr-devices-plugin] Using user-configured iotisticURL:', settings.iotisticURL)
    }

    // Note: MQTT credentials now come from API /auth/me response (brokerClient)
    // RED.settings values are no longer used for MQTT
}

const get = key => settings[key]
const set = (key, value) => {
    if (key === 'iotisticURL') {
        if (value && !/^https?:\/\//i.test(value)) {
            value = `https://${value}`
        }
        console.log('[nr-devices-plugin] User configured iotisticURL:', value)
    }
    settings[key] = value
}
const exportPublicSettings = () => {
    return {
        ...settings
    }
}
module.exports = {
    init,
    get,
    set,
    exportPublicSettings
}
