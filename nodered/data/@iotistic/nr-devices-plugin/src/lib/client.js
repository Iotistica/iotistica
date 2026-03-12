const { fetch, setGlobalDispatcher, Agent } = require('undici')
const settings = require('./settings')

setGlobalDispatcher(new Agent({
    connect: {
        rejectUnauthorized: false
    }
}))

async function ffGet (url, token) {
    const headers = {}
    if (token) {
        headers.authorization = `Bearer ${token}`
    }

    try {
        const response = await fetch(`${settings.get('iotisticURL')}${url}`, {
            method: 'GET',
            headers,
            redirect: 'follow'
        })

        console.log('Response Status Code:', response.status)

        if (!response.ok) {
            const errText = await response.text()
            throw new Error(`HTTP ${response.status} - ${errText}`)
        }

        return await response.json()
    } catch (err) {
        console.log(err)
        console.error('ffGet fetch failed:', err.message || err)
        throw err
    }
}

async function ffPost (url, token, payload) {
    try {
        const response = await fetch(`${settings.get('iotisticURL')}${url}`, {
            method: 'POST',
            headers: {
                authorization: token ? `Bearer ${token}` : undefined,
                'content-type': 'application/json'
            },
            body: JSON.stringify(payload),
            redirect: 'follow'
        })

        if (!response.ok) {
            const errText = await response.text()
            throw new Error(`HTTP ${response.status} - ${errText}`)
        }

        return await response.json()
    } catch (err) {
        console.error('ffPost fetch failed:', err.message || err)
        throw err
    }
}

module.exports = {
    ffGet,
    ffPost
}
