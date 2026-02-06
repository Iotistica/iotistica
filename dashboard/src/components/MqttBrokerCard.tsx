import { useState, useMemo, useEffect } from "react";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import { Activity } from "lucide-react";
import { cn } from "./ui/utils";
import { MqttTopicTree } from "./MqttTopicTree";
import { MqttMessageViewer } from "./MqttMessageViewer";

interface MqttTopic {
  name: string;
  messageCount: number;
  lastMessage?: string;
  children?: MqttTopic[];
}

interface MqttBrokerCardProps {
  deviceId: string;
  topics: any[];
  isConnected: boolean;
}

// Build hierarchical tree from flat topic list
const buildTopicTree = (flatTopics: any[]): MqttTopic[] => {
  const root: { [key: string]: any } = {};

  flatTopics.forEach(({ topic, messageCount, lastMessage }) => {
    const parts = topic.split('/');
    let current = root;

    parts.forEach((part: string, index: number) => {
      if (!current[part]) {
        current[part] = {
          name: part,
          messageCount: 0,
          lastMessage: undefined,
          children: {},
        };
      }

      // If this is the last part, set the message details for this exact topic
      if (index === parts.length - 1) {
        current[part].messageCount = parseInt(messageCount, 10) || 0;
        current[part].lastMessage = lastMessage;
      }

      current = current[part].children;
    });
  });

  // Convert nested object to array format
  const convertToArray = (obj: any): MqttTopic[] => {
    return Object.values(obj).map((node: any) => {
      const children = node.children && Object.keys(node.children).length > 0
        ? convertToArray(node.children)
        : undefined;

      return {
        name: node.name,
        messageCount: node.messageCount || 0,
        lastMessage: node.lastMessage,
        children,
      };
    });
  };

  return convertToArray(root);
};

