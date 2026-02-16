import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Trash2 } from "lucide-react";
import { buildApiUrl } from "../config/api";
import { toast } from "sonner";

interface Fleet {
  fleet_id: string;
  fleet_name: string;
  fleet_type: 'virtual' | 'physical' | 'mixed';
  environment: string;
  location: string | null;
  billing_enabled: boolean;
  budget_limit: string | null;
}

interface EditFleetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fleet: Fleet | null;
  onSuccess: () => void;
}

export function EditFleetDialog({ open, onOpenChange, fleet, onSuccess }: EditFleetDialogProps) {
  const [formData, setFormData] = useState({
    fleet_name: '',
    fleet_type: 'virtual' as 'virtual' | 'physical' | 'mixed',
    environment: 'dev',
    location: '',
    billing_enabled: false,
    budget_limit: '',
  });
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (fleet) {
      setFormData({
        fleet_name: fleet.fleet_name,
        fleet_type: fleet.fleet_type,
        environment: fleet.environment,
        location: fleet.location || '',
        billing_enabled: fleet.billing_enabled,
        budget_limit: fleet.budget_limit || '',
      });
    }
  }, [fleet]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fleet) return;

    setIsSaving(true);
    try {
      const token = localStorage.getItem('accessToken');
      const response = await fetch(buildApiUrl(`/api/v1/fleets/${fleet.fleet_id}`), {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ...formData,
          budget_limit: formData.budget_limit ? parseFloat(formData.budget_limit) : null,
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to update fleet');
      }

      toast.success('Fleet updated successfully');
      onSuccess();
      onOpenChange(false);
    } catch (error: any) {
      console.error('Error updating fleet:', error);
      toast.error(error.message || 'Failed to update fleet');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!fleet) return;

    setIsDeleting(true);
    try {
      const token = localStorage.getItem('accessToken');
      const response = await fetch(buildApiUrl(`/api/v1/fleets/${fleet.fleet_id}`), {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to delete fleet');
      }

      toast.success('Fleet deleted successfully');
      setShowDeleteConfirm(false);
      onSuccess();
      onOpenChange(false);
    } catch (error: any) {
      console.error('Error deleting fleet:', error);
      toast.error(error.message || 'Failed to delete fleet');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Fleet</DialogTitle>
          <DialogDescription>
            Update fleet configuration and settings
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="fleet_name">Fleet Name</Label>
              <Input
                id="fleet_name"
                value={formData.fleet_name}
                onChange={(e) => setFormData({ ...formData, fleet_name: e.target.value })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="fleet_type">Fleet Type</Label>
              <Select
                value={formData.fleet_type}
                onValueChange={(value: 'virtual' | 'physical' | 'mixed') =>
                  setFormData({ ...formData, fleet_type: value })
                }
              >
                <SelectTrigger id="fleet_type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="virtual">Virtual</SelectItem>
                  <SelectItem value="physical">Physical</SelectItem>
                  <SelectItem value="mixed">Mixed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="environment">Environment</Label>
              <Select
                value={formData.environment}
                onValueChange={(value) => setFormData({ ...formData, environment: value })}
              >
                <SelectTrigger id="environment">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dev">Development</SelectItem>
                  <SelectItem value="staging">Staging</SelectItem>
                  <SelectItem value="prod">Production</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="location">Location (Optional)</Label>
              <Input
                id="location"
                placeholder="e.g., US-East, EU-West"
                value={formData.location}
                onChange={(e) => setFormData({ ...formData, location: e.target.value })}
              />
            </div>

            {formData.fleet_type === 'virtual' && (
              <>
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="billing_enabled"
                    checked={formData.billing_enabled}
                    onChange={(e) => setFormData({ ...formData, billing_enabled: e.target.checked })}
                    className="w-4 h-4"
                  />
                  <Label htmlFor="billing_enabled" className="cursor-pointer">
                    Enable Billing
                  </Label>
                </div>

                {formData.billing_enabled && (
                  <div className="space-y-2">
                    <Label htmlFor="budget_limit">Budget Limit ($)</Label>
                    <Input
                      id="budget_limit"
                      type="number"
                      step="0.01"
                      placeholder="0.00"
                      value={formData.budget_limit}
                      onChange={(e) => setFormData({ ...formData, budget_limit: e.target.value })}
                    />
                  </div>
                )}
              </>
            )}
          </div>

          <DialogFooter>
            <div className="flex items-center justify-between w-full">
              <Button
                type="button"
                variant="destructive"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={isSaving || isDeleting}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Fleet
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isSaving || isDeleting}>
                  {isSaving ? 'Saving...' : 'Save Changes'}
                </Button>
              </div>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    {/* Delete Confirmation Dialog */}
    <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Fleet</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{fleet?.fleet_name}</strong>? This action cannot be undone and will:
            <ul className="mt-2 ml-4 list-disc text-sm">
              <li>Delete the Kubernetes namespace and all resources</li>
              <li>Remove all virtual agents in this fleet</li>
              <li>Remove all billing and usage data</li>
            </ul>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? 'Deleting...' : 'Delete Fleet'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
  );
}
