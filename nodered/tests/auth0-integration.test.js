/**
 * Auth0 Integration Tests for nr-auth Plugin
 * 
 * Tests Auth0 token authentication and session management
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');

// Mock axios for JWKS fetch
jest.mock('axios');

// Mock environment variables
process.env.AUTH0_DOMAIN = 'dev-hmwhgxw10boqpmrw.us.auth0.com';
process.env.AUTH0_AUDIENCE = 'https://iotistica.com';
process.env.AUTH0_ISSUER = 'https://dev-hmwhgxw10boqpmrw.us.auth0.com/';

describe('Auth0 Integration - nr-auth Plugin', () => {
  let adminAuth;
  let mockJWKS;
  let mockKeyPair;
  
  beforeAll(() => {
    // Generate test RSA key pair
    mockKeyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    
    // Create mock JWKS
    const publicKey = crypto.createPublicKey(mockKeyPair.publicKey);
    const jwk = publicKey.export({ format: 'jwk' });
    mockJWKS = {
      keys: [
        {
          ...jwk,
          kid: 'test-key-id',
          alg: 'RS256',
          use: 'sig'
        }
      ]
    };
  });
  
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock axios JWKS fetch
    axios.get.mockResolvedValue({
      data: mockJWKS
    });
    
    // Clear require cache to get fresh module
    jest.resetModules();
    
    // Initialize adminAuth
    const adminAuthFactory = require('../data/@iotistic/nr-auth');
    adminAuth = adminAuthFactory({
      iotisticURL: 'http://api:3002',
      auth0Domain: process.env.AUTH0_DOMAIN,
      auth0Audience: process.env.AUTH0_AUDIENCE,
      auth0Issuer: process.env.AUTH0_ISSUER
    });
  });
  
  describe('Authentication with RS256 Tokens', () => {
    test('should authenticate with valid Auth0 RS256 token', async () => {
      // Create valid RS256 token
      const token = jwt.sign(
        {
          sub: 'auth0|123456',
          email: 'test@example.com',
          aud: process.env.AUTH0_AUDIENCE,
          iss: process.env.AUTH0_ISSUER
        },
        mockKeyPair.privateKey,
        {
          algorithm: 'RS256',
          keyid: 'test-key-id',
          expiresIn: '1h'
        }
      );
      
      const profile = await adminAuth.authenticate('token', token);
      
      expect(profile).not.toBeNull();
      expect(profile).toHaveProperty('username', 'test@example.com');
      expect(profile).toHaveProperty('email', 'test@example.com');
      expect(profile).toHaveProperty('permissions');
      expect(profile.permissions).toContain('*');
    });
    
    test('should reject invalid Auth0 token', async () => {
      const invalidToken = 'invalid.token.here';
      
      const profile = await adminAuth.authenticate('token', invalidToken);
      
      expect(profile).toBeNull();
    });
    
    test('should reject token with wrong algorithm', async () => {
      // Create HS256 token (should be rejected when checking for RS256)
      const hs256Token = jwt.sign(
        { sub: '123', email: 'test@example.com' },
        'secret',
        { algorithm: 'HS256' }
      );
      
      const profile = await adminAuth.authenticate('token', hs256Token);
      
      // Should fail validation because it's not RS256
      expect(profile).toBeNull();
    });
  });
  
  describe('Session Management', () => {
    test('should cache authenticated user', async () => {
      const token = jwt.sign(
        {
          sub: 'auth0|123456',
          email: 'cached@example.com',
          aud: process.env.AUTH0_AUDIENCE,
          iss: process.env.AUTH0_ISSUER
        },
        mockKeyPair.privateKey,
        {
          algorithm: 'RS256',
          keyid: 'test-key-id',
          expiresIn: '1h'
        }
      );
      
      const profile = await adminAuth.authenticate('token', token);
      expect(profile).not.toBeNull();
      
      // Should be able to retrieve user by username
      const cachedUser = await adminAuth.users('cached@example.com');
      
      expect(cachedUser).not.toBeNull();
      expect(cachedUser.email).toBe('cached@example.com');
    });
    
    test('should retrieve user by token', async () => {
      const token = jwt.sign(
        {
          sub: 'auth0|123456',
          email: 'token-lookup@example.com',
          aud: process.env.AUTH0_AUDIENCE,
          iss: process.env.AUTH0_ISSUER
        },
        mockKeyPair.privateKey,
        {
          algorithm: 'RS256',
          keyid: 'test-key-id',
          expiresIn: '1h'
        }
      );
      
      await adminAuth.authenticate('token', token);
      
      // Lookup by token
      const profile = await adminAuth.tokens(token);
      
      expect(profile).not.toBeNull();
      expect(profile.email).toBe('token-lookup@example.com');
    });
  });
  
  describe('JWKS Caching', () => {
    test('should fetch JWKS from Auth0', async () => {
      const token = jwt.sign(
        {
          sub: 'auth0|123456',
          email: 'test@example.com',
          aud: process.env.AUTH0_AUDIENCE,
          iss: process.env.AUTH0_ISSUER
        },
        mockKeyPair.privateKey,
        {
          algorithm: 'RS256',
          keyid: 'test-key-id',
          expiresIn: '1h'
        }
      );
      
      await adminAuth.authenticate('token', token);
      
      // Should have called axios to fetch JWKS
      expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining('.well-known/jwks.json'),
        expect.any(Object)
      );
    });
    
    test('should cache JWKS for subsequent requests', async () => {
      const token1 = jwt.sign(
        {
          sub: 'auth0|123456',
          email: 'test1@example.com',
          aud: process.env.AUTH0_AUDIENCE,
          iss: process.env.AUTH0_ISSUER
        },
        mockKeyPair.privateKey,
        {
          algorithm: 'RS256',
          keyid: 'test-key-id',
          expiresIn: '1h'
        }
      );
      
      await adminAuth.authenticate('token', token1);
      const firstCallCount = axios.get.mock.calls.length;
      
      // Second authentication should use cached JWKS
      const token2 = jwt.sign(
        {
          sub: 'auth0|789',
          email: 'test2@example.com',
          aud: process.env.AUTH0_AUDIENCE,
          iss: process.env.AUTH0_ISSUER
        },
        mockKeyPair.privateKey,
        {
          algorithm: 'RS256',
          keyid: 'test-key-id',
          expiresIn: '1h'
        }
      );
      
      await adminAuth.authenticate('token', token2);
      
      // Should not have made additional JWKS calls (using cache)
      expect(axios.get.mock.calls.length).toBe(firstCallCount);
    });
  });
  
  describe('Module Configuration', () => {
    test('should require iotisticURL', () => {
      const adminAuthFactory = require('../data/@iotistic/nr-auth');
      
      expect(() => {
        adminAuthFactory({
          auth0Domain: process.env.AUTH0_DOMAIN
        });
      }).toThrow('Missing configuration option iotisticURL');
    });
    
    test('should initialize with valid configuration', () => {
      const adminAuthFactory = require('../data/@iotistic/nr-auth');
      
      expect(() => {
        adminAuthFactory({
          iotisticURL: 'http://api:3002',
          auth0Domain: process.env.AUTH0_DOMAIN,
          auth0Audience: process.env.AUTH0_AUDIENCE,
          auth0Issuer: process.env.AUTH0_ISSUER
        });
      }).not.toThrow();
    });
  });
});