const MqttBrokerCard = ({ deviceId, topics: allTopics, isConnected }: MqttBrokerCardProps) => {
  const [topics, setTopics] = useState<MqttTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalMessages, setTotalMessages] = useState(0);
  const [activeTopics, setActiveTopics] = useState(0);
  const [selectedTopic, setSelectedTopic] = useState<string>('');
  const [selectedMessage, setSelectedMessage] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Process topics from props (pushed via WebSocket)
  useEffect(() => {
    if (!allTopics || allTopics.length === 0) {
      setTopics([]);
      setTotalMessages(0);
      setActiveTopics(0);
      setLoading(false);
      return;
    }

    console.log(`[MqttBrokerCard] Processing ${allTopics.length} topics`);

    // Use the data directly from WebSocket (messageCount is already there)
    // Note: Topics are already filtered by parent component (MqttPage)
    const topicsForTree = allTopics.map((t: any) => ({
      topic: t.topic,
      messageCount: parseInt(t.messageCount, 10) || 0,
      lastMessage: t.lastMessage
    }));

    // Build hierarchical tree
    const tree = buildTopicTree(topicsForTree);
    setTopics(tree);
    
    // Calculate stats from filtered topics
    const total = allTopics.reduce((sum: number, t: any) => sum + (parseInt(t.messageCount, 10) || 0), 0);
    const active = allTopics.filter((t: any) => (parseInt(t.messageCount, 10) || 0) > 0).length;
    setTotalMessages(total);
    setActiveTopics(active);
    setLoading(false);
  }, [allTopics]);

  // Handle topic selection
  const handleTopicSelect = (topic: string, message: string) => {
    setSelectedTopic(topic);
    setSelectedMessage(message);
  };

  // Auto-select first topic with a message when topics load or change
  useEffect(() => {
    if (topics.length === 0) {
      setSelectedTopic('');
      setSelectedMessage('');
      return;
    }

    // Find first topic with a message (recursively)
    const findFirstTopicWithMessage = (topics: MqttTopic[], path: string = ''): { topic: string; message: string } | null => {
      for (const topic of topics) {
        const currentPath = path ? `${path}/${topic.name}` : topic.name;
        
        // If this topic has a message, select it
        if (topic.lastMessage) {
          return { topic: currentPath, message: topic.lastMessage };
        }
        
        // Otherwise check children
        if (topic.children && topic.children.length > 0) {
          const found = findFirstTopicWithMessage(topic.children, currentPath);
          if (found) return found;
        }
      }
      return null;
    };

    const firstTopic = findFirstTopicWithMessage(topics);
    if (firstTopic && !selectedTopic) {
      setSelectedTopic(firstTopic.topic);
      setSelectedMessage(firstTopic.message);
    }
  }, [topics, deviceId, selectedTopic]);

  // Filter topics based on search query
  const filterTopics = (topics: MqttTopic[], query: string): MqttTopic[] => {
    if (!query.trim()) return topics;
    
    const lowerQuery = query.toLowerCase();
    
    return topics.filter(topic => {
      // Check if current topic name matches
      const nameMatches = topic.name.toLowerCase().includes(lowerQuery);
      
      // Check if any children match (recursively)
      const hasMatchingChildren = topic.children && topic.children.length > 0 
        ? filterTopics(topic.children, query).length > 0
        : false;
      
      // Include topic if it matches or has matching children
      if (nameMatches || hasMatchingChildren) {
        // If topic has children, filter them too
        if (topic.children && topic.children.length > 0) {
          return {
            ...topic,
            children: filterTopics(topic.children, query)
          };
        }
        return true;
      }
      
      return false;
    }).map(topic => {
      // Apply filter to children
      if (topic.children && topic.children.length > 0) {
        return {
          ...topic,
          children: filterTopics(topic.children, query)
        };
      }
      return topic;
    });
  };

  const filteredTopics = useMemo(() => {
    return filterTopics(topics, searchQuery);
  }, [topics, searchQuery]);

  return (
    <Card className="p-4 md:p-6">
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg text-foreground font-medium mb-1">MQTT Explorer</h3>
          <div className="flex items-center gap-2">
            <Activity className={cn(
              "w-4 h-4",
              isConnected ? "text-green-500 animate-pulse" : "text-muted-foreground"
            )} />
            <Badge variant="outline" className={cn(
              "text-xs",
              isConnected 
                ? "bg-green-50 text-green-700 border-green-200" 
                : "bg-muted text-muted-foreground border-border"
            )}>
              {isConnected ? "Connected" : "Disconnected"}
            </Badge>
          </div>
        </div>
        <p className="text-muted-foreground">Topic hierarchy and message counts</p>
      </div>

      {/* Stats */}
      <div className="mb-4">
        <div className="grid grid-cols-2 gap-4 p-3 bg-muted rounded-lg">
          <div>
            <p className="text-xs text-muted-foreground mb-1">Messages</p>
            <p className="text-lg font-semibold text-foreground">
              {loading ? '...' : totalMessages.toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Active Topics</p>
            <p className="text-lg font-semibold text-foreground">
              {loading ? '...' : activeTopics}
            </p>
          </div>
        </div>
      </div>


      {/* Search Filter */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-muted-foreground mb-2">
          Search Topics
        </label>
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by topic name..."
            className="w-full px-3 py-2 pr-10 border border-border rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-background text-foreground placeholder:text-muted-foreground"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none"
              title="Clear search"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
        </div>
        {searchQuery && (
          <p className="mt-1 text-xs text-muted-foreground">
            Filtering topics containing: "{searchQuery}"
          </p>
        )}
      </div>

      {/* Topic Tree and JSON Viewer - Split View */}
      <div className={cn(
        "grid grid-cols-1 gap-4",
        selectedTopic && "md:grid-cols-2" // Only show 2-column layout when topic is selected
      )}>
        {/* Topic Tree */}
        <MqttTopicTree 
          topics={filteredTopics}
          loading={loading}
          searchQuery={searchQuery}
          selectedTopic={selectedTopic}
          onTopicSelect={handleTopicSelect}
        />

        {/* JSON Message Viewer - Only render when a topic is selected */}
        {selectedTopic && (
          <MqttMessageViewer 
            selectedTopic={selectedTopic}
            selectedMessage={selectedMessage}
          />
        )}
      </div>
    </Card>
  );
};

export default MqttBrokerCard;
