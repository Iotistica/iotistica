import $ from 'jquery'
import RED from 'node-red'
import * as events from './events.js'

let settings = { connected: false }

function getTokenFromBrowserStorage () {
    let token = null

    try {
        token = localStorage.getItem('accessToken')
    } catch (err) {
        console.warn('[nr-tools][ui] Failed to read accessToken from localStorage:', err)
    }

    if (!token) {
        try {
            token = sessionStorage.getItem('auth0_token')
        } catch (err) {
            console.warn('[nr-tools][ui] Failed to read auth0_token from sessionStorage:', err)
        }
    }

    return (typeof token === 'string' && token.length > 0) ? token : null
}

async function getAccessToken () {
    // Primary source: backend session extraction
    try {
        const response = await fetch('nr-tools/auth/token', {
            method: 'GET'
        })

        if (response.ok) {
            const body = await response.json()
            const accessToken = body && body.accessToken ? body.accessToken : null
            if (accessToken && typeof accessToken === 'string') {
                console.log('[nr-tools][ui] accessToken fetched from /nr-tools/auth/token', {
                    tokenSegments: accessToken.split('.').length,
                    tokenLength: accessToken.length
                })
                return accessToken
            }
        } else {
            console.warn('[nr-tools][ui] /nr-tools/auth/token returned non-OK response', {
                status: response.status
            })
        }
    } catch (err) {
        console.warn('[nr-tools][ui] Failed calling /nr-tools/auth/token, trying browser storage fallback', err)
    }

    // Fallback source: dashboard-provided browser storage token
    const fallbackToken = getTokenFromBrowserStorage()
    if (fallbackToken) {
        console.log('[nr-tools][ui] Using fallback token from browser storage', {
            tokenSegments: fallbackToken.split('.').length,
            tokenLength: fallbackToken.length
        })
        return fallbackToken
    }

    return null
}

// function hasLocalStorage () {
//     try {
//         return 'localStorage' in window && window.localStorage !== null
//     } catch (e) {
//         return false
//     }
// };

async function getAuthHeaders () {
    // Headers for API calls
    // Strict mode: always attach explicit bearer JWT from /nr-tools/auth/token.
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json'
    }

    const accessToken = await getAccessToken()
    if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`
    }

    console.log('[nr-tools][ui] Built auth headers', {
        hasAuthorizationHeader: !!headers.Authorization,
        tokenSegments: accessToken ? accessToken.split('.').length : 0
    })

    return headers
}

function checkResponse (response) {
    if (response.code === 'unauthorized') {
        refreshSettings()
        throw new Error(response.code)
    } else if (response.code === 'request_failed') {
        RED.notify(`Request failed: ${response.error}`, { type: 'error' })
    }
    return response
}

export async function refreshSettings () {
    console.log('refreshing settings')
    try {
        const headers = await getAuthHeaders()
        const response = await fetch('nr-tools/settings/', {
            method: 'GET',
            headers
        })

        if (!response.ok) {
            const errText = await response.text()
            throw new Error(`HTTP ${response.status} - ${errText}`)
        }

        settings = await response.json()

        console.log('[nr-tools][ui] /nr-tools/settings response', {
            connected: !!settings.connected,
            authSource: settings.authSource || null,
            hasUser: !!settings.user
        })

        if (settings.connected) {
            events.emit('connection-state', true)
            return
        }

        events.emit('connection-state', false)
    } catch (err) {
        console.warn('[nr-tools][ui] refreshSettings failed; setting disconnected state', err)
        settings = { connected: false }
        events.emit('connection-state', false)
    }
}

export function connect (iotisticURL, username, password, done) {
    RED.notify('Legacy plugin login removed. Use dashboard Auth0 flow.', { type: 'warning' })
    if (done) {
        done()
    }
}

export function disconnect (done) {
    $.post('nr-tools/auth/logout').then(data => {
        refreshSettings()
        RED.notify('Disconnected from Iotistic', 'info')
        if (done) {
            done()
        }
    }).catch(err => {
        console.error('Logout error:', err)
        // Still refresh settings to update UI
        refreshSettings()
        if (done) {
            done()
        }
    })
}

export function getSettings () {
    return settings
}

export function hasDashboardToken () {
    return !!getTokenFromBrowserStorage()
}


export async function getDevices (page = 1, limit = 10, filter = 'all') {
    console.log('getDevices', page, limit, filter)
    const url = new URL('nr-tools/devices', window.location.origin)
    url.searchParams.append('page', page)
    url.searchParams.append('limit', limit)
    url.searchParams.append('filter', filter)

    console.log('Fetching devices from URL:', url.toString())
    const headers = await getAuthHeaders()
    const bearer = headers.Authorization || ''
    const rawToken = bearer.startsWith('Bearer ') ? bearer.slice(7) : null
    console.log('[nr-tools][ui] Calling /nr-tools/devices', {
        page,
        limit,
        filter,
        hasAuthorizationHeader: !!headers.Authorization,
        tokenSegments: rawToken ? rawToken.split('.').length : 0,
        tokenLength: rawToken ? rawToken.length : 0
    })
    console.log('Request headers:', headers)

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: headers
    })

    console.log('[nr-tools][ui] /nr-tools/devices response status', {
        status: response.status,
        ok: response.ok
    })

    const data = await response.json()
    console.log('Response data:', data)
    return checkResponse(data)
}

export async function getDeviceOTC (deviceId) {
    const headers = await getAuthHeaders()
    const response = await fetch(`nr-tools/devices/${deviceId}/otc`, {
        method: 'GET',
        headers
    })

    return checkResponse(await response.json())
}

export async function addDevice (options) {
    const headers = await getAuthHeaders()
    const response = await fetch('/nr-tools/devices', {
        method: 'POST',
        headers: {
            ...headers,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(options)
    })

    if (!response.ok) {
        const errText = await response.text()
        throw new Error(`HTTP ${response.status} - ${errText}`)
    }

    return checkResponse(await response.json())
}

export async function publishDeviceCommand (options) {
    const headers = await getAuthHeaders()
    const response = await fetch('/nr-tools/device-publish-command', {
        method: 'POST',
        headers: {
            ...headers,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(options)
    })

    if (!response.ok) {
        const errText = await response.text()
        throw new Error(`HTTP ${response.status} - ${errText}`)
    }

    return checkResponse(await response.json())
}


export async function getDeviceLogCreds (deviceId) {
    const headers = await getAuthHeaders()
    const response = await fetch(`nr-tools/devices/${deviceId}/logs`, {
        method: 'GET',
        headers
    })
    checkResponse(response)
}

export async function startDevice (device) {
    // return client.post(`/api/v1/devices/${device.id}/actions/start`).then((res) => {
    // productCaptureDeviceAction('start', device)
    // return res.data
    // })
}
export async function restartDevice (device) {
    // return client.post(`/api/v1/devices/${device.id}/actions/restart`).then((res) => {
    // productCaptureDeviceAction('restart', device)
    // return res.data
    // })
}
export async function suspendDevice (device) {
    // return client.post(`/api/v1/devices/${device.id}/actions/suspend`).then((res) => {
    // productCaptureDeviceAction('suspend', device)
    // return res.data
    // })
}
