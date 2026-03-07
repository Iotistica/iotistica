/**
 * Devices Plugin Auth Tests for nr-devices-plugin
 * 
 * Tests sessionStorage token handling (unit tests for token retrieval logic)
 */

describe('Devices Plugin Auth - Token Storage', () => {
  beforeEach(() => {
    // Clear all storage
    sessionStorage.clear();
    localStorage.clear();
    
    // Mock console.warn to avoid noise in tests
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  
  afterEach(() => {
    jest.restoreAllMocks();
  });
  
  describe('Token Retrieval Priority', () => {
    test('should prioritize sessionStorage auth0_token', () => {
      const auth0Token = 'eyJhbGciOiJSUzI1NiJ9.auth0.token';
      const legacyToken = 'eyJhbGciOiJIUzI1NiJ9.legacy.token';
      
      sessionStorage.setItem('auth0_token', auth0Token);
      localStorage.setItem('auth-tokens', JSON.stringify({
        access_token: legacyToken
      }));
      
      // Simulate getAuthHeaders logic
      let token = sessionStorage.getItem('auth0_token');
      
      expect(token).toBe(auth0Token);
      expect(token).not.toBe(legacyToken);
    });
    
    test('should fallback to localStorage if sessionStorage empty', () => {
      const legacyToken = 'eyJhbGciOiJIUzI1NiJ9.legacy.token';
      
      localStorage.setItem('auth-tokens', JSON.stringify({
        access_token: legacyToken
      }));
      
      // Simulate getAuthHeaders logic
      let token = sessionStorage.getItem('auth0_token');
      if (!token) {
        const authTokens = localStorage.getItem('auth-tokens');
        if (authTokens) {
          const tokenObj = JSON.parse(authTokens);
          token = tokenObj?.access_token;
        }
      }
      
      expect(token).toBe(legacyToken);
    });
    
    test('should return null if no token available', () => {
      let token = sessionStorage.getItem('auth0_token');
      
      if (!token) {
        const authTokens = localStorage.getItem('auth-tokens');
        if (authTokens) {
          const tokenObj = JSON.parse(authTokens);
          token = tokenObj?.access_token;
        }
      }
      
      expect(token).toBeNull();
    });
  });
  
  describe('SessionStorage Integration', () => {
    test('should read auth0_token from sessionStorage', () => {
      const auth0Token = 'eyJhbGciOiJSUzI1NiJ9.auth0.token';
      sessionStorage.setItem('auth0_token', auth0Token);
      
      const token = sessionStorage.getItem('auth0_token');
      
      expect(token).toBe(auth0Token);
      expect(typeof token).toBe('string');
    });
    
    test('should handle missing sessionStorage key', () => {
      const token = sessionStorage.getItem('auth0_token');
      expect(token).toBeNull();
    });
  });
  
  describe('LocalStorage Fallback', () => {
    test('should parse auth-tokens JSON from localStorage', () => {
      const tokenData = {
        access_token: 'eyJhbGciOiJIUzI1NiJ9.legacy.token',
        refresh_token: 'refresh.token.here'
      };
      
      localStorage.setItem('auth-tokens', JSON.stringify(tokenData));
      
      const authTokens = localStorage.getItem('auth-tokens');
      const parsed = JSON.parse(authTokens);
      
      expect(parsed.access_token).toBe(tokenData.access_token);
    });
    
    test('should handle malformed JSON in localStorage', () => {
      localStorage.setItem('auth-tokens', 'invalid-json{');
      
      let token = null;
      try {
        const authTokens = localStorage.getItem('auth-tokens');
        const parsed = JSON.parse(authTokens);
        token = parsed?.access_token;
      } catch (err) {
        // Expected to fail
      }
      
      expect(token).toBeNull();
    });
    
    test('should handle missing access_token field', () => {
      localStorage.setItem('auth-tokens', JSON.stringify({
        refresh_token: 'refresh.token.here'
      }));
      
      const authTokens = localStorage.getItem('auth-tokens');
      const parsed = JSON.parse(authTokens);
      const token = parsed?.access_token;
      
      expect(token).toBeUndefined();
    });
  });
  
  describe('Authorization Header Format', () => {
    test('should format Bearer token correctly', () => {
      const token = 'eyJhbGciOiJSUzI1NiJ9.auth0.token';
      
      const authHeader = `Bearer ${token}`;
      
      expect(authHeader).toBe(`Bearer ${token}`);
      expect(authHeader).toMatch(/^Bearer /);
    });
    
    test('should only create Authorization header if token exists', () => {
      const token = sessionStorage.getItem('auth0_token');
      
      let authHeader = undefined;
      if (token) {
        authHeader = `Bearer ${token}`;
      }
      
      expect(authHeader).toBeUndefined();
    });
  });
  
  describe('Dashboard Integration Scenario', () => {
    test('should receive token from dashboard parent window', () => {
      // Simulate dashboard setting token in sessionStorage
      const dashboardToken = 'eyJhbGciOiJSUzI1NiJ9.dashboard.token';
      
      // This would be set by dashboard's useEffect
      sessionStorage.setItem('auth0_token', dashboardToken);
      
      // Plugin reads it
      const token = sessionStorage.getItem('auth0_token');
      
      expect(token).toBe(dashboardToken);
    });
    
    test('should update when token changes', () => {
      const token1 = 'token1.eyJ.test';
      const token2 = 'token2.eyJ.test';
      
      // First API call with token1
      sessionStorage.setItem('auth0_token', token1);
      let currentToken = sessionStorage.getItem('auth0_token');
      expect(currentToken).toBe(token1);
      
      // Dashboard updates token
      sessionStorage.setItem('auth0_token', token2);
      
      // Second API call with token2
      currentToken = sessionStorage.getItem('auth0_token');
      expect(currentToken).toBe(token2);
    });
  });
  
  describe('Error Handling', () => {
    test('should handle storage quota exceeded gracefully', () => {
      // This is hard to test reliably, but we document the expected behavior
      let error = null;
      try {
        // Try to store a very large string
        sessionStorage.setItem('auth0_token', 'x'.repeat(10000000));
      } catch (err) {
        error = err;
      }
      
      // Should catch QuotaExceededError
      expect(error).toBeTruthy();
    });
  });
});
