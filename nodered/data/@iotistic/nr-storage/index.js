const got = require('got')

let settings
let getAuthToken

/**
 * Get authentication token (Auth0 from session)
 * Throws error if token unavailable - no fallbacks
 */
function getToken() {
    if (!getAuthToken) {
        throw new Error('[nr-storage] Auth token getter not configured')
    }
    
    const token = getAuthToken()
    if (!token) {
        throw new Error('[nr-storage] Auth0 token not available in session')
    }
    
    return token
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
        
        // Store the auth token getter function
        getAuthToken = options.getAuthToken
        if (!getAuthToken) {
            throw new Error('[nr-storage] getAuthToken function required (no static tokens)')
        }
        
        return createStorageModule()
    }
    
    // Return module with init() for legacy pattern
    return createStorageModule()
}

function createStorageModule() {

    return {
        init: (nrSettings) => {
            settings = nrSettings.httpStorage || {}

            if (Object.keys(settings) === 0) {
                const err = Promise.reject(new Error('No settings for flow storage module found'))
                return err
            }

            if (!settings.baseURL) {
                const err = Promise.reject(new Error('No baseURL found in storage settings'))
                return err
            }

            // Store the auth token getter function
            getAuthToken = settings.getAuthToken
            if (!getAuthToken) {
                const err = Promise.reject(new Error('[nr-storage] getAuthToken function required'))
                return err
            }

            return Promise.resolve()
        },
        getFlows: async () => {
            const token = getToken()
            const client = got.extend({
                prefixUrl: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1',
                    authorization: 'Bearer ' + token
                },
                timeout: { request: 20000 }
            })
            const response = await client.get('flows').json()
            return response.flows
        },
        saveFlows: async (flow) => {
            const token = getToken()
            const client = got.extend({
                prefixUrl: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1',
                    authorization: 'Bearer ' + token
                },
                timeout: { request: 20000 }
            })
            return client.post('flows', {
                json: flow,
                responseType: 'json'
            })
        },
        getCredentials: async () => {
            const token = getToken()
            const client = got.extend({
                prefixUrl: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1',
                    authorization: 'Bearer ' + token
                },
                timeout: { request: 20000 }
            })
            return client.get('credentials').json()
        },
        saveCredentials: async (credentials) => {
            const token = getToken()
            const client = got.extend({
                prefixUrl: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1',
                    authorization: 'Bearer ' + token
                },
                timeout: { request: 20000 }
            })
            return client.post('credentials', {
                json: credentials,
                responseType: 'json'
            })
        },
        getSettings: () => {
            const token = getToken()
            const client = got.extend({
                prefixUrl: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1',
                    authorization: 'Bearer ' + token
                },
                timeout: { request: 20000 }
            })
            return client.get('settings').json()
        },
        saveSettings: (settings) => {
            const token = getToken()
            const client = got.extend({
                prefixUrl: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1',
                    authorization: 'Bearer ' + token
                },
                timeout: { request: 20000 }
            })
            return client.post('settings', {
                json: settings,
                responseType: 'json'
            })
        },
        getSessions: () => {
            const token = getToken()
            const client = got.extend({
                prefixUrl: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1',
                    authorization: 'Bearer ' + token
                },
                timeout: { request: 20000 }
            })
            return client.get('sessions').json()
        },
        saveSessions: (sessions) => {
            const token = getToken()
            const client = got.extend({
                prefixUrl: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1',
                    authorization: 'Bearer ' + token
                },
                timeout: { request: 20000 }
            })
            return client.post('sessions', {
                json: sessions,
                responseType: 'json'
            })
        },
        getLibraryEntry: (type, name) => {
            const token = getToken()
            const client = got.extend({
                prefixUrl: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1',
                    authorization: 'Bearer ' + token
                },
                timeout: { request: 20000 }
            })
            return client.get('library/' + type, {
                searchParams: { name }
            }).then(entry => {
                if (entry.headers['content-type'].startsWith('application/json')) {
                    return JSON.parse(entry.body)
                } else {
                    return entry.body
                }
            })
        },
        saveLibraryEntry: (type, name, meta, body) => {
            const token = getToken()
            const client = got.extend({
                prefixUrl: settings.baseURL + '/api/v1/nr/storage/',
                headers: {
                    'user-agent': 'Iotistic HTTP Storage v0.1',
                    authorization: 'Bearer ' + token
                },
                timeout: { request: 20000 }
            })
            return client.post('library/' + type, {
                json: { name, meta, body },
                responseType: 'json'
            })
        }
    }
}
