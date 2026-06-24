import { client } from './client'

export type ServiceStatus = {
  state: 'creating' | 'running' | 'stopped' | 'error' | 'unknown'
  startedAt?: string
  finishedAt?: string
  exitCode?: number
  restartCount?: number
  health?: 'healthy' | 'unhealthy' | 'starting' | 'unknown'
  message?: string
}

export interface ContainerService {
  serviceId: number
  serviceName: string
  imageName: string
  appId: number
  appName: string
  state?: 'running' | 'stopped' | 'paused'
  serviceStatus?: 'pending' | 'running' | 'stopped' | 'error'
  containerId?: string
  status?: ServiceStatus
  error?: {
    type: 'ImagePullBackOff' | 'ErrImagePull' | 'StartFailure' | 'CrashLoopBackOff'
    message: string
    retryCount: number
    nextRetry?: string
  }
  config: {
    image: string
    ports?: string[]
    environment?: Record<string, string>
    volumes?: string[]
    restart?: string
    labels?: Record<string, string>
  }
}

export interface ContainerApp {
  appId: number
  appName: string
  services: ContainerService[]
}

export interface DeployServiceForm {
  serviceName: string
  imageName: string
  state?: 'running' | 'stopped'
  config: {
    image: string
    ports?: string[]
    environment?: Record<string, string>
    volumes?: string[]
    restart?: string
  }
}

export interface DeployAppForm {
  appName: string
  services: DeployServiceForm[]
}

export type DockerConnectionType = 'socket' | 'tcp' | 'tcp+tls'

export interface DockerConfig {
  type: DockerConnectionType
  socketPath?: string
  host?: string
  port?: number
  ca?: string
  cert?: string
  key?: string
}

export interface DockerTestResult {
  version: string
  containers: number
}

export const dockerConfigApi = {
  get(): Promise<DockerConfig> {
    return client.get<DockerConfig>('/v1/docker/config').then(r => r.data)
  },
  save(cfg: DockerConfig): Promise<void> {
    return client.post('/v1/docker/config', cfg).then(() => undefined)
  },
  test(cfg: DockerConfig): Promise<DockerTestResult> {
    return client.post<DockerTestResult>('/v1/docker/test', cfg).then(r => r.data)
  },
}

export const containersApi = {
  getAll(): Promise<ContainerApp[]> {
    return client.get<{ apps: ContainerApp[] }>('/v1/apps').then(r => r.data.apps)
  },

  deploy(form: DeployAppForm): Promise<{ appId: number; appName: string }> {
    return client.post('/v1/apps', form).then(r => r.data)
  },

  addService(appId: number, form: DeployServiceForm): Promise<ContainerService> {
    return client.post<ContainerService>(`/v1/apps/${appId}/services`, form).then(r => r.data)
  },

  updateService(appId: number, serviceName: string, form: DeployServiceForm): Promise<ContainerService> {
    return client.put<ContainerService>(
      `/v1/apps/${appId}/services/${encodeURIComponent(serviceName)}`,
      form,
    ).then(r => r.data)
  },

  remove(appId: number): Promise<void> {
    return client.delete(`/v1/apps/${appId}`).then(() => undefined)
  },

  removeService(appId: number, serviceName: string): Promise<void> {
    return client.delete(`/v1/apps/${appId}/services/${encodeURIComponent(serviceName)}`).then(() => undefined)
  },

  serviceAction(
    appId: number,
    serviceName: string,
    action: 'start' | 'stop' | 'restart',
  ): Promise<void> {
    return client
      .post(`/v1/apps/${appId}/services/${encodeURIComponent(serviceName)}/${action}`)
      .then(() => undefined)
  },
}
