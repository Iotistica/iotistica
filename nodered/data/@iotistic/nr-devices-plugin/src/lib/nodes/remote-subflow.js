const { getMqttManager } = require('../comms/mqtt')

module.exports = function (RED) {
  async function fetchDeviceName(deviceUuid) {
    try {
      const iotisticURL = RED.settings.iotisticURL || 'http://api:3002';
      const axios = require('axios');
      const response = await axios.get(`${iotisticURL}/devices/${deviceUuid}`);
      return response.data.name || deviceUuid.substring(0, 8);
    } catch (err) {
      return deviceUuid.substring(0, 8);
    }
  }

  function DeviceFlowNode(config) {

    RED.nodes.createNode(this, config);
    const node = this;
    node.timeoutRefs = {};
    node.devicesStatus = {};

    node.deviceUuid = config.deviceUuid || "";
    node.deviceName = config.deviceName || node.deviceUuid.substring(0, 8);
    node.subflowId = config.subflowId;
    
    // Fetch device name if not in config (for backward compatibility)
    if (!config.deviceName && node.deviceUuid) {
      fetchDeviceName(node.deviceUuid).then(name => {
        node.deviceName = name;
        node.log(`Fetched device name: ${node.deviceName}`);
        node.status({ fill: "green", shape: "dot", text: `running on ${node.deviceName}` });
      });
    }
    
    node.log(`Remote subflow initialized - Device: ${node.deviceName} (${node.deviceUuid})`);

    // Only connect if deviceUuid is provided
    if (node.deviceUuid) {
      // Get shared MQTT connection manager
      const mqttBroker = RED.settings.mqttBroker || process.env.MQTT_BROKER_URL || 'mqtt://mosquitto:1883';
      const mqttUsername = RED.settings.mqttUsername || process.env.MQTT_USERNAME;
      const mqttPassword = RED.settings.mqttPassword || process.env.MQTT_PASSWORD;

      if (!mqttUsername || !mqttPassword) {
        node.warn('MQTT credentials missing. Configure MQTT_USERNAME and MQTT_PASSWORD before enabling remote subflow MQTT bridge.');
        node.status({ fill: 'yellow', shape: 'ring', text: 'mqtt creds missing' });
        return;
      }

      node.mqttManager = getMqttManager(RED, {
        url: mqttBroker,
        username: mqttUsername,
        password: mqttPassword
      });

      // Register this node
      const nodeId = `remote-subflow-${node.id}`;
      node.mqttManager.register(nodeId, node);

      node.log("remote flow connecting to broker");
      node.status({ fill: "green", shape: "dot", text: `running on ${node.deviceName}` });

      // Handle incoming messages
      function handleMessage(topic, message) {
        try {
          let msg = { payload: message.toString() };
           
          const subflowMatch = topic.match(/device\/([^\/]+)\/sublow\/([^\/]+)/);
          const subflowId = subflowMatch ? subflowMatch[2] : "unknown";

          const deviceMatch = topic.match(/device\/([^\/]+)/);
          const deviceId = deviceMatch ? deviceMatch[1] : "unknown"; 

          // Add the device ID to the message
          msg.deviceId = deviceId;
          msg.subflowId = subflowId;
          msg.topic = topic;

          // Extract the output number from the topic (e.g., "out/1" → 1)
          let match = topic.match(/out\/(\d+)/);
          if (match) {
            let outputIndex = parseInt(match[1], 10) - 1; // Convert "1" → 0-based index

            // Create an array of nulls and set the correct index
            let outputs = [null, null]; 
            outputs[outputIndex] = msg;

            node.send(outputs);

            // Clear timeout for this device
            if (node.timeoutRefs && node.timeoutRefs[deviceId] && node.timeoutRefs[deviceId].id) {
              clearTimeout(node.timeoutRefs[deviceId].id);
            }

            node.status({
              fill: "green",
              shape: "dot",
              text: `running on ${node.deviceName}`,
            });
          }

        } catch (err) {
          node.error("Failed to parse incoming broker message: " + err);
          node.status({
            fill: "red",
            shape: "ring",
            text: "error",
          });
        }
      }

      // Handle input messages
      node.on("input", (msg) => {
        const timeoutMs = 10000;
        const deviceId = node.deviceUuid;

        const topic_input = `iot/device/${deviceId}/sublow/${node.subflowId}/in`;
        const topic_output = `iot/device/${deviceId}/sublow/${node.subflowId}/out/+`

        // Convert the payload to JSON string
        const payload = JSON.stringify(msg.payload);

        // Publish the message to the broker for the device
        node.mqttManager.publish(topic_input, payload, { qos: 2 }, (err) => {
          if (err) {
            node.error(`Failed to publish message to broker for device ${deviceId}`, err);
            node.status({
              fill: "red",
              shape: "ring",
              text: "broker error",
            });
          } else {
            node.log(`Published to device ${deviceId} at topic ${topic_input}`);

            // Subscribe to output topic with handler
            node.mqttManager.subscribe(topic_output, handleMessage, nodeId, { qos: 0 });
            
            node.status({ fill: "green", shape: "dot", text: `waiting on ${node.deviceName}` });
            node.log(`Subscribed to output: ${topic_output}`);

            // Set timeout for response
            if (!node.timeoutRefs) {
              node.timeoutRefs = {};
            }

            const timeout = setTimeout(() => {
              node.log(`No messages received within ${timeoutMs / 1000} seconds, unsubscribing...`);
              node.mqttManager.unsubscribe(topic_output, nodeId);
              node.log(`Unsubscribed from ${topic_output}`);

              node.status({
                fill: "red",
                shape: "dot",
                text: "timeout",
              });
            }, timeoutMs);

            node.timeoutRefs[deviceId] = { id: timeout };

            node.status({
              fill: "green",
              shape: "dot",
              text: `sent to ${node.deviceName}`,
            });
          }
        });
      });

      // Handle node close
      node.on("close", (done) => {
        node.log(`Closing remote subflow node for device ${node.deviceUuid}`);
        
        // Deregister from connection pool (automatically handles cleanup)
        if (node.mqttManager) {
          node.mqttManager.deregister(nodeId);
        }
        
        done();
      });
    } else {
      node.warn("No device UUID provided. MQTT client will not connect.");
    }
  }

  RED.nodes.registerType("remote subflow", DeviceFlowNode);

};
