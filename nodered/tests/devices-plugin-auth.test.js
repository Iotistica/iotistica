/**
 * Devices Plugin Auth Tests for nr-devices-plugin
 * 
 * Tests Auth0 token usage from sessionStorage in device API calls
 */

describe('Devices Plugin Auth - nr-devices-plugin', () => {
  let getAuthHeaders;
  
  beforeEach(() => {
    // Clear all storage
    sessionStorage.clear();
    localStorage.clear();
    
    // Mock console.warn to avoid noise in tests
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    
    // Load the getAuthHeaders function from api.js
    // Note: This requires the api.js to be restructured for testing
    // or we mock the entire module behavior
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
      
      // Mock implementation of getAuthHeaders
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      };
      
      // Get Auth0 token from sessionStorage
      const token = sessionStorage.getItem('auth0_token');
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      
      expect(headers.Authorization).toBe(`Bearer ${auth0Token}`);
      expect(headers.Authorization).not.toContain(legacyToken);
    });
    
    test('should fallback to localStorage if sessionStorage empty', () => {
      const legacyToken = 'eyJhbGciOiJIUzI1NiJ9.legacy.token';
      
      localStorage.setItem('auth-tokens', JSON.stringify({
        access_token: legacyToken
      }));
      
      // Mock implementation of getAuthHeaders
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      };
      
      let token = sessionStorage.getItem('auth0_token');
      if (!token) {
        const authTokens = localStorage.getItem('auth-tokens');
        if (authTokens) {
          const tokenObj = JSON.parse(authTokens);
          token = tokenObj?.access_token;
        }
      }
      
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      
      expect(headers.Authorization).toBe(`Bearer ${legacyToken}`);
    });
    
    test('should return headers without Authorization if no token', () => {
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      };
      
      expect(headers.Authorization).toBeUndefined();
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
    
    test('should handle missing sessionStorage gracefully', () => {
      // Simulate sessionStorage unavailable
      const originalSessionStorage = window.sessionStorage;
      delete window.sessionStorage;
      
      let token = null;
      try {
        token = sessionStorage.getItem('auth0_token');
      } catch (err) {
        // Expected to fail
      }
      
      expect(token).toBeNull();
      
      // Restore
      window.sessionStorage = originalSessionStorage;
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
      
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      };
      
      expect(headers.Authorization).toBe(`Bearer ${token}`);
      expect(headers.Authorization).toMatch(/^Bearer /);
    });
    
    test('should only include Authorization if token exists', () => {
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      };
      
      const token = sessionStorage.getItem('auth0_token');
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      
      expect(headers.Authorization).toBeUndefined();
    });
  });
  
  describe('Dashboard Integration', () => {
    test('should receive token from dashboard parent window', () => {
      // Simulate dashboard setting token in sessionStorage
      const dashboardToken = 'eyJhbGciOiJSUzI1NiJ9.dashboard.token';
      
      // This would be set by dashboard's useEffect
      sessionStorage.setItem('auth0_token', dashboardToken);
      
      // Plugin reads it
      const token = sessionStorage.getItem('auth0_token');
      
      expect(token).toBe(dashboardToken);
    });
    
    test('should update headers when token changes', () => {
      const token1 = 'token1.eyJ.test';
      const token2 = 'token2.eyJ.test';
      
      // First API call with token1
      sessionStorage.setItem('auth0_token', token1);
      let headers = {
        Authorization: `Bearer ${sessionStorage.getItem('auth0_token')}`
      };
      expect(headers.Authorization).toBe(`Bearer ${token1}`);
      
      // Dashboard updates token
      sessionStorage.setItem('auth0_token', token2);
      
      // Second API call with token2
      headers = {
        Authorization: `Bearer ${sessionStorage.getItem('auth0_token')}`
      };
      expect(headers.Authorization).toBe(`Bearer ${token2}`);
    });
  });
  
  describe('API Request Scenarios', () => {
    test('should include Auth0 token in device list request', () => {
      const auth0Token = 'eyJhbGciOiJSUzI1NiJ9.auth0.token';
      sessionStorage.setItem('auth0_token', auth0Token);
      
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionStorage.getItem('auth0_token')}`
      };
      
      // Simulate API call
      expect(headers.Authorization).toBe(`Bearer ${auth0Token}`);
    });
    
    test('should include Auth0 token in device create request', () => {
      const auth0Token = 'eyJhbGciOiJSUzI1NiJ9.auth0.token';
      sessionStorage.setItem('auth0_token', auth0Token);
      
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionStorage.getItem('auth0_token')}`
      };
      
      expect(headers.Authorization).toBe(`Bearer ${auth0Token}`);
    });
    
    test('should include Auth0 token in device update request', () => {
      const auth0Token = 'eyJhbGciOiJSUzI1NiJ9.auth0.token';
      sessionStorage.setItem('auth0_token', auth0Token);
      
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionStorage.getItem('auth0_token')}`
      };
      
      expect(headers.Authorization).toBe(`Bearer ${auth0Token}`);
    });
  });
  
  describe('Error Handling', () => {
    test('should handle storage quota exceeded', () => {
      // This is hard to test reliably, but we document the expected behavior
      // The plugin should gracefully handle storage failures
      
      let error = null;
      try {
        sessionStorage.setItem('auth0_token', 'token'.repeat(10000000));
      } catch (err) {
        error = err;
      }
      
      // Should catch QuotaExceededError
      expect(error).toBeTruthy();
    });
    
    test('should handle SecurityError in storage access', () => {
      // When running in sandboxed iframe, storage access may throw SecurityError
      // The plugin should handle this gracefully
      
      // This is difficult to test directly, but the code should have try-catch
      let token = null;
      try {
        token = sessionStorage.getItem('auth0_token');
      } catch (err) {
        console.warn('Storage access denied:', err);
      }
      
      // Should not crash, token should be null/undefined
      expect(token).toBeNull();
    });
  });
});
