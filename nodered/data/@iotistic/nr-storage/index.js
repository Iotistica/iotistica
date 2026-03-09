const axios = require('axios')

let settings
let getAuthToken

/**
 * Get authentication token (Auth0 from session)
 * Returns null if token unavailable (graceful initialization)
 */
function getToken() {
    console.log('[nr-storage] getToken() called, getAuthToken function exists:', !!getAuthToken)
    
    if (!getAuthToken) {
        console.log('[nr-storage] No getAuthToken function configured')
        return null
    }
    
    const token = getAuthToken()
    console.log('[nr-storage] Token retrieved:', token ? `${token.substring(0, 20)}...` : 'null')
    return token || null
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
            // const token = getToken()
            
            // // On startup, before user logs in, return empty flows
            // if (!token) {
            //     console.log('[nr-storage] No token available, returning empty flows')
            //     return []
            // }
            
            console.log('[nr-storage] Fetching flows from:', settings.baseURL + '/api/v1/nr/storage/flows')
            const client = axios.create({
                baseURL: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1'
                    // authorization: 'Bearer ' + token
                },
                timeout: 20000
            })
            const response = await client.get('flows')
            console.log('[nr-storage] Flows fetched successfully')
            return response.data.flows
        },
        saveFlows: async (flow) => {
            // const token = getToken()
            
            const client = axios.create({
                baseURL: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1'
                    // authorization: 'Bearer ' + token
                },
                timeout: 20000
            })
            const response = await client.post('flows', flow)
            return response.data
        },
        getCredentials: async () => {
            console.log('[nr-storage] getCredentials() called')
            // const token = getToken()
            
            // // On startup, before user logs in, return empty credentials
            // if (!token) {
            //     console.log('[nr-storage] No token available, returning empty credentials')
            //     return {}
            // }
            
            console.log('[nr-storage] Fetching credentials from:', settings.baseURL + '/api/v1/nr/storage/credentials')
            
            const client = axios.create({
                baseURL: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1'
                    // authorization: 'Bearer ' + token
                },
                timeout: 20000
            })
            const response = await client.get('credentials')
            console.log('[nr-storage] Credentials fetched successfully')
            return response.data
        },
        saveCredentials: async (credentials) => {
            // const token = getToken()
            
            // // On startup, before user logs in, skip saving
            // if (!token) {
            //     console.log('[nr-storage] No token available, skipping saveCredentials')
            //     return {}
            // }
            
            const client = axios.create({
                baseURL: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1'
                    // authorization: 'Bearer ' + token
                },
                timeout: 20000
            })
            const response = await client.post('credentials', credentials)
            return response.data
        },
        getSettings: () => {
            console.log('[nr-storage] getSettings() called')
            // const token = getToken()
            
            // // On startup, before user logs in, return default empty settings
            // if (!token) {
            //     console.log('[nr-storage] No token available, returning default settings')
            //     return Promise.resolve({})
            // }
            
            console.log('[nr-storage] Fetching settings from:', settings.baseURL + '/api/v1/nr/storage/settings')
            
            const client = axios.create({
                baseURL: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1'
                    // authorization: 'Bearer ' + token
                },
                timeout: 20000
            })
            return client.get('settings').then(r => {
                console.log('[nr-storage] Settings fetched successfully')
                return r.data
            })
        },
        saveSettings: (settings) => {
            // const token = getToken()
            
            // // On startup, before user logs in, skip saving
            // if (!token) {
            //     console.log('[nr-storage] No token available, skipping saveSettings')
            //     return Promise.resolve({})
            // }
            
            const client = axios.create({
                baseURL: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1'
                    // authorization: 'Bearer ' + token
                },
                timeout: 20000
            })
            return client.post('settings', settings).then(r => r.data)
        },
        getSessions: () => {
            console.log('[nr-storage] getSessions() called')
            // const token = getToken()
            
            // // On startup, before user logs in, return empty sessions
            // if (!token) {
            //     console.log('[nr-storage] No token available, returning empty sessions')
            //     return Promise.resolve({})
            // }
            
            console.log('[nr-storage] Fetching sessions from:', settings.baseURL + '/api/v1/nr/storage/sessions')
            
            const client = axios.create({
                baseURL: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1'
                    // authorization: 'Bearer ' + token
                },
                timeout: 20000
            })
            return client.get('sessions').then(r => r.data)
        },
        saveSessions: (sessions) => {
            // const token = getToken()
            
            // // On startup, before user logs in, skip saving
            // if (!token) {
            //     console.log('[nr-storage] No token available, skipping saveSessions')
            //     return Promise.resolve({})
            // }
            
            const client = axios.create({
                baseURL: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1'
                    // authorization: 'Bearer ' + token
                },
                timeout: 20000
            })
            return client.post('sessions', sessions).then(r => r.data)
        },
        getLibraryEntry: (type, name) => {
            // const token = getToken()
            const client = axios.create({
                baseURL: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1'
                    // authorization: 'Bearer ' + token
                },
                timeout: 20000
            })
            return client.get('library/' + type + '?name=' + encodeURIComponent(name)).then(entry => {
                if (entry.headers['content-type'] && entry.headers['content-type'].startsWith('application/json')) {
                    return typeof entry.data === 'object' ? entry.data : JSON.parse(entry.data)
                } else {
                    return entry.data
                }
            })
        },
        saveLibraryEntry: (type, name, meta, body) => {
            // const token = getToken()
            
            // // On startup, before user logs in, skip saving
            // if (!token) {
            //     console.log('[nr-storage] No token available, skipping saveLibraryEntry')
            //     return Promise.resolve({})
            // }
            
            const client = axios.create({
                baseURL: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1'
                    // authorization: 'Bearer ' + token
                },
                timeout: 20000
            })
            return client.post('library/' + type, { name, meta, body }).then(r => r.data)
        }
    }
}
