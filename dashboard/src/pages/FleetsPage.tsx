import { useState, useEffect } from "react";
import { useRouting } from "../hooks/useRouting";
import { MetricCard } from "../components/ui/metric-card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "../components/ui/card";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { Layers, Server, DollarSign, AlertCircle, Plus, Pencil } from "lucide-react";
import { buildApiUrl } from "../config/api";
import { toast } from "sonner";
import { CreateFleetDialog } from "../components/CreateFleetDialog";
import { EditFleetDialog } from "../components/EditFleetDialog";

interface Fleet {
  fleet_uuid?: string;
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
  const { navigateToFleet } = useRouting();
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
      // Skip if no token (not authenticated yet)
      if (!token) {
        setIsLoading(false);
        return;
      }
      
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
    <div className="flex-1 bg-background overflow-auto" data-testid="fleets-page">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight text-foreground" data-testid="fleets-page-title">Fleet Management</h1>
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
              <div key="filter-type" className="flex items-center gap-2">
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

              <div key="filter-status" className="flex items-center gap-2">
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
        <Card data-testid="fleets-list-card">
          <CardHeader>
            <CardTitle>Fleets</CardTitle>
            <CardDescription>
              {filteredFleets.length} {filteredFleets.length === 1 ? 'fleet' : 'fleets'} found
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-12 text-muted-foreground" data-testid="fleets-loading-state">
                <Server className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-lg font-medium mb-2">Loading fleets...</p>
              </div>
            ) : fleets.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground" data-testid="fleets-empty-state">
                <Server className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-lg font-medium mb-2">No fleets yet</p>
                <p className="text-sm">Create your first fleet to get started</p>
              </div>
            ) : filteredFleets.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground" data-testid="fleets-filtered-empty-state">
                No fleets match the selected filters.
              </div>
            ) : (
              <div className="overflow-x-auto" data-testid="fleets-table-container">
                <table className="w-full text-sm" data-testid="fleets-table">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Status</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Name</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Type</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Environment</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Devices</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Location</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Cost</th>
                      <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Created</th>
                      <th className="py-3 px-4 font-semibold text-sm text-foreground text-left">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFleets.map((fleet) => (
                      <tr
                        key={fleet.fleet_id}
                        data-testid={`fleet-row-${fleet.fleet_uuid || fleet.fleet_id}`}
                        className="border-b border-border last:border-0 hover:bg-muted cursor-pointer"
                        onClick={() => navigateToFleet(fleet.fleet_uuid || fleet.fleet_id)}
                      >
                        <td className="py-3 px-4">
                          <Badge variant={fleet.status === 'active' ? 'default' : 'secondary'}>
                            {fleet.status}
                          </Badge>
                        </td>
                        <td className="py-3 px-4 font-medium text-foreground">
                          <div className="flex items-center gap-2">
                            <span>{fleet.fleet_name}</span>
                            {fleet.fleet_uuid && (
                              <span
                                className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono cursor-pointer hover:bg-muted/80"
                                title="Click to copy fleet UUID"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigator.clipboard.writeText(fleet.fleet_uuid!);
                                  toast.success('Fleet UUID copied to clipboard');
                                }}
                              >
                                {fleet.fleet_uuid.substring(0, 8)}...
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <Badge variant={fleet.fleet_type === 'virtual' ? 'default' : 'secondary'}>
                            {fleet.fleet_type}
                          </Badge>
                        </td>
                        <td className="py-3 px-4">
                          <Badge variant="outline" className="text-xs">
                            {fleet.environment}
                          </Badge>
                        </td>
                        <td className="py-3 px-4 text-muted-foreground">
                          {fleet.device_count} ({fleet.online_count} online)
                        </td>
                        <td className="py-3 px-4 text-muted-foreground">
                          {fleet.location || '—'}
                        </td>
                        <td className="py-3 px-4 text-muted-foreground">
                          {fleet.billing_enabled
                            ? `$${fleet.current_cost}${fleet.budget_limit ? ` / $${fleet.budget_limit}` : ''}`
                            : '—'}
                        </td>
                        <td className="py-3 px-4 text-muted-foreground">
                          {new Date(fleet.created_at).toLocaleDateString()}
                        </td>
                        <td className="py-3 px-4">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleEdit(fleet);
                            }}
                          >
                            <Pencil className="h-4 w-4 mr-2" />
                            Edit
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
