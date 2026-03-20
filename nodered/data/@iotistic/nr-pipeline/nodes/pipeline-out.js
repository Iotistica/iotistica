/**
 * iotistica-pipeline-out  –  Node-RED node (runtime)
 *
 * Resolves the pending promise held by the agent's PipelineService.
 * Set msg.drop = true to tell the agent to skip publishing this batch.
 */
'use strict';

module.exports = function (RED) {
    function PipelineOutNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        if (!globalThis.__iotisticaPendingTransforms) {
            node.status({ fill: 'grey', shape: 'ring', text: 'waiting for agent' });
        } else {
            node.status({ fill: 'green', shape: 'dot', text: 'connected' });
        }

        node.on('input', function (msg) {
            const correlationId = msg._correlationId;
            if (!correlationId) {
                node.warn('iotistica-pipeline-out: message missing _correlationId — ignored');
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
                topic:   msg.topic || '',
                drop:    msg.drop === true,
            });
        });

        node.on('close', function () {
            node.status({});
        });
    }

    RED.nodes.registerType('iotistica-pipeline-out', PipelineOutNode);
};
