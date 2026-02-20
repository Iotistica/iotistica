import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { toast } from "sonner";
import { buildApiUrl } from "../config/api";
import { Loader2, Server, DollarSign, AlertCircle } from "lucide-react";

interface CreateFleetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

interface CostEstimate {
  agent_count: number;
  devices_per_agent: number;
  total_devices: number;
  cost_per_hour: number;
  cost_per_month: number;
  total_monthly_cost?: number;
  resource_tier?: string;
  tier?: string;
}

export function CreateFleetDialog({
  open,
  onOpenChange,
  onSuccess,
}: CreateFleetDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isEstimating, setIsEstimating] = useState(false);
  const [costEstimate, setCostEstimate] = useState<CostEstimate | null>(null);
  
  const [formData, setFormData] = useState({
    fleet_name: "",
    fleet_type: "physical" as 'virtual' | 'physical',
    environment: "production",
    location: "",
    agent_count: 1,
    devices_per_agent: 3,
    budget_limit: "",
  });

  // Fetch cost estimation for virtual fleets
  const fetchCostEstimate = async () => {
    if (formData.fleet_type !== 'virtual') {
      setCostEstimate(null);
      return;
    }

    setIsEstimating(true);
    try {
      const response = await fetch(buildApiUrl('/api/v1/fleets/virtual/estimate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_count: formData.agent_count,
          devices_per_agent: formData.devices_per_agent,
        }),
      });

      if (!response.ok) throw new Error('Failed to estimate cost');

      const data = await response.json();
      
      // Convert DECIMAL fields from strings to numbers (PostgreSQL returns DECIMAL as strings)
      setCostEstimate({
        ...data,
        cost_per_hour: parseFloat(data.cost_per_hour),
        cost_per_month: parseFloat(data.cost_per_month),
        total_monthly_cost: data.total_monthly_cost ? parseFloat(data.total_monthly_cost) : 0,
        tier: data.resource_tier || data.tier // Normalize tier field name
      });
    } catch (error: any) {
      console.error('Error estimating cost:', error);
      toast.error('Failed to estimate cost');
    } finally {
      setIsEstimating(false);
    }
  };

  // Update cost estimate when virtual fleet parameters change
  useEffect(() => {
    if (formData.fleet_type === 'virtual') {
      const timer = setTimeout(() => {
        fetchCostEstimate();
      }, 300); // Debounce
      return () => clearTimeout(timer);
    }
  }, [formData.fleet_type, formData.agent_count, formData.devices_per_agent]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const token = localStorage.getItem('accessToken');
      
      // Build request payload
      const payload: any = {
        fleet_name: formData.fleet_name,
        customer_id: '00000000-0000-0000-0000-000000000001', // Default customer for single-tenant deployments
        fleet_type: formData.fleet_type,
        environment: formData.environment,
        location: formData.location || null,
      };

      // Add virtual-specific fields
      if (formData.fleet_type === 'virtual') {
        payload.agent_count = formData.agent_count;
        payload.devices_per_agent = formData.devices_per_agent;
        payload.billing_enabled = true;
        payload.billing_mode = 'hourly';
        
        if (formData.budget_limit) {
          payload.budget_limit = parseFloat(formData.budget_limit);
        }
      } else {
        // Physical fleets are organizational only
        payload.billing_enabled = false;
      }

      const response = await fetch(buildApiUrl('/api/v1/fleets'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to create fleet');
      }

      const data = await response.json();
      
      // Check if there's a warning (e.g., namespace creation failed)
      if (data.warning) {
        toast.warning(`Fleet "${formData.fleet_name}" created with issues: ${data.warning}`, {
          duration: 8000, // Show longer for warnings
        });
      } else {
        toast.success(`Fleet "${formData.fleet_name}" created successfully`);
      }
      
      // Reset form
      setFormData({
        fleet_name: "",
        fleet_type: "physical",
        environment: "production",
        location: "",
        agent_count: 1,
        devices_per_agent: 3,
        budget_limit: "",
      });
      setCostEstimate(null);
      
      onSuccess();
      onOpenChange(false);
    } catch (error: any) {
      console.error('Error creating fleet:', error);
      toast.error(error.message || 'Failed to create fleet');
    } finally {
      setIsSubmitting(false);
    }
  };

  const totalDevices = formData.fleet_type === 'virtual' 
    ? formData.agent_count * formData.devices_per_agent 
    : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create New Fleet</DialogTitle>
          <DialogDescription>
            Create a fleet to organize and manage your devices or deploy virtual agents.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Fleet Type */}
          <div className="space-y-2">
            <Label htmlFor="fleet_type">Fleet Type</Label>
            <Select
              value={formData.fleet_type}
              onValueChange={(value: 'virtual' | 'physical') =>
                setFormData({ ...formData, fleet_type: value })
              }
            >
              <SelectTrigger className="text-left">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="physical">
                  <div className="flex flex-col items-start">
                    <span className="font-medium">Physical Fleet</span>
                    <span className="text-xs text-muted-foreground">
                      Organize existing hardware devices (no billing)
                    </span>
                  </div>
                </SelectItem>
                <SelectItem value="virtual">
                  <div className="flex flex-col items-start">
                    <span className="font-medium">Virtual Fleet</span>
                    <span className="text-xs text-muted-foreground">
                      Deploy virtual agents in the cloud (billed hourly)
                    </span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Fleet Name */}
          <div className="space-y-2">
            <Label htmlFor="fleet_name">Fleet Name *</Label>
            <Input
              id="fleet_name"
              value={formData.fleet_name}
              onChange={(e) =>
                setFormData({ ...formData, fleet_name: e.target.value })
              }
              placeholder="e.g., Production Sensors, Staging Environment"
              required
            />
          </div>

          {/* Environment */}
          <div className="space-y-2">
            <Label htmlFor="environment">Environment</Label>
            <Select
              value={formData.environment}
              onValueChange={(value) =>
                setFormData({ ...formData, environment: value })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="production">Production</SelectItem>
                <SelectItem value="staging">Staging</SelectItem>
                <SelectItem value="development">Development</SelectItem>
                <SelectItem value="testing">Testing</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Location */}
          <div className="space-y-2">
            <Label htmlFor="location">Location</Label>
            <Input
              id="location"
              value={formData.location}
              onChange={(e) =>
                setFormData({ ...formData, location: e.target.value })
              }
              placeholder="e.g., North America, Building A, Floor 3"
            />
          </div>

          {/* Virtual Fleet Configuration */}
          {formData.fleet_type === 'virtual' && (
            <div className="space-y-4 p-4 border rounded-lg bg-muted/50">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Server className="w-4 h-4" />
                Virtual Agent Configuration
              </div>

              {/* Agent Count */}
              <div className="space-y-2">
                <Label htmlFor="agent_count">Number of Agents</Label>
                <Input
                  id="agent_count"
                  type="number"
                  min={1}
                  value={formData.agent_count}
                  onChange={(e) =>
                    setFormData({ ...formData, agent_count: parseInt(e.target.value) || 1 })
                  }
                  placeholder="e.g., 5"
                />
                <p className="text-xs text-muted-foreground">
                  Each agent is a virtual device that can manage multiple sensors/devices
                </p>
              </div>

              {/* Devices per Agent */}
              <div className="space-y-2">
                <Label htmlFor="devices_per_agent">Devices per Agent</Label>
                <Input
                  id="devices_per_agent"
                  type="number"
                  min={1}
                  value={formData.devices_per_agent}
                  onChange={(e) =>
                    setFormData({ ...formData, devices_per_agent: parseInt(e.target.value) || 1 })
                  }
                  placeholder="e.g., 3"
                />
                <p className="text-xs text-muted-foreground">
                  Total devices in fleet: <strong>{totalDevices}</strong>
                </p>
              </div>

              {/* Budget Limit */}
              <div className="space-y-2">
                <Label htmlFor="budget_limit">Monthly Budget Limit ($)</Label>
                <Input
                  id="budget_limit"
                  type="number"
                  step="0.01"
                  min="0"
                  value={formData.budget_limit}
                  onChange={(e) =>
                    setFormData({ ...formData, budget_limit: e.target.value })
                  }
                  placeholder="Optional - leave empty for no limit"
                />
                <p className="text-xs text-muted-foreground">
                  Fleet will auto-stop when budget is exceeded
                </p>
              </div>

              {/* Cost Estimation */}
              {isEstimating && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Calculating cost...
                </div>
              )}

              {costEstimate && !isEstimating && (
                <div className="space-y-2 p-3 border rounded-lg bg-background">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <DollarSign className="w-4 h-4 text-green-600" />
                    Cost Estimation
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <div className="text-muted-foreground">Hourly</div>
                      <div className="font-semibold">
                        ${costEstimate.cost_per_hour.toFixed(3)}/hr
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Monthly (730h)</div>
                      <div className="font-semibold">
                        ${costEstimate.cost_per_month.toFixed(2)}/mo
                      </div>
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground pt-1 border-t">
                    Resource Tier: <strong>{costEstimate.tier || 'Unknown'}</strong>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Physical Fleet Info */}
          {formData.fleet_type === 'physical' && (
            <div className="p-4 border rounded-lg bg-muted/50">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-blue-600 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">Physical Fleet</p>
                  <p className="text-xs text-muted-foreground">
                    Physical fleets are for organizing existing hardware devices.
                    After creation, you can assign devices from your device list
                    to this fleet. No billing applies to physical fleets.
                  </p>
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || !formData.fleet_name}>
              {isSubmitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Create Fleet
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
