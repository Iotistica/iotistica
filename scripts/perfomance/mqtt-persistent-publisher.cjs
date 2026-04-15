const path = require('path');
const mqtt = require(path.resolve(__dirname, '../../api/node_modules/mqtt'));

function getArgValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) {
    return null;
  }

  return process.argv[index + 1];
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function createPublishOptions(config) {
  return { qos: config.qos ?? 1 };
}

function publishBatch(client, batch, config) {
  return new Promise((resolve, reject) => {
    client.publish(batch.topic, batch.payload, createPublishOptions(config), (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

// Yield the event loop so keepalive timers can fire between chunk bursts.
function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Publish batches in chunks, yielding between each chunk so the MQTT
// keepalive timers are not starved by a large burst of socket writes.
async function publishBatchesInChunks(batches, clientsByAgent, config, chunkSize) {
  for (let i = 0; i < batches.length; i += chunkSize) {
    const chunk = batches.slice(i, i + chunkSize);
    await Promise.all(chunk.map((batch) => {
      const lookupKey = batch.clientKey ?? batch.agentUuid;
      const entry = clientsByAgent.get(lookupKey);
      if (!entry) {
        throw new Error(`Unknown client ${lookupKey}`);
      }
      return publishBatch(entry.client, batch, config);
    }));
    if (i + chunkSize < batches.length) {
      await yieldEventLoop();
    }
  }
}

async function closeAllClients(clientsByAgent) {
  const closePromises = [...clientsByAgent.values()].map((entry) => new Promise((resolve) => {
    entry.client.end(false, {}, () => resolve());
  }));

  await Promise.all(closePromises);
}

function buildMqttOptions(config, agent) {
  const options = {
    clientId: agent.clientId,
    username: config.username,
    password: config.password,
    clean: config.cleanSession,
    reconnectPeriod: config.reconnectPeriod,
    keepalive: config.keepAlive,
    connectTimeout: config.connectTimeout,
    rejectUnauthorized: config.rejectUnauthorized,
  };

  if (config.caCert) {
    options.ca = config.caCert;
  }

  return options;
}

function attachLifecycleLogging(client, agent) {
  client.on('reconnect', () => {
    writeMessage({
      type: 'log',
      level: 'info',
      clientId: agent.clientId,
      agentUuid: agent.agentUuid,
      message: 'MQTT reconnecting',
    });
  });

  client.on('offline', () => {
    writeMessage({
      type: 'log',
      level: 'warn',
      clientId: agent.clientId,
      agentUuid: agent.agentUuid,
      message: 'MQTT client offline',
    });
  });

  client.on('close', () => {
    writeMessage({
      type: 'log',
      level: 'info',
      clientId: agent.clientId,
      agentUuid: agent.agentUuid,
      message: 'MQTT connection closed',
    });
  });

  client.on('error', (error) => {
    writeMessage({
      type: 'log',
      level: 'error',
      clientId: agent.clientId,
      agentUuid: agent.agentUuid,
      message: toErrorMessage(error),
    });
  });
}

function connectAgentClient(config, agent) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(config.brokerUrl, buildMqttOptions(config, agent));
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      client.end(true);
      reject(new Error(`MQTT connect timeout for ${agent.clientId}`));
    }, config.connectTimeout + 1000);

    const cleanupInitialListeners = () => {
      clearTimeout(timer);
      client.off('connect', handleConnect);
      client.off('error', handleError);
    };

    const handleConnect = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupInitialListeners();
      attachLifecycleLogging(client, agent);
      resolve({
        agentUuid: agent.agentUuid,
        clientId: agent.clientId,
        topic: agent.topic,
        client,
      });
    };

    const handleError = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupInitialListeners();
      client.end(true);
      reject(error);
    };

    client.on('connect', handleConnect);
    client.on('error', handleError);
  });
}

async function main() {
  const configArg = getArgValue('--config');
  if (!configArg) {
    throw new Error('Missing --config argument');
  }

  const config = JSON.parse(Buffer.from(configArg, 'base64').toString('utf8'));
  const clientsByAgent = new Map();

  for (const agent of config.agents) {
    const connection = await connectAgentClient(config, agent);
    clientsByAgent.set(agent.clientKey ?? agent.agentUuid, connection);
  }

  writeMessage({
    type: 'ready',
    clientCount: clientsByAgent.size,
  });

  process.stdin.setEncoding('utf8');
  let buffered = '';
  let queue = Promise.resolve();

  process.stdin.on('data', (chunk) => {
    buffered += chunk;

    let newlineIndex = buffered.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffered.slice(0, newlineIndex).trim();
      buffered = buffered.slice(newlineIndex + 1);
      newlineIndex = buffered.indexOf('\n');

      if (!line) {
        continue;
      }

      queue = queue.then(async () => {
        const command = JSON.parse(line);

        if (command.command === 'publish') {
          try {
            // Publish in chunks of 10 to avoid starving the event loop
            // (and thus the MQTT keepalive timer) during large flush bursts.
            await publishBatchesInChunks(command.batches, clientsByAgent, config, 10);

            writeMessage({
              type: 'response',
              requestId: command.requestId,
              ok: true,
              published: command.batches.length,
            });
          } catch (error) {
            writeMessage({
              type: 'response',
              requestId: command.requestId,
              ok: false,
              error: toErrorMessage(error),
            });
          }

          return;
        }

        if (command.command === 'shutdown') {
          await closeAllClients(clientsByAgent);
          writeMessage({
            type: 'response',
            requestId: command.requestId,
            ok: true,
            closed: clientsByAgent.size,
          });
          process.exit(0);
        }

        writeMessage({
          type: 'response',
          requestId: command.requestId,
          ok: false,
          error: `Unknown command ${command.command}`,
        });
      }).catch((error) => {
        writeMessage({
          type: 'response',
          requestId: null,
          ok: false,
          error: toErrorMessage(error),
        });
      });
    }
  });

  process.stdin.on('end', async () => {
    await closeAllClients(clientsByAgent);
    process.exit(0);
  });
}

main().catch((error) => {
  process.stderr.write(`${toErrorMessage(error)}\n`);
  process.exit(1);
});