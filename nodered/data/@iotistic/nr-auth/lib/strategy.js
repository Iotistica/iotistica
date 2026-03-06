const passport = require('passport-strategy')
const util = require('util')
const fetch = require('undici').fetch

function Strategy (options, verify) {
    if (!options.loginURL) {
        throw new TypeError('JWT Strategy requires a loginURL option')
    }
    if (!verify) {
        throw new TypeError('JWT Strategy requires a verify callback')
    }

    passport.Strategy.call(this)
    this.name = 'Iotistic'
    this._verify = verify
    this._loginURL = options.loginURL
    this._userInfoURL = options.userInfoURL
    this._iotisticURL = options.iotisticURL
}

util.inherits(Strategy, passport.Strategy)

Strategy.prototype.authenticate = function (req, options) {
    const self = this

    // Check if this is a bridge token flow (from iframe)
    if (req.body && req.body.bridgeToken) {
        const bridgeToken = req.body.bridgeToken
        const provisioning_url = this._iotisticURL
        const exchangeURL = `${provisioning_url}/api/auth/exchange-bridge-token`
        
        console.log('[Strategy] Bridge token detected, exchanging for access token...')
        
        fetch(exchangeURL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${bridgeToken}`
            }
        })
        .then(response => {
            if (!response.ok) {
                console.error('[Strategy] Bridge token exchange failed:', response.status)
                throw new Error('Bridge token exchange failed')
            }
            return response.json()
        })
        .then(data => {
            const accessToken = data.accessToken
            const refreshToken = data.refreshToken
            const user = data.user

            if (!accessToken || !user) {
                throw new Error('Invalid bridge token exchange response')
            }

            const profile = {
                username: user.username || user.email,
                image: user.avatar || '',
                name: user.fullName || user.name || user.username,
                email: user.email,
                userId: user.id,
                role: user.role || 'user',
                customerId: user.customerId
            }

            console.log('[Strategy] Bridge token exchanged successfully for user:', profile.username)

            self._verify(accessToken, refreshToken, profile, (err, user) => {
                if (err) { return self.error(err) }
                if (!user) { return self.fail() }
                self.success(user)
            })
        })
        .catch(err => {
            console.error('[Strategy] Bridge token authentication error:', err)
            self.fail({ message: err.message })
        })
        
        return
    }

    // Check if this is a callback with credentials
    if (req.body && req.body.username && req.body.password) {
        // JWT Login flow
        fetch(this._loginURL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: req.body.username,
                password: req.body.password
            })
        })
        .then(response => {
            if (!response.ok) {
                return response.json().then(err => {
                    throw new Error(err.message || 'Login failed')
                })
            }
            return response.json()
        })
        .then(data => {
            const accessToken = data.data.accessToken
            const refreshToken = data.data.refreshToken
            const user = data.data.user

            const profile = {
                username: user.username,
                image: user.avatar || '',
                name: user.fullName || user.username,
                email: user.email,
                userId: user.id,
                role: user.role || 'user'
            }

            self._verify(accessToken, refreshToken, profile, (err, user) => {
                if (err) { return self.error(err) }
                if (!user) { return self.fail() }
                self.success(user)
            })
        })
        .catch(err => {
            console.error('JWT authentication error:', err)
            self.fail({ message: err.message })
        })
    } else {
        // No credentials provided - fail to trigger login form
        self.fail({ message: 'Missing credentials' })
    }
}

module.exports = { Strategy }
