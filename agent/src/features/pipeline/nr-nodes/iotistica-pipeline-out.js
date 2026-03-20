/**
 * iotistica-pipeline-out  –  Node-RED custom node
 *
 * Resolves the pending promise stored in globalThis.__iotisticaPendingTransforms
 * keyed by the _correlationId set by iotistica-pipeline-in.
 */
'use strict';

module.exports = function (RED) {
  function PipelineOutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', function (msg) {
      const correlationId = msg._correlationId;
      if (!correlationId) {
        node.warn('PipelineOutNode: received message without _correlationId');
        return;
      }

      const pending = globalThis.__iotisticaPendingTransforms &&
        globalThis.__iotisticaPendingTransforms.get(correlationId);

      if (!pending) {
        // Already timed out or duplicate delivery
        return;
      }

      clearTimeout(pending.timer);
      globalThis.__iotisticaPendingTransforms.delete(correlationId);

      pending.resolve({
        payload: msg.payload,
        topic: msg.topic || '',
        drop: msg.drop === true,
      });
    });
  }

  RED.nodes.registerType('iotistica-pipeline-out', PipelineOutNode);
};
