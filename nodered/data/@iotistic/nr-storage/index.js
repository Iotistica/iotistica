const axios = require('axios')

let settings
let getAuthToken
let lastTokenState = 'unknown'

/**
 * Get authentication token (Auth0 from session)
 * Returns null if token unavailable (graceful initialization)
 */
function getToken() {
    if (!getAuthToken) {
        if (lastTokenState !== 'no-getter') {
            console.log('[nr-storage] Auth token getter is not configured; proceeding without Authorization header')
            lastTokenState = 'no-getter'
        }
        return null
    }
    
    try {
        const token = getAuthToken()
        const nextState = token ? 'present' : 'null'
        if (lastTokenState !== nextState) {
            if (token) {
                console.log('[nr-storage] Auth token became available for storage requests')
            } else {
                console.log('[nr-storage] Auth token not available; using no-auth storage requests')
            }
            lastTokenState = nextState
        }
        return token || null
    } catch (error) {
        console.log('[nr-storage] getAuthToken threw error:', error?.message || String(error))
        lastTokenState = 'error'
        return null
    }
}

function createClient() {
    const token = getToken()
    const headers = {
        'user-agent': 'Iotistic HTTP Storage v0.1'
    }

    // Optional auth: send bearer token when available, otherwise no-auth request.
    if (token) {
        headers.authorization = 'Bearer ' + token
    }

    const client = axios.create({
        baseURL: settings.baseURL + '/api/v1/nr/storage/',
        headers,
        timeout: 20000
    })

    client.interceptors.response.use(
        (response) => response,
        (error) => {
            const status = error?.response?.status
            const data = error?.response?.data
            const url = error?.config?.baseURL + (error?.config?.url || '')
            console.log('[nr-storage] HTTP request failed', {
                url,
                status,
                hasAuthHeader: !!headers.authorization,
                response: data
            })
            return Promise.reject(error)
        }
    )

    return client
}

module.exports = (options) => {
    // If called as a function (like adminAuth pattern), use options directly
    if (options && (options.iotisticURL || options.baseURL)) {
        settings = {
            baseURL: options.iotisticURL || options.baseURL
        }
        
        if (!settings.baseURL) {
            throw new Error('No iotisticURL found in storage settings')
        }
        
        // Store the auth token getter function (optional for no-auth mode)
        getAuthToken = options.getAuthToken
        // if (!getAuthToken) {
        //     throw new Error('[nr-storage] getAuthToken function required (no static tokens)')
        // }
        
        return createStorageModule()
    }
    
    // Return module with init() for legacy pattern
    return createStorageModule()
}

function createStorageModule() {

    return {
        init: (nrSettings) => {
            console.log('[nr-storage] init() called')
            console.log('[nr-storage] nrSettings.httpStorage:', JSON.stringify(nrSettings.httpStorage || {}, null, 2))
            console.log('[nr-storage] Factory settings:', JSON.stringify(settings || {}, null, 2))
            
            // Preserve factory-provided settings (options.iotisticURL/baseURL) when present.
            // Node-RED may not populate nrSettings.httpStorage in this integration pattern.
            const runtimeSettings = nrSettings.httpStorage || {}
            if (!settings || !settings.baseURL) {
                settings = runtimeSettings
            } else {
                settings = { ...runtimeSettings, ...settings }
            }

            console.log('[nr-storage] Merged settings:', JSON.stringify(settings, null, 2))

            if (Object.keys(settings) === 0) {
                const err = Promise.reject(new Error('No settings for flow storage module found'))
                return err
            }

            if (!settings.baseURL) {
                const err = Promise.reject(new Error('No baseURL found in storage settings'))
                return err
            }

            // Preserve existing token getter from factory options; allow runtime override if provided.
            if (typeof settings.getAuthToken === 'function') {
                getAuthToken = settings.getAuthToken
            }
            // if (!getAuthToken) {
            //     const err = Promise.reject(new Error('[nr-storage] getAuthToken function required'))
            //     return err
            // }

            console.log('[nr-storage] Initialization complete, getAuthToken configured:', !!getAuthToken)
            return Promise.resolve()
        },
        getFlows: async () => {
            console.log('[nr-storage] getFlows() called')
            
            console.log('[nr-storage] Fetching flows from:', settings.baseURL + '/api/v1/nr/storage/flows')
            const client = createClient()
            const response = await client.get('flows')
            console.log('[nr-storage] Flows fetched successfully')
            return response.data.flows
        },
        saveFlows: async (flow) => {
            const client = createClient()
            const response = await client.post('flows', flow)
            return response.data
        },
        getCredentials: async () => {
            console.log('[nr-storage] getCredentials() called')
            
            console.log('[nr-storage] Fetching credentials from:', settings.baseURL + '/api/v1/nr/storage/credentials')
            
            const client = createClient()
            const response = await client.get('credentials')
            console.log('[nr-storage] Credentials fetched successfully')
            return response.data
        },
        saveCredentials: async (credentials) => {
            const client = createClient()
            const response = await client.post('credentials', credentials)
            return response.data
        },
        getSettings: () => {
            console.log('[nr-storage] getSettings() called')
            
            console.log('[nr-storage] Fetching settings from:', settings.baseURL + '/api/v1/nr/storage/settings')
            
            const client = createClient()
            return client.get('settings').then(r => {
                console.log('[nr-storage] Settings fetched successfully')
                return r.data
            })
        },
        saveSettings: (newSettings) => {
            const client = createClient()
            return client.post('settings', newSettings).then(r => r.data)
        },
        getSessions: () => {
            console.log('[nr-storage] getSessions() called')
            
            console.log('[nr-storage] Fetching sessions from:', settings.baseURL + '/api/v1/nr/storage/sessions')
            
            const client = createClient()
            return client.get('sessions').then(r => r.data)
        },
        saveSessions: (sessions) => {
            const client = createClient()
            return client.post('sessions', sessions).then(r => r.data)
        },
        getLibraryEntry: (type, name) => {
            const client = createClient()
            return client.get('library/' + type + '?name=' + encodeURIComponent(name)).then(entry => {
                if (entry.headers['content-type'] && entry.headers['content-type'].startsWith('application/json')) {
                    return typeof entry.data === 'object' ? entry.data : JSON.parse(entry.data)
                } else {
                    return entry.data
                }
            })
        },
        saveLibraryEntry: (type, name, meta, body) => {
            const client = createClient()
            return client.post('library/' + type, { name, meta, body }).then(r => r.data)
        }
    }
}
