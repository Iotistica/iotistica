/**
 * Storage Auth Tests for nr-storage Plugin
 * 
 * Tests Auth0 token usage in storage API calls
 */

const nock = require('nock');

describe('Storage Auth - nr-storage Plugin', () => {
  let storageModule;
  let mockAuthToken;
  let getAuthTokenMock;
  const baseURL = 'http://api:3002';
  
  beforeAll(() => {
    mockAuthToken = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test.token';
  });
  
  beforeEach(() => {
    jest.clearAllMocks();
    nock.cleanAll();
    
    // Clear require cache
    jest.resetModules();
    
    // Create mock getAuthToken function
    getAuthTokenMock = jest.fn().mockReturnValue(mockAuthToken);
    
    // Initialize storage module with getAuthToken
    const storageFactory = require('../data/@iotistic/nr-storage');
    storageModule = storageFactory({
      iotisticURL: baseURL,
      getAuthToken: getAuthTokenMock
    });
  });
  
  afterEach(() => {
    nock.cleanAll();
  });
  
  describe('Storage Configuration', () => {
    test('should require iotisticURL', () => {
      const storageFactory = require('../data/@iotistic/nr-storage');
      
      expect(() => {
        storageFactory({
          getAuthToken: getAuthTokenMock
        });
      }).toThrow('No iotisticURL found in storage settings');
    });
    
    test('should require getAuthToken function', () => {
      const storageFactory = require('../data/@iotistic/nr-storage');
      
      expect(() => {
        storageFactory({
          iotisticURL: baseURL
        });
      }).toThrow('getAuthToken function required');
    });
    
    test('should initialize with valid configuration', () => {
      const storageFactory = require('../data/@iotistic/nr-storage');
      
      expect(() => {
        storageFactory({
          iotisticURL: baseURL,
          getAuthToken: getAuthTokenMock
        });
      }).not.toThrow();
    });
  });
  
  describe('Auth Token Usage', () => {
    test('should call getAuthToken before API requests', async () => {
      nock(baseURL)
        .get('/api/v1/nr/storage/flows')
        .reply(200, { flows: [] });
      
      await storageModule.getFlows();
      
      expect(getAuthTokenMock).toHaveBeenCalled();
    });
    
    test('should include token in Authorization header', async () => {
      const scope = nock(baseURL)
        .get('/api/v1/nr/storage/flows')
        .matchHeader('authorization', `Bearer ${mockAuthToken}`)
        .reply(200, { flows: [] });
      
      await storageModule.getFlows();
      
      expect(scope.isDone()).toBe(true);
    });
    
    test('should throw error if token unavailable', async () => {
      getAuthTokenMock.mockReturnValue(null);
      
      await expect(storageModule.getFlows()).rejects.toThrow(
        'Auth0 token not available in session'
      );
    });
  });
  
  describe('Storage Operations', () => {
    test('getFlows should use Auth0 token', async () => {
      const mockFlows = [{ id: 'flow1', type: 'tab' }];
      
      nock(baseURL)
        .get('/api/v1/nr/storage/flows')
        .matchHeader('authorization', `Bearer ${mockAuthToken}`)
        .reply(200, { flows: mockFlows });
      
      const flows = await storageModule.getFlows();
      
      expect(flows).toEqual(mockFlows);
      expect(getAuthTokenMock).toHaveBeenCalled();
    });
    
    test('saveFlows should use Auth0 token', async () => {
      const flowData = [{ id: 'flow1', type: 'tab' }];
      
      nock(baseURL)
        .post('/api/v1/nr/storage/flows', flowData)
        .matchHeader('authorization', `Bearer ${mockAuthToken}`)
        .reply(200, { success: true });
      
      await storageModule.saveFlows(flowData);
      
      expect(getAuthTokenMock).toHaveBeenCalled();
    });
    
    test('getCredentials should use Auth0 token', async () => {
      const mockCredentials = { node1: { username: 'test' } };
      
      nock(baseURL)
        .get('/api/v1/nr/storage/credentials')
        .matchHeader('authorization', `Bearer ${mockAuthToken}`)
        .reply(200, mockCredentials);
      
      const credentials = await storageModule.getCredentials();
      
      expect(credentials).toEqual(mockCredentials);
      expect(getAuthTokenMock).toHaveBeenCalled();
    });
    
    test('saveCredentials should use Auth0 token', async () => {
      const credentialsData = { node1: { username: 'test' } };
      
      nock(baseURL)
        .post('/api/v1/nr/storage/credentials', credentialsData)
        .matchHeader('authorization', `Bearer ${mockAuthToken}`)
        .reply(200, { success: true });
      
      await storageModule.saveCredentials(credentialsData);
      
      expect(getAuthTokenMock).toHaveBeenCalled();
    });
  });
  
  describe('Token Refreshing', () => {
    test('should get fresh token for each request', async () => {
      const tokens = [
        'token1.eyJ.test',
        'token2.eyJ.test',
        'token3.eyJ.test'
      ];
      let tokenIndex = 0;
      
      getAuthTokenMock.mockImplementation(() => tokens[tokenIndex++]);
      
      nock(baseURL)
        .get('/api/v1/nr/storage/flows')
        .matchHeader('authorization', `Bearer ${tokens[0]}`)
        .reply(200, { flows: [] });
      
      await storageModule.getFlows();
      
      nock(baseURL)
        .get('/api/v1/nr/storage/credentials')
        .matchHeader('authorization', `Bearer ${tokens[1]}`)
        .reply(200, {});
      
      await storageModule.getCredentials();
      
      expect(getAuthTokenMock).toHaveBeenCalledTimes(2);
    });
  });
  
  describe('Error Handling', () => {
    test('should handle 401 Unauthorized response', async () => {
      nock(baseURL)
        .get('/api/v1/nr/storage/flows')
        .reply(401, { error: 'Unauthorized' });
      
      await expect(storageModule.getFlows()).rejects.toThrow();
    });
    
    test('should handle network errors', async () => {
      nock(baseURL)
        .get('/api/v1/nr/storage/flows')
        .replyWithError('Network error');
      
      await expect(storageModule.getFlows()).rejects.toThrow();
    });
  });
});
