import $ from 'jquery'
import RED from 'node-red'
import * as events from './events.js'

let settings = { connected: false }

// function hasLocalStorage () {
//     try {
//         return 'localStorage' in window && window.localStorage !== null
//     } catch (e) {
//         return false
//     }
// };

function getAuthHeaders () {
    // Headers for API calls
    // Note: When authenticated via nr-auth, the token is passed via session cookies
    // and handled by the backend needsIotToken middleware
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json'
    }
    
    // Get Auth0 token from sessionStorage (set by dashboard iframe parent)
    try {
        const auth0Token = sessionStorage.getItem('auth0_token')
        if (auth0Token && typeof auth0Token === 'string') {
            headers.Authorization = `Bearer ${auth0Token}`
            return headers
        }
    } catch (err) {
        console.warn('Failed to get Auth0 token from sessionStorage:', err)
    }
    
    // Fallback: try localStorage for backward compatibility (legacy auth flow)
    try {
        const authTokens = localStorage.getItem('auth-tokens')
        if (authTokens) {
            const tokenObj = JSON.parse(authTokens)
            const accessToken = tokenObj?.access_token
            if (accessToken && typeof accessToken === 'string') {
                headers.Authorization = `Bearer ${accessToken}`
            }
        }
    } catch (err) {
        console.warn('Failed to get token from localStorage:', err)
        // Continue without Authorization header - will use session token
    }

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
        settings = await $.ajax({
            url: 'nr-tools/settings/',
            type: 'GET'
        })

        if (settings.connected) {
            events.emit('connection-state', true)
        } else {
            events.emit('connection-state', false)
        }
    } catch (err) {
        console.log(err)
        settings = { connected: false }
        events.emit('connection-state', false)
    }
}

export function connect (iotisticURL, username, password, done) {
    iotisticURL = iotisticURL || settings.iotisticURL
    if (!iotisticURL) {
        RED.notify('Please provide Iotistic Server URL', 'error')
        return
    }
    if (!username || !password) {
        RED.notify('Please provide username and password', 'error')
        return
    }
    
    $.ajax({
        contentType: 'application/json',
        url: 'nr-tools/auth/login',
        method: 'POST',
        data: JSON.stringify({
            iotisticURL,
            username,
            password
        })
    }).then(data => {
        if (data && data.success) {
            refreshSettings()
            RED.notify('Successfully connected to Iotistic', 'success')
            if (done) {
                done()
            }
        } else if (data && data.error) {
            RED.notify(`Failed to connect: ${data.error}`, { type: 'error' })
            if (done) {
                done()
            }
        }
    }).catch(err => {
        console.error('Login error:', err)
        const errorMsg = err.responseJSON?.error || err.statusText || 'Connection failed'
        RED.notify(`Failed to connect to server: ${errorMsg}`, { type: 'error' })
        if (done) {
            done()
        }
    })
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

export async function getUserTeams () {
    const teamList = {
        teams: [
            { id: 'team1', name: 'Team Alpha', avatar: 'https://example.com/avatar1.png' },
            { id: 'team2', name: 'Team Beta', avatar: 'https://example.com/avatar2.png' }
        ]
    }
    return teamList
    // return checkResponse(await $.getJSON('flowfuse-nr-tools/teams'))
}

export async function getTeamProjects (teamId) {
    const projectList = {
        projects: teamId === 'team1'
            ? [
                { id: 'project1', name: 'Project Alpha' },
                { id: 'project2', name: 'Project Beta' }
            ]
            : teamId === 'team2'
                ? [
                    { id: 'project3', name: 'Project Gamma' },
                    { id: 'project4', name: 'Project Delta' }
                ]
                : []
    }
    return projectList
    // return checkResponse(await $.getJSON(`flowfuse-nr-tools/teams/${teamId}/projects`))
}
export async function getProject (projectId) {
    const projectInfo = projectId === 'project1'
        ? [
            { id: 'project1', name: 'Project Alpha', description: 'Description for Project Alpha', status: 'active' },
            { id: 'project2', name: 'Project Beta', description: 'Description for Project Beta', status: 'active' }
        ]
        : projectId === 'project2'
            ? [
                { id: 'project3', name: 'Project Gamma', description: 'Description for Project Gamma', status: 'active' },
                { id: 'project4', name: 'Project Delta', description: 'Description for Project Delta', status: 'active' }
            ]
            : []

    return projectInfo
    // return checkResponse(await $.getJSON(`flowfuse-nr-tools/projects/${projectId}`))
}

export async function getDevices (page = 1, limit = 10, filter = 'all') {
    console.log('getDevices', page, limit, filter)
    const url = new URL('nr-tools/devices', window.location.origin)
    url.searchParams.append('page', page)
    url.searchParams.append('limit', limit)
    url.searchParams.append('filter', filter)

    console.log('Fetching devices from URL:', url.toString())
    const headers = getAuthHeaders()
    console.log('Request headers:', headers)

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: headers
    })

    const data = await response.json()
    console.log('Response data:', data)
    return checkResponse(data)
}

export async function getDeviceOTC (deviceId) {
    const response = await fetch(`nr-tools/devices/${deviceId}/otc`, {
        method: 'GET',
        headers: getAuthHeaders()
    })

    return checkResponse(await response.json())
}

export async function addDevice (options) {
    return checkResponse(await $.ajax({
        type: 'POST',
        url: 'nr-tools/devices',
        contentType: 'application/json; charset=utf-8',
        data: JSON.stringify(options)
    }))
}

export async function publishDeviceCommand (options) {
    return checkResponse(await $.ajax({
        type: 'POST',
        url: 'nr-tools/device-publish-command',
        contentType: 'application/json; charset=utf-8',
        data: JSON.stringify(options)
    }))
}

export async function getProjectSnapshots (projectId) {
    return checkResponse(await $.getJSON(`nr-tools/projects/${projectId}/snapshots`))
}

export async function createProjectSnapshot (projectId, options) {
    return checkResponse(await $.ajax({
        type: 'POST',
        url: `nr-tools/projects/${projectId}/snapshots`,
        contentType: 'application/json; charset=utf-8',
        data: JSON.stringify(options)
    }))
}

export async function getDeviceLogCreds (deviceId) {
    const response = await fetch(`nr-tools/devices/${deviceId}/logs`, {
        method: 'GET',
        headers: getAuthHeaders()
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
