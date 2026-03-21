/**
 * iotistica-pipeline-in  –  Node-RED node (runtime)
 *
 * When running inside the embedded PipelineService (agent), messages arrive via
 * globalThis.__iotisticaPipelineEvents.  When running in a standalone Node-RED
 * editor the node is inert (no event source) — it is there so you can build and
 * save the flow visually; the agent provides the event source at runtime.
 */
'use strict';

module.exports = function (RED) {
    /** @param {PipelineInConfig} config */
    function PipelineInNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const emitter = globalThis.__iotisticaPipelineEvents;

        if (!emitter) {
            // Standalone editor / preview mode — show idle status
            node.status({ fill: 'grey', shape: 'ring', text: 'deploy to activate' });
            return;
        }

        node.status({ fill: 'green', shape: 'dot', text: 'connected' });

        /** @param {PipelineTransformInput} data */
        const handler = function (data) {
            node.send({
                _correlationId: data.correlationId,
                payload:        data.payload,
                topic:          data.topic,
                deviceId:       data.deviceId,
            });
        };

        emitter.on('pipeline:in', handler);

        node.on('close', function () {
            emitter.removeListener('pipeline:in', handler);
            node.status({});
        });
    }

    RED.nodes.registerType('iotistica-pipeline-in', PipelineInNode);
};
