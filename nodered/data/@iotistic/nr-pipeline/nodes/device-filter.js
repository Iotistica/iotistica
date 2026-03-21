/**
 * iotistica-device-filter  –  Node-RED node (runtime)
 *
 * Filters pipeline messages by device UUID and/or MQTT topic pattern.
 *
 * Outputs
 *   1 (index 0) — message passed the filter (allow mode: matched; block mode: not matched)
 *   2 (index 1) — message did NOT pass the filter
 *
 * Config
 *   mode        'allow' (default) | 'block'
 *   devices     comma-separated list of endpoint device UUIDs (empty = match all)
 *   topics      newline-separated list of MQTT topic patterns (empty = match all)
 *               Patterns support MQTT wildcards: + (single level), # (multi level)
 *
 * @typedef {import('@iotistic/types').PipelineTransformInput} PipelineTransformInput
 * @typedef {import('@iotistic/types').DeviceFilterConfig} DeviceFilterConfig
 */
'use strict';

/**
 * Convert an MQTT topic pattern to a RegExp.
 * '+' matches exactly one topic level, '#' matches the rest of the path.
 */
function topicPatternToRegex(pattern) {
    const escaped = pattern
        .replace(/[.^${}()|[\]\\]/g, '\\$&') // escape regex special chars except + and #
        .replace(/\+/g, '[^/]+')              // + = one level
        .replace(/#/g, '.*');                  // # = rest of path
    return new RegExp('^' + escaped + '$');
}

module.exports = function (RED) {
    /** @param {DeviceFilterConfig} config */
    function DeviceFilterNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const mode = config.mode === 'block' ? 'block' : 'allow';

        // Parse device UUID list (stored as comma-separated string)
        const deviceSet = new Set(
            (config.devices || '')
                .split(',')
                .map(function (s) { return s.trim(); })
                .filter(Boolean)
        );

        // Parse topic patterns (stored as newline-separated string)
        const topicRegexes = (config.topics || '')
            .split('\n')
            .map(function (s) { return s.trim(); })
            .filter(Boolean)
            .map(topicPatternToRegex);

        const deviceLabel = deviceSet.size ? deviceSet.size + ' device(s)' : 'any device';
        const topicLabel  = topicRegexes.length ? topicRegexes.length + ' pattern(s)' : 'any topic';
        node.status({ fill: 'blue', shape: 'dot', text: mode + ' \u00b7 ' + deviceLabel + ' \u00b7 ' + topicLabel });

        node.on('input', function (/** @type {PipelineTransformInput} */ msg) {
            const deviceMatch = deviceSet.size === 0 || deviceSet.has(msg.deviceId);
            const topicMatch  = topicRegexes.length === 0 || topicRegexes.some(function (re) {
                return re.test(msg.topic || '');
            });

            const conditionMet = deviceMatch && topicMatch;
            const passes = mode === 'allow' ? conditionMet : !conditionMet;

            if (passes) {
                node.send([msg, null]);
            } else {
                node.send([null, msg]);
            }
        });

        node.on('close', function () {
            node.status({});
        });
    }

    RED.nodes.registerType('iotistica-device-filter', DeviceFilterNode);
};
