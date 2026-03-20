/**
 * iotistica-pipeline-in  –  Node-RED custom node
 *
 * This is a plain CJS module that Node-RED discovers via nodesDir.
 * It reads from globalThis.__iotisticaPipelineEvents so it can be driven
 * by the TypeScript PipelineService without any direct-module coupling.
 */
'use strict';

module.exports = function (RED) {
  function PipelineInNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const emitter = globalThis.__iotisticaPipelineEvents;
    if (!emitter) {
      node.warn('PipelineInNode: __iotisticaPipelineEvents not set on globalThis');
      return;
    }

    const handler = function (data) {
      node.send({
        _correlationId: data.correlationId,
        payload: data.payload,
        topic: data.topic,
        deviceId: data.deviceId,
      });
    };

    emitter.on('pipeline:in', handler);

    // Clean up listener when node is removed
    node.on('close', function () {
      emitter.removeListener('pipeline:in', handler);
    });
  }

  RED.nodes.registerType('iotistica-pipeline-in', PipelineInNode);
};
