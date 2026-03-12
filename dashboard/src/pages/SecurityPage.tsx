/**
 * Security Page - Security Management
 * 
 * Provides interface to:
 * - Manage MQTT users and ACLs
 * - Manage API keys
 */

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { 
  Dialog, 
  DialogContent, 
  DialogDescription, 
  DialogFooter, 
  DialogHeader, 
  DialogTitle 
} from "@/components/ui/dialog";
import { 
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  Shield, 
  UserPlus, 
  Trash2, 
  Edit, 
  Plus,
  Lock,
  Unlock,
  Key,
  Copy,
  Eye,
  EyeOff
} from "lucide-react";
import { buildApiUrl } from "@/config/api";
import { toast } from "sonner";
import {
  createMqttAcl,
  createMqttUser,
  deleteMqttAcl,
  deleteMqttUser,
  listMqttUsers,
  updateMqttAcl,
  updateMqttUser,
  type MqttAcl,
  type MqttUser,
} from "@/services/mqttSecurity";

interface ApiKey {
  id: number;
  name: string;
  key_prefix: string;
  key: string;
  description?: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  is_active: boolean;
}

export function SecurityPage() {
  const [activeTab, setActiveTab] = useState('mqtt');

  // MQTT Users state
  const [mqttUsers, setMqttUsers] = useState<MqttUser[]>([]);
  const [loadingMqtt, setLoadingMqtt] = useState(true);
  
  // API Keys state
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loadingApiKeys, setLoadingApiKeys] = useState(true);
  const [showApiKey, setShowApiKey] = useState<{[key: number]: boolean}>({});
  const [apiKeyDialogOpen, setApiKeyDialogOpen] = useState(false);
  const [apiKeyFormData, setApiKeyFormData] = useState({
    name: '',
    description: '',
    expiry_period: '90d'
  });
  
  // User dialog state
  const [userDialogOpen, setUserDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<MqttUser | null>(null);
  const [userFormData, setUserFormData] = useState({
    username: '',
    password: '',
    is_superuser: false,
    is_active: true
  });
  
  // ACL dialog state
  const [aclDialogOpen, setAclDialogOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [editingAcl, setEditingAcl] = useState<MqttAcl | null>(null);
  const [aclFormData, setAclFormData] = useState({
    topic: '',
    access: 1,
    priority: 0
  });
  
  // Delete confirmation
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'user' | 'acl', id: number } | null>(null);

  useEffect(() => {
    fetchMqttUsers();
    fetchApiKeys();
  }, []);

  const fetchMqttUsers = async () => {
    try {
      const users = await listMqttUsers();
      setMqttUsers(users);
    } catch (error) {
      console.error('Failed to fetch MQTT users:', error);
      toast.error(error instanceof Error ? error.message : "Network error while fetching users");
    } finally {
      setLoadingMqtt(false);
    }
  };

  const fetchApiKeys = async () => {
    try {
      const response = await fetch(buildApiUrl('/api/v1/auth/api-keys'), {
        credentials: 'include'
      });

      if (response.ok) {
        const data = await response.json();
        setApiKeys(data.keys || []);
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error(data.message || 'Failed to fetch API keys');
      }
    } catch (error) {
      console.error('Failed to fetch API keys:', error);
      toast.error('Network error while fetching API keys');
    } finally {
      setLoadingApiKeys(false);
    }
  };

  const resolveApiKeyExpiry = (period: string): string | null => {
    const daysByPeriod: Record<string, number> = {
      '30d': 30,
      '90d': 90,
      '180d': 180,
      '365d': 365,
    };

    if (period === 'never') {
      return null;
    }

    const days = daysByPeriod[period];
    if (!days) {
      return null;
    }

    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  };

  const handleOpenApiKeyDialog = () => {
    setApiKeyFormData({ name: '', description: '', expiry_period: '90d' });
    setApiKeyDialogOpen(true);
  };

  const handleGenerateApiKey = async () => {
    try {
      if (!apiKeyFormData.name.trim()) {
        toast.error('Name is required');
        return;
      }

      const response = await fetch(buildApiUrl('/api/v1/auth/api-keys'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: apiKeyFormData.name.trim(),
          description: apiKeyFormData.description.trim() || null,
          expires_at: resolveApiKeyExpiry(apiKeyFormData.expiry_period),
        })
      });

      if (response.ok) {
        const data = await response.json();
        toast.success('API key generated successfully');
        setApiKeyDialogOpen(false);
        setApiKeys((prev) => [data.key, ...prev]);
        setShowApiKey((prev) => ({ ...prev, [data.key.id]: true }));
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error(data.message || 'Failed to generate API key');
      }
    } catch (error) {
      console.error('Generate API key error:', error);
      toast.error('Network error while generating API key');
    }
  };

  const handleRevokeApiKey = async (id: number) => {
    try {
      const response = await fetch(buildApiUrl(`/api/v1/auth/api-keys/${id}`), {
        method: 'DELETE',
        credentials: 'include'
      });

      if (response.ok) {
        toast.success('API key revoked successfully');
        setApiKeys((prev) => prev.map((key) =>
          key.id === id ? { ...key, is_active: false } : key
        ));
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error(data.message || 'Failed to revoke API key');
      }
    } catch (error) {
      console.error('Revoke API key error:', error);
      toast.error('Network error while revoking API key');
    }
  };

  const handleAddUser = () => {
    setEditingUser(null);
    setUserFormData({
      username: '',
      password: '',
      is_superuser: false,
      is_active: true
    });
    setUserDialogOpen(true);
  };

  const handleEditUser = (user: MqttUser) => {
    setEditingUser(user);
    setUserFormData({
      username: user.username,
      password: '', // Don't show existing password
      is_superuser: user.is_superuser,
      is_active: user.is_active
    });
    setUserDialogOpen(true);
  };

  const handleSaveUser = async () => {
    try {
      const body: any = {
        is_superuser: userFormData.is_superuser,
        is_active: userFormData.is_active
      };
      
      if (!editingUser) {
        body.username = userFormData.username;
        body.password = userFormData.password;
      } else if (userFormData.password) {
        // Only include password if it was changed
        body.password = userFormData.password;
      }

      if (editingUser) {
        await updateMqttUser(editingUser.id, body);
      } else {
        await createMqttUser(body);
      }

      toast.success(`MQTT user ${editingUser ? 'updated' : 'created'} successfully`);
      setUserDialogOpen(false);
      fetchMqttUsers();
    } catch (error) {
      console.error('Save user error:', error);
      toast.error(error instanceof Error ? error.message : "Network error while saving user");
    }
  };

  const handleDeleteUser = async () => {
    if (!deleteTarget || deleteTarget.type !== 'user') return;
    
    try {
      await deleteMqttUser(deleteTarget.id);
      toast.success("MQTT user deleted successfully");
      fetchMqttUsers();
    } catch (error) {
      console.error('Delete user error:', error);
      toast.error(error instanceof Error ? error.message : "Network error while deleting user");
    } finally {
      setDeleteDialogOpen(false);
      setDeleteTarget(null);
    }
  };

  const handleAddAcl = (userId: number) => {
    setSelectedUserId(userId);
    setEditingAcl(null);
    setAclFormData({
      topic: '',
      access: 1,
      priority: 0
    });
    setAclDialogOpen(true);
  };

  const handleSaveAcl = async () => {
    if (!selectedUserId) return;
    
    try {

      if (editingAcl) {
        await updateMqttAcl(editingAcl.id, aclFormData);
      } else {
        await createMqttAcl(selectedUserId, aclFormData);
      }

      toast.success(`ACL rule ${editingAcl ? 'updated' : 'created'} successfully`);
      setAclDialogOpen(false);
      fetchMqttUsers();
    } catch (error) {
      console.error('Save ACL error:', error);
      toast.error(error instanceof Error ? error.message : "Network error while saving ACL rule");
    }
  };

  const handleDeleteAcl = async () => {
    if (!deleteTarget || deleteTarget.type !== 'acl') return;
    
    try {
      await deleteMqttAcl(deleteTarget.id);
      toast.success("ACL rule deleted successfully");
      fetchMqttUsers();
    } catch (error) {
      console.error('Delete ACL error:', error);
      toast.error(error instanceof Error ? error.message : "Network error while deleting ACL rule");
    } finally {
      setDeleteDialogOpen(false);
      setDeleteTarget(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold">
          Security & Access Control
        </h2>
        <p className="text-sm text-gray-600 mt-1">
          Manage MQTT users and API keys
        </p>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4 mt-4">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-foreground">Category:</label>
            <Select value={activeTab} onValueChange={setActiveTab}>
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mqtt">MQTT Users</SelectItem>
                <SelectItem value="api-keys">API Keys</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {activeTab === 'mqtt' ? (
            <Button onClick={handleAddUser} aria-label="Add MQTT User" title="Add MQTT User">
              <Plus className="w-4 h-4 mr-2" />
              Add MQTT User
            </Button>
          ) : (
            <Button onClick={handleOpenApiKeyDialog}>
              <Plus className="w-4 h-4 mr-2" />
              Add API Key
            </Button>
          )}
        </div>

        {/* MQTT Users Tab */}
        <TabsContent value="mqtt" className="space-y-4">
          {loadingMqtt ? (
            <div className="flex items-center justify-center h-64">
              <p className="text-muted-foreground">Loading MQTT users...</p>
            </div>
          ) : mqttUsers.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Shield className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground mb-4">No MQTT users configured</p>
                <Button onClick={handleAddUser}>
                  <UserPlus className="w-4 h-4 mr-2" />
                  Add Your First User
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card className="p-4 md:p-6">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Status</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Username</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Permissions</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">ACL Rules</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Created</th>
                      <th className="py-3 px-4 font-semibold text-sm text-foreground" style={{ textAlign: 'left' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mqttUsers.map((user) => (
                      <tr key={user.id} className="border-b border-border last:border-0 hover:bg-muted">
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            {user.is_active ? (
                              <Unlock className="w-4 h-4 text-green-600 dark:text-green-400" />
                            ) : (
                              <Lock className="w-4 h-4 text-muted-foreground" />
                            )}
                            <Badge variant={user.is_active ? "default" : "outline"}>
                              {user.is_active ? 'Active' : 'Inactive'}
                            </Badge>
                          </div>
                        </td>
                        <td className="py-3 px-4 font-medium text-foreground">{user.username}</td>
                        <td className="py-3 px-4">
                          <div className="flex flex-wrap gap-1">
                            {user.is_superuser && (
                              <Badge variant="destructive" className="text-xs">
                                <Key className="w-3 h-3 mr-1" />
                                Superuser
                              </Badge>
                            )}
                            {user.is_superuser && (
                              <span className="text-xs text-muted-foreground ml-2">
                                (bypasses ACLs)
                              </span>
                            )}
                            {!user.is_superuser && user.acls.length === 0 && (
                              <Badge variant="outline" className="text-xs">
                                No ACL
                              </Badge>
                            )}
                            {!user.is_superuser && user.acls.length > 0 && user.acls.slice(0, 2).map((acl) => (
                              <Badge key={acl.id} variant="secondary" className="text-xs max-w-[220px] truncate" title={`${acl.topic} (${acl.access === 1 ? 'read' : acl.access === 2 ? 'write' : 'read+write'})`}>
                                {acl.access === 1 ? 'R' : acl.access === 2 ? 'W' : 'R/W'}: {acl.topic}
                              </Badge>
                            ))}
                            {!user.is_superuser && user.acls.length > 2 && (
                              <Badge variant="outline" className="text-xs">
                                +{user.acls.length - 2} more
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-foreground">{user.acls.length}</span>
                            {!user.is_superuser && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleAddAcl(user.id)}
                                className="h-7 text-xs"
                              >
                                <Plus className="w-3 h-3 mr-1" />
                                Add Rule
                              </Button>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-muted-foreground">
                          {new Date(user.created_at).toLocaleDateString()}
                        </td>
                        <td className="py-3 px-4" style={{ textAlign: 'left' }}>
                          <div className="inline-flex items-center gap-2 whitespace-nowrap">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleEditUser(user)}
                            >
                              <Edit className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setDeleteTarget({ type: 'user', id: user.id });
                                setDeleteDialogOpen(true);
                              }}
                            >
                              <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </TabsContent>

        {/* API Keys Tab */}
        <TabsContent value="api-keys" className="space-y-4">
          {loadingApiKeys ? (
            <div className="flex items-center justify-center h-64">
              <p className="text-muted-foreground">Loading API keys...</p>
            </div>
          ) : apiKeys.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Key className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground mb-4">No API keys configured</p>
                <Button onClick={handleOpenApiKeyDialog}>
                  <Plus className="w-4 h-4 mr-2" />
                  Add Your First API Key
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card className="p-4 md:p-6">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Name</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Key</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Status</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Last Used</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Expires</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Created</th>
                      <th className="py-3 px-4 font-semibold text-sm text-foreground" style={{ textAlign: 'left' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {apiKeys.map((key) => (
                      <tr key={key.id} className="border-b border-border last:border-0 hover:bg-muted">
                        <td className="py-3 px-4 font-medium text-foreground">{key.name}</td>
                        <td className="py-3 px-4">
                          {showApiKey[key.id] ? (
                            <code className="text-xs font-mono bg-muted px-2 py-1 rounded break-all">
                              {key.key}
                            </code>
                          ) : (
                            <code className="text-xs font-mono text-foreground">
                              {key.key_prefix}...
                            </code>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <Badge variant={key.is_active ? "default" : "outline"}>
                            {key.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                        </td>
                        <td className="py-3 px-4 text-muted-foreground">
                          {key.last_used_at ? new Date(key.last_used_at).toLocaleDateString() : 'Never'}
                        </td>
                        <td className="py-3 px-4 text-muted-foreground">
                          {key.expires_at ? new Date(key.expires_at).toLocaleDateString() : 'Never'}
                        </td>
                        <td className="py-3 px-4 text-muted-foreground">
                          {new Date(key.created_at).toLocaleDateString()}
                        </td>
                        <td className="py-3 px-4" style={{ textAlign: 'left' }}>
                          <div className="inline-flex items-center gap-2 whitespace-nowrap">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setShowApiKey(prev => ({ ...prev, [key.id]: !prev[key.id] }))}
                            >
                              {showApiKey[key.id] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={!key.key}
                              onClick={() => {
                                navigator.clipboard.writeText(key.key);
                                toast.success("API key copied to clipboard");
                              }}
                            >
                              <Copy className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={!key.is_active}
                              onClick={() => handleRevokeApiKey(key.id)}
                            >
                              <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* MQTT User Dialog */}
      <Dialog open={apiKeyDialogOpen} onOpenChange={setApiKeyDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add API Key</DialogTitle>
            <DialogDescription>
              Create a new service API key for internal integrations.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="api-key-name">Name</Label>
              <Input
                id="api-key-name"
                value={apiKeyFormData.name}
                onChange={(e) => setApiKeyFormData({ ...apiKeyFormData, name: e.target.value })}
                placeholder="simulator"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="api-key-description">Description (optional)</Label>
              <Input
                id="api-key-description"
                value={apiKeyFormData.description}
                onChange={(e) => setApiKeyFormData({ ...apiKeyFormData, description: e.target.value })}
                placeholder="Used by protocol simulators"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="api-key-expiry-period">Expiry Period</Label>
              <Select
                value={apiKeyFormData.expiry_period}
                onValueChange={(value) => setApiKeyFormData({ ...apiKeyFormData, expiry_period: value })}
              >
                <SelectTrigger id="api-key-expiry-period">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30d">30 days</SelectItem>
                  <SelectItem value="90d">90 days (recommended)</SelectItem>
                  <SelectItem value="180d">180 days</SelectItem>
                  <SelectItem value="365d">365 days</SelectItem>
                  <SelectItem value="never">Never expires</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500">
                Best practice: prefer short-lived keys (30-90 days) and rotate regularly.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setApiKeyDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleGenerateApiKey}>Generate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* MQTT User Dialog */}
      <Dialog open={userDialogOpen} onOpenChange={setUserDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingUser ? 'Edit MQTT User' : 'Add MQTT User'}
            </DialogTitle>
            <DialogDescription>
              {editingUser 
                ? 'Update user credentials and permissions' 
                : 'Create a new MQTT user with authentication credentials'}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                value={userFormData.username}
                onChange={(e) => setUserFormData({ ...userFormData, username: e.target.value })}
                disabled={!!editingUser}
                placeholder="mqtt-user"
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="password">
                Password {editingUser && '(leave blank to keep current)'}
              </Label>
              <Input
                id="password"
                type="password"
                value={userFormData.password}
                onChange={(e) => setUserFormData({ ...userFormData, password: e.target.value })}
                placeholder={editingUser ? '••••••••' : 'Enter password'}
              />
            </div>
            
            <div className="flex items-center space-x-2">
              <Checkbox
                id="is_superuser"
                checked={userFormData.is_superuser}
                onCheckedChange={(checked) => 
                  setUserFormData({ ...userFormData, is_superuser: checked as boolean })
                }
              />
              <Label htmlFor="is_superuser" className="cursor-pointer">
                Superuser (bypass all ACL checks)
              </Label>
            </div>
            
            <div className="flex items-center space-x-2">
              <Checkbox
                id="is_active"
                checked={userFormData.is_active}
                onCheckedChange={(checked) => 
                  setUserFormData({ ...userFormData, is_active: checked as boolean })
                }
              />
              <Label htmlFor="is_active" className="cursor-pointer">
                Active
              </Label>
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setUserDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveUser}>
              {editingUser ? 'Save Changes' : 'Create User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ACL Dialog */}
      <Dialog open={aclDialogOpen} onOpenChange={setAclDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingAcl ? 'Edit ACL Rule' : 'Add ACL Rule'}
            </DialogTitle>
            <DialogDescription>
              Define topic access permissions. Use + for single-level wildcard, # for multi-level.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="topic">Topic Pattern</Label>
              <Input
                id="topic"
                value={aclFormData.topic}
                onChange={(e) => setAclFormData({ ...aclFormData, topic: e.target.value })}
                placeholder="sensor/+/temperature or devices/#"
              />
              <p className="text-xs text-gray-500">
                Examples: sensor/temperature, devices/+/data, home/#
              </p>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="access">Access Level</Label>
              <Select
                value={aclFormData.access.toString()}
                onValueChange={(value) => 
                  setAclFormData({ ...aclFormData, access: parseInt(value) })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Read (Subscribe only)</SelectItem>
                  <SelectItem value="2">Write (Publish only)</SelectItem>
                  <SelectItem value="3">Read + Write (Full access)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="priority">Priority (higher = more important)</Label>
              <Input
                id="priority"
                type="number"
                value={aclFormData.priority}
                onChange={(e) => 
                  setAclFormData({ ...aclFormData, priority: parseInt(e.target.value) || 0 })
                }
                placeholder="0"
              />
              <p className="text-xs text-gray-500">
                Higher priority rules override lower ones in case of conflicts
              </p>
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setAclDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveAcl}>
              {editingAcl ? 'Save Changes' : 'Create Rule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.type === 'user' 
                ? 'This will permanently delete the MQTT user and all their ACL rules. This action cannot be undone.'
                : 'This will permanently delete this ACL rule. This action cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={deleteTarget?.type === 'user' ? handleDeleteUser : handleDeleteAcl}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
