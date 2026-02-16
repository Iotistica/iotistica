import { useState, useEffect } from 'react';
import { Tag, Plus, X, Check, Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';
import {
  getDeviceTags,
  setDeviceTag,
  deleteDeviceTag,
  getTagKeys,
  getTagValues,
  type TagKey,
  type TagValue
} from '@/services/deviceTags';

interface Props {
  deviceUuid: string;
}

export default function DeviceTagsPage({ deviceUuid }: Props) {
  const [tags, setTags] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Add tag form state
  const [isAdding, setIsAdding] = useState(false);
  const [newTagKey, setNewTagKey] = useState('');
  const [newTagValue, setNewTagValue] = useState('');
  
  // Autocomplete state
  const [suggestedKeys, setSuggestedKeys] = useState<TagKey[]>([]);
  const [suggestedValues, setSuggestedValues] = useState<TagValue[]>([]);
  const [showKeySuggestions, setShowKeySuggestions] = useState(false);
  const [showValueSuggestions, setShowValueSuggestions] = useState(false);

  useEffect(() => {
    if (deviceUuid) {
      loadTags();
      loadTagKeys();
    }
  }, [deviceUuid]);

  // Listen for tag updates from other components (e.g., AddEditDeviceDialog)
  useEffect(() => {
    const handleTagsUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<{ deviceUuid: string }>;
      if (customEvent.detail.deviceUuid === deviceUuid) {
        console.log('[DeviceTagsPage] Tags updated externally, reloading...');
        loadTags();
      }
    };

    window.addEventListener('device-tags-updated', handleTagsUpdated);
    return () => window.removeEventListener('device-tags-updated', handleTagsUpdated);
  }, [deviceUuid]);

  useEffect(() => {
    if (newTagKey && newTagKey.length > 0) {
      loadTagValues(newTagKey);
    }
  }, [newTagKey]);

  const loadTags = async () => {
    setLoading(true);
    setError(null);
    try {
      const deviceTags = await getDeviceTags(deviceUuid);
      setTags(deviceTags);
    } catch (err: any) {
      console.error('Error loading tags:', err);
      setError(err.message || 'Failed to load device tags');
    } finally {
      setLoading(false);
    }
  };

  const loadTagKeys = async () => {
    try {
      const keys = await getTagKeys();
      setSuggestedKeys(keys);
    } catch (err) {
      console.error('Error loading tag keys:', err);
    }
  };

  const loadTagValues = async (key: string) => {
    try {
      const values = await getTagValues(key);
      setSuggestedValues(values);
    } catch (err) {
      console.error('Error loading tag values:', err);
      setSuggestedValues([]);
    }
  };

  const handleAddTag = async () => {
    if (!newTagKey.trim() || !newTagValue.trim()) {
      toast.error('Both key and value are required');
      return;
    }

    // Validate key format (lowercase alphanumeric with dashes/underscores)
    const keyRegex = /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/;
    if (!keyRegex.test(newTagKey)) {
      toast.error('Tag key must be lowercase alphanumeric with dashes/underscores (e.g., environment, aws-region)');
      return;
    }

    setSaving(true);
    try {
      await setDeviceTag(deviceUuid, newTagKey.toLowerCase(), newTagValue);
      
      // Update local state
      setTags(prev => ({ ...prev, [newTagKey.toLowerCase()]: newTagValue }));
      
      // Reset form
      setNewTagKey('');
      setNewTagValue('');
      setIsAdding(false);
      
      toast.success('Tag added successfully');
    } catch (err: any) {
      console.error('Error adding tag:', err);
      toast.error(err.message || 'Failed to add tag');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteTag = async (key: string) => {
    setSaving(true);
    try {
      await deleteDeviceTag(deviceUuid, key);
      
      // Update local state
      setTags(prev => {
        const newTags = { ...prev };
        delete newTags[key];
        return newTags;
      });
      
      toast.success('Tag deleted successfully');
    } catch (err: any) {
      console.error('Error deleting tag:', err);
      toast.error(err.message || 'Failed to delete tag');
    } finally {
      setSaving(false);
    }
  };

  const filteredKeySuggestions = suggestedKeys.filter(
    k => k.key.toLowerCase().includes(newTagKey.toLowerCase()) && !tags[k.key]
  );

  const filteredValueSuggestions = suggestedValues.filter(
    v => v.value.toLowerCase().includes(newTagValue.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex-1 bg-background overflow-auto p-6">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-background overflow-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
              <Tag className="w-8 h-8" />
              Device Tags
            </h1>
            <p className="text-muted-foreground mt-1">
              Organize and categorize this device using key-value tags
            </p>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Current Tags</CardTitle>
            <CardDescription>
              Tags help you organize devices and enable bulk operations
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Display existing tags */}
            {Object.keys(tags).length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {Object.entries(tags).map(([key, value]) => (
                  <Badge
                    key={key}
                    variant="secondary"
                    className="px-3 py-1.5 text-sm flex items-center gap-2 group hover:bg-secondary/80"
                  >
                    <span className="font-medium text-muted-foreground">{key}:</span>
                    <span className="text-foreground">{value}</span>
                    <button
                      onClick={() => handleDeleteTag(key)}
                      disabled={saving}
                      className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity hover:text-destructive"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <Tag className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p>No tags yet. Add your first tag below.</p>
              </div>
            )}

            {/* Add tag form */}
            {!isAdding ? (
              <Button
                onClick={() => setIsAdding(true)}
                variant="outline"
                size="sm"
                className="w-full"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Tag
              </Button>
            ) : (
              <Card className="p-4 border-2 border-blue-200 bg-blue-50/50 dark:bg-blue-950/20">
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    {/* Tag Key Input */}
                    <div className="relative">
                      <label className="text-sm font-medium text-foreground block mb-1">
                        Key
                      </label>
                      <Input
                        placeholder="e.g., environment"
                        value={newTagKey}
                        onChange={(e) => {
                          setNewTagKey(e.target.value.toLowerCase());
                          setShowKeySuggestions(true);
                        }}
                        onFocus={() => setShowKeySuggestions(true)}
                        onBlur={() => setTimeout(() => setShowKeySuggestions(false), 200)}
                        disabled={saving}
                        autoFocus
                      />
                      {/* Key suggestions dropdown */}
                      {showKeySuggestions && filteredKeySuggestions.length > 0 && (
                        <div className="absolute z-10 w-full mt-1 bg-popover border border-border rounded-md shadow-lg max-h-48 overflow-auto">
                          {filteredKeySuggestions.map((suggestion) => (
                            <button
                              key={suggestion.key}
                              className="w-full px-3 py-2 text-left hover:bg-accent transition-colors flex items-center justify-between"
                              onClick={() => {
                                setNewTagKey(suggestion.key);
                                setShowKeySuggestions(false);
                              }}
                            >
                              <span className="text-sm">{suggestion.key}</span>
                              <Badge variant="secondary" className="text-xs">
                                {suggestion.deviceCount}
                              </Badge>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Tag Value Input */}
                    <div className="relative">
                      <label className="text-sm font-medium text-foreground block mb-1">
                        Value
                      </label>
                      <Input
                        placeholder="e.g., production"
                        value={newTagValue}
                        onChange={(e) => {
                          setNewTagValue(e.target.value);
                          setShowValueSuggestions(true);
                        }}
                        onFocus={() => setShowValueSuggestions(true)}
                        onBlur={() => setTimeout(() => setShowValueSuggestions(false), 200)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            handleAddTag();
                          }
                        }}
                        disabled={saving}
                      />
                      {/* Value suggestions dropdown */}
                      {showValueSuggestions && filteredValueSuggestions.length > 0 && newTagKey && (
                        <div className="absolute z-10 w-full mt-1 bg-popover border border-border rounded-md shadow-lg max-h-48 overflow-auto">
                          {filteredValueSuggestions.map((suggestion) => (
                            <button
                              key={suggestion.value}
                              className="w-full px-3 py-2 text-left hover:bg-accent transition-colors flex items-center justify-between"
                              onClick={() => {
                                setNewTagValue(suggestion.value);
                                setShowValueSuggestions(false);
                              }}
                            >
                              <span className="text-sm">{suggestion.value}</span>
                              <Badge variant="secondary" className="text-xs">
                                {suggestion.deviceCount}
                              </Badge>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      onClick={handleAddTag}
                      size="sm"
                      disabled={saving || !newTagKey.trim() || !newTagValue.trim()}
                      className="flex-1"
                    >
                      {saving ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Check className="w-4 h-4 mr-2" />
                      )}
                      Add Tag
                    </Button>
                    <Button
                      onClick={() => {
                        setIsAdding(false);
                        setNewTagKey('');
                        setNewTagValue('');
                      }}
                      variant="outline"
                      size="sm"
                      disabled={saving}
                    >
                      Cancel
                    </Button>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Keys must be lowercase alphanumeric (e.g., environment, aws-region, hardware-type)
                  </p>
                </div>
              </Card>
            )}
          </CardContent>
        </Card>

        {/* Common Tag Examples */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Common Tag Examples</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <h4 className="font-medium text-sm mb-2 text-foreground">Environment</h4>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">development</Badge>
                  <Badge variant="outline">staging</Badge>
                  <Badge variant="outline">production</Badge>
                </div>
              </div>
              <div>
                <h4 className="font-medium text-sm mb-2 text-foreground">Location</h4>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">us-east-1</Badge>
                  <Badge variant="outline">eu-west-1</Badge>
                  <Badge variant="outline">factory-floor-a</Badge>
                </div>
              </div>
              <div>
                <h4 className="font-medium text-sm mb-2 text-foreground">Hardware</h4>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">pi4</Badge>
                  <Badge variant="outline">pi5</Badge>
                  <Badge variant="outline">x86</Badge>
                </div>
              </div>
              <div>
                <h4 className="font-medium text-sm mb-2 text-foreground">Role</h4>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">gateway</Badge>
                  <Badge variant="outline">sensor</Badge>
                  <Badge variant="outline">edge-processor</Badge>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
