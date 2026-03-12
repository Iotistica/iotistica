// Import the globals
import $ from 'jquery'
import RED from 'node-red'

const mqttTreeContentTemplate = `
<div class="mqtt-tree-viewer">
    <div class="mqtt-tree-content">
        <!-- Filter input -->
        <div style="padding: 8px; border-bottom: 1px solid var(--red-ui-secondary-border-color);">
            <input type="text" id="mqtt-topic-filter" placeholder="Filter topics..." 
                   style="width: 100%; padding: 6px; border: 1px solid var(--red-ui-secondary-border-color); border-radius: 3px; background: var(--red-ui-secondary-background); color: var(--red-ui-primary-text-color);">
        </div>
        
        <!-- Top section: Topic tree -->
        <div class="mqtt-tree-topics" style="flex: 1; overflow: auto; border-bottom: 1px solid var(--red-ui-secondary-border-color); padding: 8px;">
            <div id="mqtt-topic-tree" style="font-family: monospace; font-size: 12px;">
                <div style="color: #999; padding: 20px; text-align: center;">
                    Waiting for messages...<br/>
                    <small>Connect mqtt-tree-viewer node to see topics</small>
                </div>
            </div>
        </div>
        
        <!-- Bottom section: Tabbed view for Messages and Schema -->
        <div class="mqtt-tree-messages">
            <div class="red-ui-sidebar-header" style="padding: 8px 12px; font-weight: bold;">
                <span class="button-group" style="float: left;">
                    <button id="mqtt-tab-messages" class="mqtt-tab-button active" data-tab="messages">Messages</button>
                    <button id="mqtt-tab-schema" class="mqtt-tab-button" data-tab="schema">Schema</button>
                </span>
                <span class="button-group" style="float: right;">
                    <button id="mqtt-expand-toggle" class="red-ui-sidebar-header-button" title="Expand all"><i class="fa fa-expand"></i></button>
                </span>
            </div>
            <div style="flex: 1; overflow: auto;">
                <div id="mqtt-messages-tab" class="mqtt-tab-content" style="display: block;">
                    <ol id="mqtt-message-content" class="red-ui-debug-msg-list"></ol>
                </div>
                <div id="mqtt-schema-tab" class="mqtt-tab-content" style="display: none;">
                    <div id="mqtt-schema-content">
                        Select a topic to view message schema
                    </div>
                </div>
            </div>
        </div>
    </div>
</div>
`

const mqttTreeStyleTemplate = `
<style>
.mqtt-tree-viewer {
    height: 100%;
    display: flex;
    flex-direction: column;
}
.mqtt-tree-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
.mqtt-tree-topics {
    flex: 1;
    min-height: 40%;
}
.mqtt-tree-messages {
    flex: 1;
    min-height: 40%;
    display: flex;
    flex-direction: column;
}
.mqtt-topic-item {
    padding: 4px 8px;
    cursor: pointer;
    border-radius: 3px;
}
.mqtt-topic-item:hover {
    background-color: var(--red-ui-secondary-background-hover);
}
.mqtt-topic-item.selected {
    background-color: var(--red-ui-primary-background);
}
.mqtt-message-badge {
    background: #3FADB5;
    color: white;
    padding: 2px 6px;
    border-radius: 10px;
    font-size: 10px;
    margin-left: 4px;
}
#mqtt-message-content {
    list-style: none;
    padding: 0;
    margin: 0;
}
.mqtt-tab-button {
    background: var(--red-ui-secondary-background);
    color: var(--red-ui-primary-text-color);
    border: 1px solid var(--red-ui-secondary-border-color);
    padding: 4px 12px;
    cursor: pointer;
    font-size: 12px;
    margin-right: 2px;
    border-radius: 3px;
}
.mqtt-tab-button:hover {
    background: var(--red-ui-secondary-background-hover);
}
.mqtt-tab-button.active {
    background: var(--red-ui-primary-background);
    color: white;
    border-color: var(--red-ui-primary-background);
}
.mqtt-tab-content {
    width: 100%;
    height: 100%;
}
</style>
`

