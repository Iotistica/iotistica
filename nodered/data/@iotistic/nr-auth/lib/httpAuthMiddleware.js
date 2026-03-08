const { Passport } = require('passport')
const { Strategy } = require('./strategy')

let options
let passport

module.exports = {
    init (_options) {
        options = _options
        return (req, res, next) => {
            try {
                // Check for bridge token in iframe mode
                const bridgeToken = req.query.bridgeToken
                if (bridgeToken && req.path === '/') {
                    // iframe loading with bridge token - redirect to login with bridge token param
                    console.log('[httpAuthMiddleware] Bridge token detected in iframe request')
                    return res.redirect(`/login?bridgeToken=${encodeURIComponent(bridgeToken)}`)
                }

                if (req.query.logoutSession === 'true') {
                    console.log('Logging out session')
                    delete req.session.iotSession
                    delete req.session.user
                    return res.redirect('/login')
                }
                
                if (req.session && req.session.iotSession) {
                    // User is authenticated
                    next()
                } else {
                    // Redirect to login
                    req.session.redirectTo = req.originalUrl
                    res.redirect('/login')
                }
            } catch (err) {
                console.log(err.stack)
                throw err
            }
        }
    },

    setupAuthRoutes (app) {
        if (!options) {
            // If `init` has not been called, then the iotistic-user auth type
            // has not been selected. No need to setup any further routes.
            return
        }
        // 'app' is RED.httpNode - the express app that handles all http routes
        // exposed by the flows.

        passport = new Passport()
        app.use(passport.initialize())

        const loginURL = `${options.iotisticURL}/api/v1/auth/login`
        const userInfoURL = `${options.iotisticURL}/api/v1/auth/me`
        const version = require('../package.json').version

        passport.use('Iotistic', new Strategy({
            loginURL,
            userInfoURL,
            iotisticURL: options.iotisticURL,
            scope: `editor-${version}`
        }, function (accessToken, refreshToken, profile, done) {
            done(null, profile)
        }))

        // Login form
        app.get('/login', (req, res) => {
            const bridgeToken = req.query.bridgeToken
            const showLoading = bridgeToken ? 'block' : 'none'
            const showForm = bridgeToken ? 'none' : 'block'
            
            res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Iotistic Login</title>
    <style>
        body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
        .login-form { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); width: 300px; }
        h2 { margin-top: 0; text-align: center; color: #333; }
        input { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
        button { width: 100%; padding: 12px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; }
        button:hover { background: #0052a3; }
        .error { color: red; font-size: 14px; margin-top: 10px; }
        .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #0066cc; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="login-form">
        <h2>Iotistic Login</h2>
        <div id="loginForm" style="display: ${showForm};">
            <form id="authForm" method="POST" action="/_iotAuth/login">
                <input type="text" name="username" placeholder="Username or Email" required>
                <input type="password" name="password" placeholder="Password" required>
                ${bridgeToken ? `<input type="hidden" name="bridgeToken" value="${bridgeToken}">` : ''}
                <button type="submit">Login</button>
            </form>
            ${req.query.error ? '<div class="error">Login failed. Please try again.</div>' : ''}
        </div>
        <div id="loading" style="display: ${showLoading}; text-align: center;">
            <p>Authenticating...</p>
            <div class="spinner"></div>
        </div>
    </div>
    <script>
        if ('${bridgeToken}') {
            document.getElementById('authForm').submit()
        }
    </script>
</body>
</html>
            `)
        })

        // Login endpoint
        app.post('/_iotAuth/login', passport.authenticate('Iotistic', {
            session: false,
            failureRedirect: '/login?error=1'
        }), (req, res) => {
            req.session.user = req.user
            req.session.iotSession = true
            if (req.session?.redirectTo) {
                const redirectTo = req.session.redirectTo
                delete req.session.redirectTo
                res.redirect(redirectTo)
            } else {
                res.redirect('/')
            }
        })

        // Logout endpoint
        app.get('/_iotAuth/logout', (req, res) => {
            delete req.session.iotSession
            delete req.session.user
            res.redirect('/login')
        })

        // Auth0 token endpoint - for dashboard iframe integration
        app.options('/admin/auth/token', (req, res) => {
            const origin = req.headers.origin
            if (origin) {
                res.setHeader('Access-Control-Allow-Origin', origin)
                res.setHeader('Vary', 'Origin')
            }
            res.setHeader('Access-Control-Allow-Credentials', 'true')
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
            res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
            res.status(204).end()
        })

        app.post('/admin/auth/token', require('express').json(), async (req, res) => {
            try {
                const { token } = req.body
                
                if (!token) {
                    return res.status(400).json({ error: 'Token required' })
                }

                const origin = req.headers.origin
                if (origin) {
                    res.setHeader('Access-Control-Allow-Origin', origin)
                    res.setHeader('Vary', 'Origin')
                }
                res.setHeader('Access-Control-Allow-Credentials', 'true')

                // Authenticate token through the same passport strategy used by /_iotAuth/login
                // so Node-RED creates a proper editor session without a second login form.
                req.body.username = '__access_token__'
                req.body.password = token

                const user = await new Promise((resolve, reject) => {
                    passport.authenticate('Iotistic', { session: false }, (err, authenticatedUser) => {
                        if (err) {
                            return reject(err)
                        }
                        resolve(authenticatedUser)
                    })(req, res)
                })

                if (!user) {
                    return res.status(401).json({ error: 'Invalid token' })
                }
                
                // Store the Auth0 token in the session
                req.session.auth0Token = token
                req.session.iotSession = true
                req.session.user = user
                
                console.log('[httpAuthMiddleware] Auth0 token stored in session')
                res.json({ success: true })
            } catch (error) {
                console.error('[httpAuthMiddleware] Auth0 token storage failed:', error)
                res.status(500).json({ error: 'Failed to store token' })
            }
        })
    }
}
