import { useState, useEffect } from "react";
import { MetricCard } from "../components/ui/metric-card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";
import { Layers, Server, DollarSign, AlertCircle, Plus, Play, Square } from "lucide-react";
import { buildApiUrl } from "../config/api";
import { toast } from "sonner";
import { CreateFleetDialog } from "../components/CreateFleetDialog";

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
  const [filter, setFilter] = useState<'all' | 'virtual' | 'physical'>('all');
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const fetchFleets = async () => {
    try {
      const token = localStorage.getItem('accessToken');
      const url = filter === 'all' 
        ? buildApiUrl('/api/v1/fleets')
        : buildApiUrl(`/api/v1/fleets?fleet_type=${filter}`);
      
      const response = await fetch(url, {
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
  }, [filter]);

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
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-foreground mb-2">Fleet Management</h2>
          <p className="text-muted-foreground">
            Manage virtual and physical device fleets
          </p>
        </div>

        {/* Metrics */}
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

        {/* Filters and New Fleet Button */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant={filter === 'all' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter('all')}
            >
              All
            </Button>
            <Button
              variant={filter === 'virtual' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter('virtual')}
            >
              Virtual
            </Button>
            <Button
              variant={filter === 'physical' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter('physical')}
            >
              Physical
            </Button>
          </div>
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus className="w-4 h-4 mr-2" />
            New Fleet
          </Button>
        </div>

        {/* Fleets List */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {isLoading ? (
            <div className="col-span-full text-center py-12 text-muted-foreground">
              Loading fleets...
            </div>
          ) : fleets.length === 0 ? (
            <div className="col-span-full text-center py-12 text-muted-foreground">
              No fleets found. Create your first fleet to get started.
            </div>
          ) : (
            fleets.map((fleet) => (
              <Card key={fleet.fleet_id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <CardTitle className="text-lg">{fleet.fleet_name}</CardTitle>
                      <div className="flex items-center gap-2 mt-2">
                        <Badge variant={fleet.fleet_type === 'virtual' ? 'default' : 'secondary'}>
                          {fleet.fleet_type}
                        </Badge>
                        <Badge variant={fleet.status === 'active' ? 'default' : 'secondary'}>
                          {fleet.status}
                        </Badge>
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="text-sm space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Devices:</span>
                      <span className="font-medium">{fleet.device_count} ({fleet.online_count} online)</span>
                    </div>
                    {fleet.environment && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Environment:</span>
                        <span className="font-medium">{fleet.environment}</span>
                      </div>
                    )}
                    {fleet.location && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Location:</span>
                        <span className="font-medium text-xs">{fleet.location}</span>
                      </div>
                    )}
                    {fleet.billing_enabled && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Cost:</span>
                        <span className="font-medium">
                          ${fleet.current_cost}
                          {fleet.budget_limit && ` / $${fleet.budget_limit}`}
                        </span>
                      </div>
                    )}
                  </div>

                  {fleet.fleet_type === 'virtual' && (
                    <div className="flex gap-2 pt-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
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
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>

      {/* Create Fleet Dialog */}
      <CreateFleetDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onSuccess={fetchFleets}
      />
    </div>
  );
}
