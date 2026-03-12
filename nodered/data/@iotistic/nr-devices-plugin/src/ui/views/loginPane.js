import $ from 'jquery'
import { getSettings, hasDashboardToken } from '../api.js'

const loginPane = {
    id: 'login',
    onshow: () => {},
    content: () => {
        const pane = $('<div class="ff-nr-tools-pane ff-nr-tools-pane-centered"></div>')
        const settings = getSettings()

        // User IS authenticated (has nr-auth session or dashboard token) but API call failed
        if (settings.authSource === 'nr-auth' || hasDashboardToken()) {
            const authMode = settings.authSource === 'nr-auth' ? 'Node-RED' : 'Dashboard token'
            $(`
                <div style="max-width: 400px; text-align: center; padding: 40px;">
                    <i class="fa fa-exclamation-triangle" style="font-size: 48px; color: #ff9800; margin-bottom: 20px;"></i>
                    <h3 style="margin-bottom: 10px;">API Unreachable</h3>
                    <p style="color: var(--red-ui-secondary-text-color); margin-bottom: 10px;">
                        You are authenticated via ${authMode}, but the Iotistic API could not be reached.
                    </p>
                    <p style="font-size: 0.9em; color: var(--red-ui-secondary-text-color);">
                        Current URL: <code>${settings.iotisticURL || 'not set'}</code>
                    </p>
                    <p style="font-size: 0.85em; color: var(--red-ui-secondary-text-color); margin-top: 10px;">
                        Check the Server URL in settings (gear icon). It should be <code>http://api:3002</code> when running in Docker.
                    </p>
                </div>
            `).appendTo(pane)
            return pane
        }

        // User is NOT authenticated at all
        $(`
            <div style="max-width: 520px; text-align: center; padding: 40px;">
                <i class="fa fa-lock" style="font-size: 48px; color: #ff9800; margin-bottom: 20px;"></i>
                <h3 style="margin-bottom: 10px;">Authentication Required</h3>
                <p style="color: var(--red-ui-secondary-text-color); margin-bottom: 10px;">
                    Login from dashboard Auth0 first, then open Node-RED from dashboard navigation.
                </p>
                <p style="font-size: 0.9em; color: var(--red-ui-secondary-text-color);">
                    Legacy plugin login is removed.
                </p>
            </div>
        `).appendTo(pane)

        return pane
    }
}

export {
    loginPane
}