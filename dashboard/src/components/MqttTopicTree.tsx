import { useState, useEffect } from "react";
import { ChevronRight, ChevronDown, Circle } from "lucide-react";
import { Badge } from "./ui/badge";
import { cn } from "./ui/utils";

interface MqttTopic {
  name: string;
  messageCount: number;
  lastMessage?: string;
  children?: MqttTopic[];
}

interface TopicNodeProps {
  topic: MqttTopic;
  level?: number;
  onTopicSelect?: (topic: string, message: string) => void;
  fullPath?: string;
  selectedTopic?: string;
}

const TopicNode = ({ topic, level = 0, onTopicSelect, fullPath = '', selectedTopic }: TopicNodeProps) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const hasChildren = topic.children && topic.children.length > 0;
  const currentPath = fullPath ? `${fullPath}/${topic.name}` : topic.name;
  const isSelected = currentPath === selectedTopic;

  // Reset expansion state when topic name changes (e.g., device UUID changes)
  useEffect(() => {
    setIsExpanded(true);
  }, [topic.name, level]);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent triggering selection
    setIsExpanded(!isExpanded);
  };

  const handleClick = () => {
    // Select topic if it has a message (leaf node)
    if (onTopicSelect && topic.lastMessage) {
      onTopicSelect(currentPath, topic.lastMessage);
      console.log('[TopicNode] Selected topic:', currentPath, 'has message:', !!topic.lastMessage);
    } else {
      console.log('[TopicNode] Clicked topic:', currentPath, 'but no message available. Has children:', hasChildren);
    }
  };

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-2 py-2 px-2 rounded cursor-pointer group",
          "hover:bg-muted"
        )}
        style={{ marginLeft: `${level * 24}px` }}
        onClick={handleClick}
      >
        {hasChildren ? (
          <div onClick={handleToggle} className="cursor-pointer">
            {isExpanded ? (
              <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            ) : (
              <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            )}
          </div>
        ) : (
          <Circle className="w-2 h-2 text-muted-foreground/50 ml-1 flex-shrink-0" />
        )}
        
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn(
              "font-mono text-sm truncate text-foreground",
              isSelected && "underline decoration-2 decoration-blue-500 font-semibold",
              !isSelected && hasChildren && "font-medium"
            )}>
              {topic.name}
            </span>
            {topic.messageCount > 0 && (
              <Badge variant="outline" className="text-xs bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800">
                {topic.messageCount}
              </Badge>
            )}
          </div>
        </div>
      </div>

      {hasChildren && isExpanded && (
        <div>
          {topic.children!.map((child, index) => (
            <TopicNode 
              key={`${child.name}-${index}`} 
              topic={child} 
              level={level + 1}
              onTopicSelect={onTopicSelect}
              fullPath={currentPath}
              selectedTopic={selectedTopic}
            />
          ))}
        </div>
      )}
    </div>
  );
};

interface MqttTopicTreeProps {
  topics: MqttTopic[];
  loading: boolean;
  searchQuery: string;
  selectedTopic: string;
  onTopicSelect: (topic: string, message: string) => void;
}

export function MqttTopicTree({ 
  topics, 
  loading, 
  searchQuery, 
  selectedTopic, 
  onTopicSelect 
}: MqttTopicTreeProps) {
  return (
    <div 
      className="bg-card rounded-lg p-4 overflow-auto border border-border" 
      style={{ 
        height: '600px',
        scrollbarWidth: 'thin',
        scrollbarColor: 'hsl(var(--muted-foreground)) hsl(var(--muted))'
      }}
    >
      {loading ? (
        <div className="text-center py-8 text-muted-foreground">Loading topics...</div>
      ) : topics.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          {searchQuery ? `No topics matching "${searchQuery}"` : 'No topics found for this device'}
        </div>
      ) : (
        topics.map((topic, index) => (
          <TopicNode 
            key={`${topic.name}-${index}`} 
            topic={topic} 
            onTopicSelect={onTopicSelect}
            selectedTopic={selectedTopic}
          />
        ))
      )}
    </div>
  );
}
