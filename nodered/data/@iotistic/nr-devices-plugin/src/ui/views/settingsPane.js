// Import the globals
import $ from 'jquery'
import RED from 'node-red'
import { connect, disconnect, getSettings } from '../api'
import { ConnectionStatusWidget } from '../components/connectionStatus'
import * as events from '../events.js'

function init () {
    RED.userSettings.add({
        id: 'flowfuse-nr-tools',
        title: 'Iotistic',
        get: getSettingsPane,
        close: function () {
            events.off('connection-state', refreshConnectionState)
        }
    })
}

const settingsTemplate = `
<div id="red-ui-settings-tab-flowfuse-nr-tools" class="red-ui-help ff-nr-tools-settings">
    <h3>Iotistic Connection</h3>
    <div class="red-ui-settings-row flowfuse-nr-tools-settings-connectionStatus"></div>
    <div class="red-ui-settings-row">
        <label>Server URL</label>
        <div style="display: inline-flex; width: 100%;">
            <input type="text" id="flowfuse-nr-tools-settings-iotisticURL" style="flex-grow: 1; margin-right: 10px;" placeholder="https://api.iotistic.com">
        </div>
    </div>
    <div class="red-ui-settings-row" id="connection-actions">
        <button type="button" class="red-ui-button" id="flowfuse-nr-tools-settings-disconnect" style="display: none;">
            <i class="fa fa-sign-out"></i> Disconnect
        </button>
        <div style="color: var(--red-ui-secondary-text-color); font-size: 0.9em; margin-top: 10px;">
            Use the sidebar to login/connect
        </div>
    </div>
</div>`

function refreshConnectionState (element) {
    element = element || $(document)
    const { connected } = getSettings()
    
    if (connected) {
        element.find('#flowfuse-nr-tools-settings-disconnect').show()
        element.find('#flowfuse-nr-tools-settings-iotisticURL').attr('disabled', true)
    } else {
        element.find('#flowfuse-nr-tools-settings-disconnect').hide()
        element.find('#flowfuse-nr-tools-settings-iotisticURL').attr('disabled', false)
    }
}
function getSettingsPane () {
    const pane = $(settingsTemplate)
    const settings = getSettings()
    console.log('settings', JSON.stringify(settings, null, 2))
    events.on('connection-state', () => { refreshConnectionState() })
    pane.find('#flowfuse-nr-tools-settings-iotisticURL').val(settings.iotisticURL || 'https://api.iotistica.com')
    ConnectionStatusWidget().appendTo(pane.find('.flowfuse-nr-tools-settings-connectionStatus'))

    // Disconnect button handler
    pane.find('#flowfuse-nr-tools-settings-disconnect').on('click', function (evt) {
        disconnect(() => {
            refreshConnectionState(pane)
        })
    })
    
    // Save URL when changed (only when disconnected)
    pane.find('#flowfuse-nr-tools-settings-iotisticURL').on('change', function() {
        const { connected } = getSettings()
        const newUrl = $(this).val()
        
        if (!connected && newUrl) {
            // Save URL immediately to plugin settings
            $.ajax({
                url: 'nr-tools/settings/iotisticURL',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({ iotisticURL: newUrl })
            }).then(() => {
                RED.notify('Server URL saved', 'success')
            }).catch(err => {
                console.error('Failed to save URL:', err)
                RED.notify('Failed to save server URL', 'error')
            })
        }
    })

    refreshConnectionState(pane)
    return pane
}

export {
    init
}
