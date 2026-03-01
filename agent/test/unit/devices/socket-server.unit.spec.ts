import { SocketServer } from '../../../src/features/adapters/common/socket-server';
import { SocketOutput } from '../../../src/features/adapters/types';

describe('SocketServer', () => {
  let mockLogger: any;
  let config: SocketOutput;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    config = {
      socketPath: '\\\\.\\pipe\\test-sensor-socket',
      dataFormat: 'json',
      delimiter: '\n',
      includeTimestamp: true,
      includeDeviceName: true
    };
  });

  it('should create socket server instance', () => {
    const server = new SocketServer(config, mockLogger);
    expect(server).toBeDefined();
  });

  it('should not be running initially', () => {
    const server = new SocketServer(config, mockLogger);
    expect(server.isRunning()).toBe(false);
  });

  it('should have zero clients initially', () => {
    const server = new SocketServer(config, mockLogger);
    expect(server.getClientCount()).toBe(0);
  });

  it('should not send data when not started', () => {
    const server = new SocketServer(config, mockLogger);
    const dataPoints = [{
      deviceName: 'test',
      metric: 'temp',
      value: 25,
      unit: 'C',
      timestamp: new Date().toISOString(),
      quality: 'GOOD' as const
    }];
    
    server.sendData(dataPoints);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});
