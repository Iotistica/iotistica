import { useState, useEffect } from "react";
import { MetricCard } from "../components/ui/metric-card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "../components/ui/card";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { Layers, Server, DollarSign, AlertCircle, Plus, Play, Square, Pencil } from "lucide-react";
import { buildApiUrl } from "../config/api";
import { toast } from "sonner";
import { CreateFleetDialog } from "../components/CreateFleetDialog";
import { EditFleetDialog } from "../components/EditFleetDialog";

interface Fleet {
  fleet_id: string;
  fleet_name: string;
  customer_id: string;
  fleet_type: 'virtual' | 'physical' | 'mixed';
  status: 'active' | 'stopped' | 'deleted';
  environment: string;
  location: string | null;
  billing_enabled: boolean;
  current_cost: string;
  budget_limit: string | null;
  device_count: string;
  online_count: string;
  created_at: string;
  updated_at: string;
}

export function FleetsPage() {
  const [fleets, setFleets] = useState<Fleet[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedType, setSelectedType] = useState<string[]>([]);
  const [selectedStatus, setSelectedStatus] = useState<string[]>([]);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingFleet, setEditingFleet] = useState<Fleet | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);

  const fetchFleets = async () => {
    try {
      const token = localStorage.getItem('accessToken');
      const response = await fetch(buildApiUrl('/api/v1/fleets'), {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (!response.ok) throw new Error('Failed to fetch fleets');
      
      const data = await response.json();
      setFleets(data.fleets || []);
    } catch (error: any) {
      console.error('Error fetching fleets:', error);
      toast.error('Failed to load fleets');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchFleets();
  }, []);

  // Apply filters
  const filteredFleets = fleets.filter(fleet => {
    if (selectedType.length > 0 && !selectedType.includes(fleet.fleet_type)) {
      return false;
    }
    if (selectedStatus.length > 0 && !selectedStatus.includes(fleet.status)) {
      return false;
    }
    return true;
  });

  // Calculate metrics
  const virtualFleets = fleets.filter(f => f.fleet_type === 'virtual');
  const physicalFleets = fleets.filter(f => f.fleet_type === 'physical');
  const totalCost = virtualFleets.reduce((sum, f) => sum + parseFloat(f.current_cost || '0'), 0);
  const totalBudget = virtualFleets.reduce((sum, f) => {
    const budget = parseFloat(f.budget_limit || '0');
    return budget > 0 ? sum + budget : sum;
  }, 0);

  const handleStartStop = async (fleetId: string, isActive: boolean) => {
    try {
      const token = localStorage.getItem('accessToken');
      const action = isActive ? 'stop' : 'start';
      const response = await fetch(buildApiUrl(`/api/v1/fleets/${fleetId}/${action}`), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (!response.ok) throw new Error(`Failed to ${action} fleet`);
      
      toast.success(`Fleet ${action}ed successfully`);
      fetchFleets();
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  const handleEdit = (fleet: Fleet) => {
    setEditingFleet(fleet);
    setShowEditDialog(true);
  };

  const metrics = [
    {
      icon: Server,
      label: "Virtual Fleets",
      value: virtualFleets.length.toString(),
      subtitle: `${virtualFleets.filter(f => f.status === 'active').length} active`,
      color: "blue" as const,
    },
    {
      icon: Layers,
      label: "Physical Fleets",
      value: physicalFleets.length.toString(),
      subtitle: `${physicalFleets.filter(f => f.status === 'active').length} active`,
      color: "purple" as const,
    },
    {
      icon: DollarSign,
      label: "Monthly Cost",
      value: `$${totalCost.toFixed(2)}`,
      subtitle: totalBudget > 0 ? `of $${totalBudget.toFixed(2)} budget` : 'No budget set',
      color: "green" as const,
    },
    {
      icon: AlertCircle,
      label: "Total Devices",
      value: fleets.reduce((sum, f) => sum + parseInt(f.device_count || '0'), 0).toString(),
      subtitle: `${fleets.reduce((sum, f) => sum + parseInt(f.online_count || '0'), 0)} online`,
      color: "orange" as const,
    },
  ];

  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Fleet Management</h1>
            <p className="text-sm text-muted-foreground">
              Monitor and manage your device fleets
            </p>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {metrics.map((metric, index) => (
            <MetricCard
              key={index}
              label={metric.label}
              value={metric.value}
              subtitle={metric.subtitle}
              icon={metric.icon}
              iconColor={metric.color}
            />
          ))}
        </div>

        {/* Filters and Actions */}
        <div className="flex items-center justify-between gap-4">
          {fleets.length > 0 ? (
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-foreground">Type:</label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="min-w-[160px] justify-between">
                      {selectedType.length === 0 ? 'All' : `${selectedType.length} selected`}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuCheckboxItem
                      checked={selectedType.length === 0}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(checked) => setSelectedType(checked ? [] : selectedType)}
                    >
                      All ({fleets.length})
                    </DropdownMenuCheckboxItem>
                    {['virtual', 'physical', 'mixed'].map(type => {
                      const count = fleets.filter(f => f.fleet_type === type).length;
                      if (count === 0) return null;
                      return (
                        <DropdownMenuCheckboxItem
                          key={type}
                          checked={selectedType.includes(type)}
                          onSelect={(e) => e.preventDefault()}
                          onCheckedChange={(checked) => {
                            setSelectedType(prev =>
                              checked
                                ? [...prev.filter(t => t !== type), type]
                                : prev.filter(t => t !== type)
                            );
                          }}
                        >
                          {type.charAt(0).toUpperCase() + type.slice(1)} ({count})
                        </DropdownMenuCheckboxItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-foreground">Status:</label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="min-w-[160px] justify-between">
                      {selectedStatus.length === 0 ? 'All' : `${selectedStatus.length} selected`}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuCheckboxItem
                      checked={selectedStatus.length === 0}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(checked) => setSelectedStatus(checked ? [] : selectedStatus)}
                    >
                      All ({fleets.length})
                    </DropdownMenuCheckboxItem>
                    {['active', 'stopped'].map(status => {
                      const count = fleets.filter(f => f.status === status).length;
                      if (count === 0) return null;
                      return (
                        <DropdownMenuCheckboxItem
                          key={status}
                          checked={selectedStatus.includes(status)}
                          onSelect={(e) => e.preventDefault()}
                          onCheckedChange={(checked) => {
                            setSelectedStatus(prev =>
                              checked
                                ? [...prev.filter(s => s !== status), status]
                                : prev.filter(s => s !== status)
                            );
                          }}
                        >
                          {status.charAt(0).toUpperCase() + status.slice(1)} ({count})
                        </DropdownMenuCheckboxItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ) : (
            <div />
          )}
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus className="w-4 h-4 mr-2" />
            New Fleet
          </Button>
        </div>

        {/* Fleets List */}
        <Card>
          <CardHeader>
            <CardTitle>Fleets</CardTitle>
            <CardDescription>
              {filteredFleets.length} {filteredFleets.length === 1 ? 'fleet' : 'fleets'} found
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-12 text-muted-foreground">
                <Server className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-lg font-medium mb-2">Loading fleets...</p>
              </div>
            ) : fleets.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Server className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-lg font-medium mb-2">No fleets yet</p>
                <p className="text-sm">Create your first fleet to get started</p>
              </div>
            ) : filteredFleets.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                No fleets match the selected filters.
              </div>
            ) : (
              <div className="space-y-3">
                {filteredFleets.map((fleet) => (
                  <div
                    key={fleet.fleet_id}
                    className="flex items-center justify-between p-4 border border-border rounded-lg hover:border-muted-foreground/20 transition-colors"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="text-lg font-semibold text-foreground">{fleet.fleet_name}</h3>
                        <Badge variant={fleet.fleet_type === 'virtual' ? 'default' : 'secondary'}>
                          {fleet.fleet_type}
                        </Badge>
                        <Badge variant={fleet.status === 'active' ? 'default' : 'secondary'}>
                          {fleet.status}
                        </Badge>
                        <Badge variant="outline" className="text-xs">
                          {fleet.environment}
                        </Badge>
                      </div>

                      <div className="flex flex-wrap gap-6 text-sm text-muted-foreground">
                        <div>
                          <span className="font-medium">Devices:</span>{' '}
                          {fleet.device_count} ({fleet.online_count} online)
                        </div>
                        {fleet.location && (
                          <div>
                            <span className="font-medium">Location:</span>{' '}
                            {fleet.location}
                          </div>
                        )}
                        {fleet.billing_enabled && (
                          <div>
                            <span className="font-medium">Cost:</span>{' '}
                            ${fleet.current_cost}
                            {fleet.budget_limit && ` / $${fleet.budget_limit}`}
                          </div>
                        )}
                        <div>
                          <span className="font-medium">Created:</span>{' '}
                          {new Date(fleet.created_at).toLocaleDateString()}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 ml-4">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleEdit(fleet)}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      {fleet.fleet_type === 'virtual' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleStartStop(fleet.fleet_id, fleet.status === 'active')}
                        >
                          {fleet.status === 'active' ? (
                            <>
                              <Square className="w-3 h-3 mr-1" />
                              Stop
                            </>
                          ) : (
                            <>
                              <Play className="w-3 h-3 mr-1" />
                              Start
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Create Fleet Dialog */}
      <CreateFleetDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onSuccess={fetchFleets}
      />

      {/* Edit Fleet Dialog */}
      <EditFleetDialog
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        fleet={editingFleet}
        onSuccess={fetchFleets}
      />
    </div>
  );
}