function init() {
    // Add styles
    $('head').append(mqttTreeStyleTemplate)
    
    const content = $(mqttTreeContentTemplate)
    
    // Track expand/collapse state
    let isExpanded = true
    
    // Expand/collapse toggle button handler
    content.find('#mqtt-expand-toggle').on('click', function() {
        const button = $(this)
        const activeTab = $('.mqtt-tab-button.active').data('tab')
        const container = activeTab === 'messages' ? '#mqtt-message-content' : '#mqtt-schema-content'
        
        if (isExpanded) {
            // Collapse all
            $(container + ' .red-ui-debug-msg-object-handle').not('.collapsed').each(function() {
                $(this).click()
            })
            button.attr('title', 'Expand all')
            button.find('i').removeClass('fa-compress').addClass('fa-expand')
            isExpanded = false
        } else {
            // Expand all
            $(container + ' .red-ui-debug-msg-object-handle.collapsed').each(function() {
                $(this).click()
            })
            button.attr('title', 'Collapse all')
            button.find('i').removeClass('fa-expand').addClass('fa-compress')
            isExpanded = true
        }
    })
    
    // Filter input handler
    content.find('#mqtt-topic-filter').on('input', function() {
        filterText = $(this).val().toLowerCase()
        renderTopicTree()
    })
    
    // Tab switching handler
    content.find('.mqtt-tab-button').on('click', function() {
        const tab = $(this).data('tab')
        
        // Update button states
        $('.mqtt-tab-button').removeClass('active')
        $(this).addClass('active')
        
        // Show/hide tab content
        $('.mqtt-tab-content').hide()
        if (tab === 'messages') {
            $('#mqtt-messages-tab').show()
        } else if (tab === 'schema') {
            $('#mqtt-schema-tab').show()
        }
    })
    
    // Topic tree data structure
    const topicData = {}
    let selectedTopic = null
    let refreshInterval = null
    const collapsedState = {} // Track collapsed/expanded state
    let filterText = '' // Track filter text

    // Get authentication headers (same pattern as device plugin)
    function getAuthHeaders() {
        const headers = {
            Accept: 'application/json',
            'Content-Type': 'application/json'
        }

        let token = null
        
        // Canonical dashboard token storage
        try {
            token = localStorage.getItem('accessToken')
        } catch (err) {
            console.warn('[MQTT Tree] Failed to get accessToken from localStorage:', err)
        }

        // Fallback set by NodeRedPage bridge
        if (!token) {
            try {
                token = sessionStorage.getItem('auth0_token')
            } catch (err) {
                console.warn('[MQTT Tree] Failed to get auth0_token from sessionStorage:', err)
            }
        }

        if (token && typeof token === 'string') {
            headers.Authorization = `Bearer ${token}`
            console.log('[MQTT Tree] Using Bearer token authentication')
        }
        
        return headers
    }

    // Function to fetch MQTT tree from API
    async function fetchMqttTree() {
        console.log('[MQTT Tree] Fetching dashboard data from API...')
        try {
            // Use /dashboard endpoint to get everything in one call
            const response = await fetch('nr-tools/mqtt-monitor/dashboard', {
                method: 'GET',
                headers: getAuthHeaders()
            })
            console.log('[MQTT Tree] API response status:', response.status)
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`)
            }
            const result = await response.json()
            console.log('[MQTT Tree] API result:', result)
            
            if (!result.success) {
                throw new Error(result.error || 'Failed to fetch dashboard data')
            }
            
            const data = result.data
            console.log('[MQTT Tree] Dashboard data:', data)
            
            // Extract topicTree from dashboard response
            if (data && data.topicTree && typeof data.topicTree === 'object') {
                // Clear existing data
                Object.keys(topicData).forEach(key => delete topicData[key])
                
                // The API returns a nested tree structure in data.topicTree
                Object.assign(topicData, data.topicTree)
                
                console.log('[MQTT Tree] Rendering tree with data:', topicData)
                renderTopicTree()
            }
        } catch (err) {
            console.error('[MQTT Tree] Failed to fetch MQTT dashboard:', err)
            const tree = $('#mqtt-topic-tree')
            tree.html(`<div style="color: #f44336; padding: 20px; text-align: center;">
                <i class="fa fa-exclamation-triangle"></i><br/>
                Failed to load MQTT topics<br/>
                <small>${err.message}</small>
            </div>`)
        }
    }

    // Function to fetch messages for a specific topic
    async function fetchTopicMessages(topic) {
        try {
            // Use nr-tools proxy path (same as device plugin)
            const response = await fetch(`nr-tools/mqtt-monitor/topics/${encodeURIComponent(topic)}/recent-activity?window=15`, {
                method: 'GET',
                headers: getAuthHeaders()
            })
            
            // Handle 404 as "no messages" rather than error
            if (response.status === 404) {
                displayMessages(topic, [])
                return
            }
            
            if (!response.ok) {
                const errorText = await response.text()
                throw new Error(`HTTP ${response.status} - ${errorText}`)
            }
            
            const result = await response.json()
            
            if (!result.success) {
                // If error is "no recent activity", treat as empty
                if (result.error && result.error.toLowerCase().includes('no recent activity')) {
                    displayMessages(topic, [])
                    return
                }
                throw new Error(result.error || 'Failed to fetch messages')
            }
            
            const data = result.data
            
            if (data && data.recentMessages) {
                const messages = data.recentMessages.map(msg => ({
                    timestamp: new Date(msg.timestamp).getTime(),
                    payload: msg.payload
                }))
                displayMessages(topic, messages)
            } else {
                displayMessages(topic, [])
            }
        } catch (err) {
            console.error('Failed to fetch messages for topic:', topic, err)
            const content = $('#mqtt-message-content')
            content.empty().append(
                $('<li>')
                    .attr('style', 'padding: 10px; color: #f44336; font-style: italic;')
                    .html(`<i class="fa fa-exclamation-triangle"></i> Failed to load messages: ${err.message}`)
            )
        }
    }

    // Function to render topic tree
    function renderTopicTree() {
        const tree = $('#mqtt-topic-tree')
        tree.empty()

        if (Object.keys(topicData).length === 0) {
            tree.html('<div style="color: #999; padding: 20px; text-align: center;">Waiting for messages...<br/><small>Loading MQTT topics...</small></div>')
            return
        }

        function buildTree(obj, prefix = '', indent = 0) {
            // Filter out metadata fields that start with underscore
            const sortedKeys = Object.keys(obj).filter(k => !k.startsWith('_')).sort()
            
            sortedKeys.forEach(key => {
                const node = obj[key]
                const fullPath = node._topic || (prefix ? `${prefix}/${key}` : key)
                
                // Filter: check if this topic or any of its children match
                const matchesFilter = !filterText || fullPath.toLowerCase().includes(filterText)
                
                // Check if node has children (non-underscore keys)
                const hasChildren = Object.keys(node).filter(k => !k.startsWith('_')).length > 0
                
                // Check if any children match the filter
                let childMatches = false
                if (hasChildren && filterText) {
                    childMatches = hasChildMatchingFilter(node, fullPath)
                }
                
                // Skip if doesn't match filter and no children match
                if (!matchesFilter && !childMatches) {
                    return
                }
                
                const messageCount = node._messagesCounter || 0
                
                const itemDiv = $('<div>')
                    .addClass('mqtt-topic-item')
                    .attr('style', `padding-left: ${indent * 16}px; cursor: pointer;`)

                if (selectedTopic === fullPath) {
                    itemDiv.addClass('selected')
                }

                // Use chevron icons for folders (like help tab)
                let icon = ''
                if (hasChildren) {
                    // When filtering, expand folders automatically
                    if (filterText && collapsedState[fullPath] !== false) {
                        collapsedState[fullPath] = false
                    }
                    // Initialize collapsed state to false (expanded) on first render
                    if (collapsedState[fullPath] === undefined) {
                        collapsedState[fullPath] = false
                    }
                    const isCollapsed = collapsedState[fullPath]
                    icon = `<i class="fa fa-chevron-${isCollapsed ? 'right' : 'down'}" style="width: 12px; margin-right: 4px;"></i>`
                } else {
                    icon = '<i class="fa fa-circle" style="font-size: 6px; width: 12px; margin-right: 4px; vertical-align: middle;"></i>'
                }
                
                const badge = messageCount > 0 ? `<span class="mqtt-message-badge">${messageCount}</span>` : ''
                
                itemDiv.html(`${icon}<span>${key}${badge}</span>`)
                
                // Handle folder toggle
                if (hasChildren) {
                    itemDiv.find('i.fa-chevron-right, i.fa-chevron-down').on('click', function(e) {
                        e.stopPropagation()
                        collapsedState[fullPath] = !collapsedState[fullPath]
                        renderTopicTree() // Re-render to show/hide children
                    })
                }
                
                itemDiv.find('span').on('click', function(e) {
                    e.stopPropagation()
                    selectedTopic = fullPath
                    $('.mqtt-topic-item').removeClass('selected')
                    itemDiv.addClass('selected')
                    
                    // Show the last message from the tree data
                    if (node._message !== undefined) {
                        const messages = [{
                            timestamp: node._lastModified || node._created || Date.now(),
                            payload: node._message
                        }]
                        displayMessages(fullPath, messages, () => {
                            // Expand all collapsed nodes in messages
                            $('#mqtt-message-content .red-ui-debug-msg-object-handle.collapsed').each(function() {
                                $(this).click()
                            })
                            // Update button state to expanded
                            const button = $('#mqtt-expand-toggle')
                            button.attr('title', 'Collapse all')
                            button.find('i').removeClass('fa-expand').addClass('fa-compress')
                            isExpanded = true
                        })
                        
                        // Also show schema if available
                        if (node._schema) {
                            displaySchema(node._schema, node._messageType, () => {
                                // Expand all collapsed nodes in schema
                                $('#mqtt-schema-content .red-ui-debug-msg-object-handle.collapsed').each(function() {
                                    $(this).click()
                                })
                            })
                        }
                    } else {
                        displayMessages(fullPath, [])
                    }
                })

                tree.append(itemDiv)

                // Only show children if not collapsed
                if (hasChildren && !collapsedState[fullPath]) {
                    buildTree(node, fullPath, indent + 1)
                }
            })
        }
        
        // Helper function to check if any child matches filter
        function hasChildMatchingFilter(node, prefix) {
            const keys = Object.keys(node).filter(k => !k.startsWith('_'))
            for (const key of keys) {
                const childNode = node[key]
                const childPath = childNode._topic || `${prefix}/${key}`
                if (childPath.toLowerCase().includes(filterText)) {
                    return true
                }
                // Check recursively
                const hasChildren = Object.keys(childNode).filter(k => !k.startsWith('_')).length > 0
                if (hasChildren && hasChildMatchingFilter(childNode, childPath)) {
                    return true
                }
            }
            return false
        }

        buildTree(topicData)
    }

    // Function to display messages in debug panel style
    function displayMessages(topic, messages, callback) {
        const content = $('#mqtt-message-content')
        content.empty()
        
        if (messages.length === 0) {
            const emptyMsg = $('<li class="red-ui-debug-msg">')
                .attr('style', 'padding: 10px; color: #999; font-style: italic;')
                .text(`No messages received on topic: ${topic}`)
            content.append(emptyMsg)
            
            // Clear schema tab too
            $('#mqtt-schema-content').html('<div style="color: #999; padding: 20px; text-align: center;">No messages to analyze</div>')
            
            // Execute callback even with no messages
            if (callback) {
                requestAnimationFrame(() => callback())
            }
            return
        }

        // Display messages in reverse order (newest first, like debug panel)
        messages.slice().reverse().forEach((msg, idx) => {
            const msgItem = $('<li class="red-ui-debug-msg">')
            
            // Message header (timestamp + topic)
            const msgHeader = $('<div class="red-ui-debug-msg-date">')
                .attr('style', 'font-size: 10px; color: #999; margin-bottom: 4px;')
            const timestamp = new Date(msg.timestamp).toLocaleTimeString()
            msgHeader.text(`${timestamp} : ${topic}`)
            
            // Message payload container
            const msgPayload = $('<div class="red-ui-debug-msg-payload">')
            
            // Try to parse and format as JSON
            let payload = msg.payload
            try {
                if (typeof payload === 'string') {
                    payload = JSON.parse(payload)
                }
                
                // Use RED.utils.createObjectElement for proper formatting
                const formatted = RED.utils.createObjectElement(payload, {
                    sourceId: 'mqtt-tree-' + idx,
                    path: 'payload'
                })
                msgPayload.append(formatted)
            } catch (e) {
                // Not JSON, display as string
                const stringElem = $('<span class="red-ui-debug-msg-type-string">').text('"' + payload + '"')
                msgPayload.append(stringElem)
            }
            
            msgItem.append(msgHeader)
            msgItem.append(msgPayload)
            content.append(msgItem)
        })
        
        // Generate schema from messages
        generateSchema(topic, messages)
        
        // Execute callback after DOM operations complete
        if (callback) {
            requestAnimationFrame(() => callback())
        }
    }
    
    // Function to display schema in debug panel style
    function displaySchema(schema, messageType, callback) {
        const schemaContainer = $('#mqtt-schema-content')
        schemaContainer.empty()
        
        if (!schema) {
            schemaContainer.html('<div style="color: #999; padding: 20px; text-align: center;">No schema available</div>')
            
            // Execute callback even with no schema
            if (callback) {
                requestAnimationFrame(() => callback())
            }
            return
        }
        
        try {
            // Create a debug-style list
            const schemaList = $('<ol class="red-ui-debug-msg-payload">').css({
                'list-style': 'none',
                'padding': '0',
                'margin': '0'
            })
            
            const schemaItem = $('<li class="red-ui-debug-msg">')
            
            // Schema header with type badge
            const schemaHeader = $('<div class="red-ui-debug-msg-date">')
                .attr('style', 'font-size: 10px; color: #999; margin-bottom: 4px;')
            schemaHeader.html(`Schema <span style="background: #4CAF50; color: white; padding: 2px 6px; border-radius: 3px; font-size: 9px; margin-left: 4px;">${messageType || 'json'}</span>`)
            
            // Schema content using createObjectElement (without extra padding since it has its own)
            const schemaPayload = $('<div class="red-ui-debug-msg-element">')
            
            const formatted = RED.utils.createObjectElement(schema, {
                sourceId: 'mqtt-schema',
                path: 'schema'
            })
            schemaPayload.append(formatted)
            
            schemaItem.append(schemaHeader)
            schemaItem.append(schemaPayload)
            schemaList.append(schemaItem)
            schemaContainer.append(schemaList)
            
            // Execute callback after DOM operations complete
            if (callback) {
                requestAnimationFrame(() => callback())
            }
        } catch (err) {
            console.error('[MQTT Tree] Schema display error:', err)
            schemaContainer.html(`<div style="color: #f44336; padding: 20px; text-align: center;">Failed to display schema: ${err.message}</div>`)
            
            // Execute callback even on error
            if (callback) {
                requestAnimationFrame(() => callback())
            }
        }
    }
    
    // Function to generate and display schema from messages
    function generateSchema(topic, messages) {
        const schemaContainer = $('#mqtt-schema-content')
        schemaContainer.empty()
        
        if (messages.length === 0) {
            schemaContainer.html('<div style="color: #999; padding: 20px; text-align: center;">No messages to analyze</div>')
            return
        }
        
        try {
            // Parse all messages and analyze structure
            const parsedMessages = messages.map(msg => {
                try {
                    if (typeof msg.payload === 'string') {
                        return JSON.parse(msg.payload)
                    }
                    return msg.payload
                } catch (e) {
                    return null
                }
            }).filter(m => m !== null)
            
            if (parsedMessages.length === 0) {
                schemaContainer.html('<div style="color: #999; padding: 20px; text-align: center;">Messages are not JSON format</div>')
                return
            }
            
            // Infer schema from messages
            const schema = inferSchema(parsedMessages)
            
            // Display schema
            const schemaHeader = $('<div>').attr('style', 'padding: 8px; font-weight: bold; border-bottom: 1px solid var(--red-ui-secondary-border-color);')
            schemaHeader.text('Inferred Schema')
         
            const schemaContent = $('<pre>').attr('style', 'padding: 12px; margin: 0; overflow: auto; background: var(--red-ui-secondary-background);')
            schemaContent.text(JSON.stringify(schema, null, 2))
            
            schemaContainer.append(schemaHeader)
            schemaContainer.append(schemaContent)
        } catch (err) {
            console.error('[MQTT Tree] Schema generation error:', err)
            schemaContainer.html(`<div style="color: #f44336; padding: 20px; text-align: center;">Failed to generate schema: ${err.message}</div>`)
        }
    }
    
    // Function to infer schema from array of objects
    function inferSchema(objects) {
        const schema = {}
        
        objects.forEach(obj => {
            if (typeof obj !== 'object' || obj === null) return
            
            Object.keys(obj).forEach(key => {
                const value = obj[key]
                const type = Array.isArray(value) ? 'array' : typeof value
                
                if (!schema[key]) {
                    schema[key] = {
                        type: type,
                        required: true,
                        examples: []
                    }
                }
                
                // Track if field is always present
                if (schema[key].required && !obj.hasOwnProperty(key)) {
                    schema[key].required = false
                }
                
                // Collect example values (up to 3 unique)
                if (schema[key].examples.length < 3 && !schema[key].examples.includes(value)) {
                    schema[key].examples.push(value)
                }
                
                // For arrays, analyze element types
                if (type === 'array' && value.length > 0) {
                    const elementTypes = [...new Set(value.map(v => typeof v))]
                    schema[key].elementType = elementTypes.length === 1 ? elementTypes[0] : 'mixed'
                }
                
                // For objects, recurse
                if (type === 'object' && !schema[key].properties) {
                    schema[key].properties = inferSchema([value])
                }
            })
        })
        
        return schema
    }

    // Start auto-refresh
    function startAutoRefresh() {
        console.log('[MQTT Tree] Starting auto-refresh...')
        // Initial fetch
        fetchMqttTree()
        
        // Refresh every 5 seconds
        refreshInterval = setInterval(() => {
            console.log('[MQTT Tree] Auto-refresh tick')
            fetchMqttTree()
        }, 5000)
    }

    function stopAutoRefresh() {
        console.log('[MQTT Tree] Stopping auto-refresh...')
        if (refreshInterval) {
            clearInterval(refreshInterval)
            refreshInterval = null
        }
    }

    console.log('[MQTT Tree] Initializing content...')
    
    // Return content and control functions for parent sidebar to use
    return {
        content: content,
        onshow: function() {
            console.log('[MQTT Tree] Content shown, starting refresh')
            startAutoRefresh()
        },
        onhide: function() {
            console.log('[MQTT Tree] Content hidden, stopping refresh')
            stopAutoRefresh()
        }
    }
}

// Store the result for external access
let mqttTreeInstance = null

function initialize() {
    mqttTreeInstance = init()
    return mqttTreeInstance
}

export {
    initialize,
    init
}
