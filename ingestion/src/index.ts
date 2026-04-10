import { applyIngestionProfile } from './config/profile';

type NetworkError = NodeJS.ErrnoException & {
  address?: string;
  port?: number;
};

async function main(): Promise<void> {
  const profileConfig = applyIngestionProfile();

  const [
    { default: logger },
    { createIngestionServer },
    { startIngestionServer },
    { bootstrapConfig },
    { bootstrapDatabaseConnection },
    { bootstrapIngestionRedis },
  ] = await Promise.all([
    import('./utils/logger'),
    import('./server/app'),
    import('./server/lifecycle'),
    import('./bootstrap/config'),
    import('./bootstrap/database'),
    import('./bootstrap/redis'),
  ]);

  logger.info('Initializing Iotistica ingestion service...');
  logger.info('Resolved ingestion runtime profile', {
    requestedProfile: profileConfig.requestedProfile,
    resolvedProfile: profileConfig.resolvedProfile,
    appliedDefaults: profileConfig.appliedDefaults,
  });

  await bootstrapDatabaseConnection();
  await bootstrapConfig();

  const server = createIngestionServer();
  await bootstrapIngestionRedis();
  await startIngestionServer(server);
}

main().catch((error) => {
  void import('./utils/logger').then(({ default: logger }) => {
    if (error instanceof Error) {
      const networkError = error as NetworkError;
      logger.error('Failed to start ingestion service', {
        error: error.message,
        stack: error.stack,
        code: networkError.code,
        errno: networkError.errno,
        syscall: networkError.syscall,
        address: networkError.address,
        port: networkError.port,
      });
    } else {
      logger.error('Failed to start ingestion service', { error: String(error) });
    }

    process.exit(1);
  }).catch(() => {
    console.error('Failed to start ingestion service', error);
    process.exit(1);
  });
});