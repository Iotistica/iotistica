/**
 * Security Page - Security Management
 * 
 * Provides interface to:
 * - Manage MQTT users and ACLs
 * - Manage regular users and roles
 * - Manage API keys
 */

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { Switch } from "@/components/ui/switch";
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
  Users,
  Copy,
  Eye,
  EyeOff
} from "lucide-react";
import { buildApiUrl } from "@/config/api";
import { toast } from "sonner";

interface MqttAcl {
  id: number;
  topic: string;
  access: number; // 1=read, 2=write, 3=read+write
  priority: number;
  created_at: string;
}

interface MqttUser {
  id: number;
  username: string;
  is_superuser: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  acls: MqttAcl[];
}

interface RegularUser {
  id: number;
  username: string;
  email: string;
  role: string;
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
}

interface ApiKey {
  id: number;
  name: string;
  key_prefix: string;
  key: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  is_active: boolean;
}

export function SecurityPage() {
  // MQTT Users state
  const [mqttUsers, setMqttUsers] = useState<MqttUser[]>([]);
  const [loadingMqtt, setLoadingMqtt] = useState(true);
  
  // Regular Users state
  const [regularUsers, setRegularUsers] = useState<RegularUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  
  // API Keys state
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loadingApiKeys, setLoadingApiKeys] = useState(true);
  const [showApiKey, setShowApiKey] = useState<{[key: number]: boolean}>({});
  
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
    fetchRegularUsers();
    fetchApiKeys();
  }, []);

  const fetchMqttUsers = async () => {
    try {
      const response = await fetch(buildApiUrl('/api/v1/auth/mqtt-users'), {
        credentials: 'include'
      });
      
      if (response.ok) {
        const data = await response.json();
        setMqttUsers(data.users || []);
      } else {
        console.error('Failed to fetch MQTT users:', response.status);
        toast.error("Failed to fetch MQTT users");
      }
    } catch (error) {
      console.error('Failed to fetch MQTT users:', error);
      toast.error("Network error while fetching users");
    } finally {
      setLoadingMqtt(false);
    }
  };

  const fetchRegularUsers = async () => {
    try {
      // Placeholder - implement when backend endpoint exists
      setRegularUsers([]);
    } catch (error) {
      console.error('Failed to fetch users:', error);
    } finally {
      setLoadingUsers(false);
    }
  };

  const fetchApiKeys = async () => {
    try {
      // Placeholder - implement when backend endpoint exists
      setApiKeys([]);
    } catch (error) {
      console.error('Failed to fetch API keys:', error);
    } finally {
      setLoadingApiKeys(false);
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
      const url = editingUser 
        ? buildApiUrl(`/api/v1/auth/mqtt-users/${editingUser.id}`)
        : buildApiUrl('/api/v1/auth/mqtt-users');
      
      const method = editingUser ? 'PUT' : 'POST';
      
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
      
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body)
      });
      
      if (response.ok) {
        toast.success(`MQTT user ${editingUser ? 'updated' : 'created'} successfully`);
        setUserDialogOpen(false);
        fetchMqttUsers();
      } else {
        const data = await response.json();
        toast.error(data.message || `Failed to ${editingUser ? 'update' : 'create'} user`);
      }
    } catch (error) {
      console.error('Save user error:', error);
      toast.error("Network error while saving user");
    }
  };

  const handleDeleteUser = async () => {
    if (!deleteTarget || deleteTarget.type !== 'user') return;
    
    try {
      const response = await fetch(
        buildApiUrl(`/api/v1/auth/mqtt-users/${deleteTarget.id}`),
        {
          method: 'DELETE',
          credentials: 'include'
        }
      );
      
      if (response.ok) {
        toast.success("MQTT user deleted successfully");
        fetchMqttUsers();
      } else {
        toast.error("Failed to delete user");
      }
    } catch (error) {
      console.error('Delete user error:', error);
      toast.error("Network error while deleting user");
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
      const url = editingAcl
        ? buildApiUrl(`/api/v1/auth/mqtt-acls/${editingAcl.id}`)
        : buildApiUrl(`/api/v1/auth/mqtt-users/${selectedUserId}/acls`);
      
      const method = editingAcl ? 'PUT' : 'POST';
      
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(aclFormData)
      });
      
      if (response.ok) {
        toast.success(`ACL rule ${editingAcl ? 'updated' : 'created'} successfully`);
        setAclDialogOpen(false);
        fetchMqttUsers();
      } else {
        const data = await response.json();
        toast.error(data.message || `Failed to ${editingAcl ? 'update' : 'create'} ACL rule`);
      }
    } catch (error) {
      console.error('Save ACL error:', error);
      toast.error("Network error while saving ACL rule");
    }
  };

  const handleDeleteAcl = async () => {
    if (!deleteTarget || deleteTarget.type !== 'acl') return;
    
    try {
      const response = await fetch(
        buildApiUrl(`/api/v1/auth/mqtt-acls/${deleteTarget.id}`),
        {
          method: 'DELETE',
          credentials: 'include'
        }
      );
      
      if (response.ok) {
        toast.success("ACL rule deleted successfully");
        fetchMqttUsers();
      } else {
        toast.error("Failed to delete ACL rule");
      }
    } catch (error) {
      console.error('Delete ACL error:', error);
      toast.error("Network error while deleting ACL rule");
    } finally {
      setDeleteDialogOpen(false);
      setDeleteTarget(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Shield className="w-6 h-6" />
          Security & Access Control
        </h2>
        <p className="text-sm text-gray-600 mt-1">
          Manage MQTT users, regular users, and API keys
        </p>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="mqtt" className="space-y-6">
        <TabsList>
          <TabsTrigger value="mqtt">
            <Key className="w-4 h-4 mr-2" />
            MQTT Users
          </TabsTrigger>
          <TabsTrigger value="users">
            <Users className="w-4 h-4 mr-2" />
            Users & Roles
          </TabsTrigger>
          <TabsTrigger value="api-keys">
            <Shield className="w-4 h-4 mr-2" />
            API Keys
          </TabsTrigger>
        </TabsList>

        {/* MQTT Users Tab */}
        <TabsContent value="mqtt" className="space-y-4">
          <div className="flex justify-end mb-4">
            <Button onClick={handleAddUser} className="ml-auto">
              <UserPlus className="w-4 h-4 mr-2" />
              Add MQTT User
            </Button>
          </div>

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
                      <th className="text-right py-3 px-4 font-semibold text-sm text-foreground">Actions</th>
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
                        <td className="py-3 px-4">
                          <div className="flex items-center justify-end gap-2 whitespace-nowrap ml-auto">
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

        {/* Users & Roles Tab */}
        <TabsContent value="users" className="space-y-4">
          <div className="flex justify-end">
            <Button>
              <UserPlus className="w-4 h-4 mr-2" />
              Add User
            </Button>
          </div>

          {loadingUsers ? (
            <div className="flex items-center justify-center h-64">
              <p className="text-muted-foreground">Loading users...</p>
            </div>
          ) : regularUsers.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Users className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground mb-4">No users configured</p>
                <Button>
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
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Username</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Email</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Role</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Status</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Last Login</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Created</th>
                      <th className="text-right py-3 px-4 font-semibold text-sm text-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {regularUsers.map((user) => (
                      <tr key={user.id} className="border-b border-border last:border-0 hover:bg-muted">
                        <td className="py-3 px-4 font-medium text-foreground">{user.username}</td>
                        <td className="py-3 px-4 text-foreground">{user.email}</td>
                        <td className="py-3 px-4">
                          <Badge>{user.role}</Badge>
                        </td>
                        <td className="py-3 px-4">
                          <Badge variant={user.is_active ? "default" : "outline"}>
                            {user.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                        </td>
                        <td className="py-3 px-4 text-muted-foreground">
                          {user.last_login_at ? new Date(user.last_login_at).toLocaleDateString() : 'Never'}
                        </td>
                        <td className="py-3 px-4 text-muted-foreground">
                          {new Date(user.created_at).toLocaleDateString()}
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center justify-end gap-2 whitespace-nowrap ml-auto">
                            <Button variant="outline" size="sm">
                              <Edit className="w-4 h-4" />
                            </Button>
                            <Button variant="outline" size="sm">
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
          <div className="flex justify-end">
            <Button>
              <Plus className="w-4 h-4 mr-2" />
              Generate API Key
            </Button>
          </div>

          {loadingApiKeys ? (
            <div className="flex items-center justify-center h-64">
              <p className="text-muted-foreground">Loading API keys...</p>
            </div>
          ) : apiKeys.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Key className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground mb-4">No API keys configured</p>
                <Button>
                  <Plus className="w-4 h-4 mr-2" />
                  Generate Your First API Key
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
                      <th className="text-right py-3 px-4 font-semibold text-sm text-foreground">Actions</th>
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
                        <td className="py-3 px-4">
                          <div className="flex items-center justify-end gap-2 whitespace-nowrap ml-auto">
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
                              onClick={() => {
                                navigator.clipboard.writeText(key.key);
                                toast.success("API key copied to clipboard");
                              }}
                            >
                              <Copy className="w-4 h-4" />
                            </Button>
                            <Button variant="outline" size="sm">
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
              <Switch
                id="is_superuser"
                checked={userFormData.is_superuser}
                onCheckedChange={(checked) => 
                  setUserFormData({ ...userFormData, is_superuser: checked })
                }
              />
              <Label htmlFor="is_superuser">
                Superuser (bypass all ACL checks)
              </Label>
            </div>
            
            <div className="flex items-center space-x-2">
              <Switch
                id="is_active"
                checked={userFormData.is_active}
                onCheckedChange={(checked) => 
                  setUserFormData({ ...userFormData, is_active: checked })
                }
              />
              <Label htmlFor="is_active">
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
