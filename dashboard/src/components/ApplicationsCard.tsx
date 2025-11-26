import { useState } from "react";
import { Plus, CheckCircle2, XCircle, Clock, Play, Pause, MoreVertical, Pen,  Trash2 } from "lucide-react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { useDeviceState } from "@/contexts/DeviceStateContext";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { toast } from "sonner";
import { buildApiUrl } from "@/config/api";
import { canPerformDeviceActions, getDisabledActionMessage } from "@/utils/devicePermissions";
import { useEffect } from "react";

export interface Service {
  serviceId: number;
  serviceName: string;
  imageName: string;
  appId: number;
  appName: string;
  config: {
    image: string;
    ports?: string[];
    environment?: Record<string, string>;
    volumes?: string[];
    labels?: Record<string, string>;
    [key: string]: any;
  };
  status?: "running" | "stopped" | "paused" | "syncing" | "pending";
  state?: "running" | "stopped" | "paused"; // Target state for agent
  uptime?: string;
}

export interface Application {
  id: string;
  appId: number;
  appName: string;
  name: string; // Alias for appName for backward compatibility
  image: string;
  status: "running" | "stopped" | "syncing";
  syncStatus: "synced" | "syncing" | "error" | "pending";
  port?: string;
  uptime?: string;
  services: Service[];
}

const statusColors = {
  running: "bg-green-100 text-green-700 border-green-200",
  stopped: "bg-gray-100 text-gray-700 border-gray-200",
  paused: "bg-yellow-100 text-yellow-700 border-yellow-200",
  syncing: "bg-blue-100 text-blue-700 border-blue-200",
  pending: "bg-yellow-100 text-yellow-700 border-yellow-200",
};

const syncStatusIcons = {
  synced: CheckCircle2,
  syncing: Clock,
  error: XCircle,
  pending: Clock,
};

interface ApplicationsCardProps {
  deviceUuid: string;
  deviceStatus?: "online" | "offline" | "warning" | "pending";
}

export function ApplicationsCard({
  deviceUuid,
  deviceStatus = "online",
}: ApplicationsCardProps) {
  // Use context for state management
  const {
    getPendingApps,
    getTargetApps,
    updatePendingService,
    addPendingApp,
    updatePendingApp,
    removePendingApp,
    hasPendingChanges,
    getSyncStatus,
  } = useDeviceState();

  // Get apps from context (pending if exists, otherwise target)
  const pendingApps = getPendingApps(deviceUuid);
  const targetApps = getTargetApps(deviceUuid);
  const apps = Object.keys(pendingApps).length > 0 ? pendingApps : targetApps;
  const hasUnsavedChanges = hasPendingChanges(deviceUuid);
  
  // Get sync status from context (compares versions)
  const syncStatus = getSyncStatus(deviceUuid);

  // Convert apps to Application format for UI
  const applications: Application[] = Object.entries(apps).map(([appId, app]) => ({
    id: appId,
    appId: app.appId,
    appName: app.appName,
    name: app.appName,
    image: app.services[0]?.imageName || "",
    status: app.services.some(s => s.state === "running") ? "running" as const : "stopped" as const,
    syncStatus: syncStatus, // Use centralized sync status
    services: app.services.map(s => ({
      ...s,
      appId: app.appId,
      appName: app.appName,
      status: s.state as "running" | "stopped" | "paused" | undefined,
      config: {
        image: s.imageName,
        ...s.config,
      },
    })),
  }));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingApp, setEditingApp] = useState<Application | null>(null);
  
  // Check if device actions are allowed
  const canAddApp = canPerformDeviceActions(deviceStatus);
  const disabledMessage = getDisabledActionMessage(deviceStatus);
  const [newApp, setNewApp] = useState({
    appId: "",
    appName: "",
  });

  // Service modal state
  const [serviceDialogOpen, setServiceDialogOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteAppConfirmOpen, setDeleteAppConfirmOpen] = useState(false);
  const [appToDelete, setAppToDelete] = useState<Application | null>(null);
  const [useCustomImage, setUseCustomImage] = useState(false);
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [selectedAppForService, setSelectedAppForService] = useState<Application | null>(null);
  const [newService, setNewService] = useState({
    serviceId: "",
    serviceName: "",
    imageName: "",
    ports: "",
    environment: "",
    volumes: "",
    labels: "",
  });

  // State for available Docker images from database
  const [availableImages, setAvailableImages] = useState<Array<{ value: string; label: string }>>([]);
  const [loadingImages, setLoadingImages] = useState(true);

  // Fetch available images from API on component mount
  useEffect(() => {
    const fetchImages = async () => {
      try {
        const response = await fetch(buildApiUrl('/api/v1/images?status=approved'));
        if (response.ok) {
          const data = await response.json();
          
          // Transform API response to dropdown format
          const imageOptions: Array<{ value: string; label: string }> = [];
          
          for (const image of data.images) {
            // Fetch tags for each image
            const tagsResponse = await fetch(buildApiUrl(`/api/v1/images/${image.id}`));
            if (tagsResponse.ok) {
              const imageData = await tagsResponse.json();
              const tags = imageData.tags || [];
              
              // Create option for each tag
              tags.forEach((tag: any) => {
                const fullImageName = image.namespace 
                  ? `${image.namespace}/${image.image_name}:${tag.tag}`
                  : `${image.image_name}:${tag.tag}`;
                
                const label = `${fullImageName}${image.description ? ' - ' + image.description : ''}`;
                imageOptions.push({ value: fullImageName, label });
              });
            }
          }
          
          // Sort alphabetically
          imageOptions.sort((a, b) => a.value.localeCompare(b.value));
          setAvailableImages(imageOptions);
        } else {
          console.error('Failed to fetch images:', response.status);
          toast.error('Failed to load available images');
        }
      } catch (error) {
        console.error('Error fetching images:', error);
        toast.error('Error loading images');
      } finally {
        setLoadingImages(false);
      }
    };

    fetchImages();
  }, []);

  const handleAddApplication = async () => {
    if (!newApp.appName) {
      toast.error("Please fill in all required fields");
      return;
    }

    if (editingApp) {
      // Update existing application
      updatePendingApp(deviceUuid, editingApp.appId.toString(), {
        appName: newApp.appName,
      });
      toast.success("Application updated (not saved yet - click Save Draft)");
    } else {
      // Get next unique app ID from API
      try {
        const response = await fetch(buildApiUrl('/api/v1/apps/next-id'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            appName: newApp.appName,
            metadata: { createdFrom: 'dashboard' }
          })
        });

        if (!response.ok) {
          throw new Error('Failed to generate app ID');
        }

        const { appId } = await response.json();

        // Ensure appId is a number
        const numericAppId = typeof appId === 'number' ? appId : parseInt(appId);
        console.log('🔢 App ID from API:', { appId, type: typeof appId, numeric: numericAppId });

        // Add new app using context
        addPendingApp(deviceUuid, {
          appId: numericAppId,
          appName: newApp.appName,
          services: [],
        });
        toast.success("Application added (not saved yet - click Save Draft)");
      } catch (error) {
        console.error('Error generating app ID:', error);
        toast.error("Failed to generate app ID");
        return;
      }
    }

    setNewApp({ appId: "", appName: "" });
    setEditingApp(null);
    setDialogOpen(false);
  };

  const openEditAppModal = (app: Application) => {
    setEditingApp(app);
    setNewApp({
      appId: app.appId.toString(),
      appName: app.appName,
    });
    setDialogOpen(true);
  };

  const openAddAppModal = () => {
    setEditingApp(null);
    setNewApp({ appId: "", appName: "" });
    setDialogOpen(true);
  };

  const openServiceModal = (app: Application, service?: Service) => {
    setSelectedAppForService(app);
    if (service) {
      setEditingService(service);
      setNewService({
        serviceId: service.serviceId.toString(),
        serviceName: service.serviceName,
        imageName: service.imageName,
        ports: service.config.ports?.join("\n") || "",
        environment: JSON.stringify(service.config.environment || {}, null, 2),
        volumes: service.config.volumes?.join("\n") || "",
        labels: JSON.stringify(service.config.labels || {}, null, 2),
      });
    } else {
      setEditingService(null);
      setNewService({
        serviceId: "",
        serviceName: "",
        imageName: "",
        ports: "",
        environment: "",
        volumes: "",
        labels: "",
      });
    }
    setServiceDialogOpen(true);
  };

  const handleSaveService = () => {
    // Validate required fields
    if (!selectedAppForService) {
      toast.error("No application selected");
      return;
    }
    
    if (!newService.serviceName) {
      toast.error("Service name is required");
      return;
    }
    
    if (!newService.imageName) {
      toast.error("Docker image is required");
      return;
    }

    try {
      // Service ID will be generated by backend API
      // When editing, keep existing ID; when creating new, backend generates via global_service_id_seq
      const serviceId = editingService?.serviceId || Date.now(); // Temp ID for new services
      
      const newServiceConfig = {
        serviceId: serviceId,
        serviceName: newService.serviceName,
        imageName: newService.imageName,
        config: {
          image: newService.imageName,
          ports: newService.ports ? newService.ports.split("\n").filter(p => p.trim()) : [],
          environment: newService.environment ? JSON.parse(newService.environment) : {},
          volumes: newService.volumes ? newService.volumes.split("\n").filter(v => v.trim()) : [],
          labels: newService.labels ? JSON.parse(newService.labels) : {},
        },
        state: editingService?.state || "stopped",
      };

      if (editingService) {
        // Edit existing service via context
        updatePendingService(
          deviceUuid, 
          selectedAppForService.appId.toString(), 
          editingService.serviceId, 
          newServiceConfig
        );
        toast.success("Service updated (not saved yet - click Save Draft)");
      } else {
        // Add new service via context - need to update the entire app
        const pendingApps = getPendingApps(deviceUuid);
        const targetApps = getTargetApps(deviceUuid);
        const allApps = Object.keys(pendingApps).length > 0 ? pendingApps : targetApps;
        const currentApp = allApps[selectedAppForService.appId.toString()];
        const updatedServices = [...(currentApp?.services || []), newServiceConfig];
        
        updatePendingApp(deviceUuid, selectedAppForService.appId.toString(), {
          services: updatedServices.sort((a, b) => a.serviceName.localeCompare(b.serviceName))
        });
        toast.success("Service added (not saved yet - click Save Draft)");
      }
      
      setServiceDialogOpen(false);
      setSelectedAppForService(null);
      setEditingService(null);
      setNewService({
        serviceId: "",
        serviceName: "",
        imageName: "",
        ports: "",
        environment: "",
        volumes: "",
        labels: "",
      });
    } catch (error) {
      console.error("Error saving service:", error);
      toast.error("Invalid JSON in environment or labels");
    }
  };


  const handleDeleteService = () => {
    if (!selectedAppForService || !editingService) {
      return;
    }

    // Remove service via context - update app with filtered services
    const pendingApps = getPendingApps(deviceUuid);
    const targetApps = getTargetApps(deviceUuid);
    const allApps = Object.keys(pendingApps).length > 0 ? pendingApps : targetApps;
    const currentApp = allApps[selectedAppForService.appId.toString()];
    const updatedServices = currentApp?.services.filter((s: any) => s.serviceId !== editingService.serviceId) || [];
    
    updatePendingApp(deviceUuid, selectedAppForService.appId.toString(), {
      services: updatedServices
    });
    
    // Close dialogs and reset state
    setDeleteConfirmOpen(false);
    setServiceDialogOpen(false);
    setSelectedAppForService(null);
    setEditingService(null);
    setNewService({
      serviceId: "",
      serviceName: "",
      imageName: "",
      ports: "",
      environment: "",
      volumes: "",
      labels: "",
    });
    
    toast.success(`Service "${editingService.serviceName}" deleted (not saved yet - click Save Draft)`);
  };

  const handleRemoveApplication = () => {
    if (!appToDelete) {
      return;
    }

    removePendingApp(deviceUuid, appToDelete.appId.toString());
    toast.success(`${appToDelete.appName || appToDelete.name} removed (not saved yet - click Save Draft)`);
    
    setDeleteAppConfirmOpen(false);
    setAppToDelete(null);
  };

  return (
    <>
      <Card className="p-4 md:p-6">
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-lg text-foreground font-medium">Applications</h3>
            <div className="flex gap-2">
              <Button 
                onClick={openAddAppModal} 
                size="sm" 
                className="flex-shrink-0"
                // disabled={!canAddApp}
                title={!canAddApp ? disabledMessage : undefined}
              >
                <Plus className="w-4 h-4 mr-2" />
                Add App
              </Button>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Docker containers and services
            {hasUnsavedChanges && (
              <span className="ml-2 text-yellow-600 font-medium">
                • Unsaved changes
              </span>
            )}
          </p>
        </div>

        {applications.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <p>No applications deployed</p>
            <p className="text-sm mt-1">Click "Add App" to deploy a service</p>
          </div>
        ) : (
          <div className="space-y-3">
            {applications.map((app) => {
              const SyncIcon = syncStatusIcons[app.syncStatus];
              return (
                <div
                  key={app.id}
                  className="border border-border rounded-lg overflow-hidden hover:border-muted-foreground/20 transition-colors"
                >
                  {/* Application Header */}
                  <div className="p-3 bg-muted space-y-3">
                    {/* Title Row */}
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <h4 className="text-foreground font-medium mb-1">{app.appName || app.name}</h4>
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="flex items-center gap-1">
                            <SyncIcon className={`w-3 h-3 ${
                              app.syncStatus === "synced" ? "text-green-600" :
                              app.syncStatus === "error" ? "text-red-600" :
                              app.syncStatus === "syncing" ? "text-blue-600" :
                              "text-yellow-600"
                            }`} />
                            <span className={`text-xs ${
                              app.syncStatus === "synced" ? "text-green-600" :
                              app.syncStatus === "error" ? "text-red-600" :
                              app.syncStatus === "syncing" ? "text-blue-600" :
                              "text-yellow-600"
                            }`}>
                              {app.syncStatus}
                            </span>
                          </div>
                          {app.services && app.services.length > 0 && (
                            <>
                              <span className="text-muted-foreground">•</span>
                              <span className="text-sm text-gray-500">
                                {app.services.length} service{app.services.length !== 1 ? 's' : ''}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground h-8 w-8 flex-shrink-0">
                            <MoreVertical className="w-4 h-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                    
                          <DropdownMenuItem
                            onClick={() => openServiceModal(app)}
                          >
                            <Plus className="w-4 h-4 mr-2" />
                            Add Service
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => openEditAppModal(app)}
                            disabled={app.syncStatus === "syncing" || app.syncStatus === "pending"}
                          >
                            <Pen className="w-4 h-4 mr-2" />
                            Edit {(app.syncStatus === "syncing" || app.syncStatus === "pending") && "(locked during sync)"}
                          </DropdownMenuItem>
                        
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-red-600"
                            onClick={() => {
                              setAppToDelete(app);
                              setDeleteAppConfirmOpen(true);
                            }}
                          >
                            <Trash2 className="w-4 h-4 mr-2" />
                            Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  {/* Services List */}
                  {app.services && app.services.length > 0 && (
                    <div className="border-t border-border bg-card">
                      <div className="p-3 space-y-2">
                        <h5 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Services</h5>
                        {app.services.map((service, idx) => (
                          <div key={`${service.serviceId}-${idx}`} className="bg-card rounded p-2 border border-border">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="font-medium text-foreground text-sm">{service.serviceName}</span>
                                  {service.status && (
                                    <Badge variant="outline" className={`text-xs ${statusColors[service.status]}`}>
                                      {service.status}
                                    </Badge>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    updatePendingService(deviceUuid, app.appId.toString(), service.serviceId, {
                                      state: "running"
                                    });
                                    toast.success("Service set to running (not saved yet - click Save Draft)");
                                  }}
                                  disabled={service.status === "running" || service.status === "syncing" || app.syncStatus === "pending" || app.syncStatus === "syncing"}
                                  className={`h-8 w-8 p-0 ${
                                    service.status === "running" || service.status === "syncing" || app.syncStatus === "pending" || app.syncStatus === "syncing"
                                      ? "border-border bg-muted text-muted-foreground cursor-not-allowed"
                                      : "border-green-300 bg-green-50 text-green-700 hover:bg-green-100 hover:border-green-400"
                                  }`}
                                  title={app.syncStatus === "pending" || app.syncStatus === "syncing" ? "Cannot start while app is pending or syncing deployment" : "Start (unpause or start stopped service)"}
                                >
                                  <Play className="w-4 h-4" />
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    updatePendingService(deviceUuid, app.appId.toString(), service.serviceId, {
                                      state: "paused"
                                    });
                                    toast.success("Service set to paused (not saved yet - click Save Draft)");
                                  }}
                                  disabled={service.status === "paused" || service.status === "stopped" || service.status === "syncing" || !service.status || app.syncStatus === "pending" || app.syncStatus === "syncing"}
                                  className={`h-8 w-8 p-0 ${
                                    service.status === "paused" || service.status === "stopped" || service.status === "syncing" || !service.status || app.syncStatus === "pending" || app.syncStatus === "syncing"
                                      ? "border-gray-200 bg-gray-50 text-gray-400 cursor-not-allowed"
                                      : "border-yellow-300 bg-yellow-50 text-yellow-700 hover:bg-yellow-100 hover:border-yellow-400"
                                  }`}
                                  title={app.syncStatus === "pending" || app.syncStatus === "syncing" ? "Cannot pause while app is pending or syncing deployment" : "Pause"}
                                >
                                  <Pause className="w-4 h-4" />
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => openServiceModal(app, service)}
                                  disabled={app.syncStatus === "syncing" || app.syncStatus === "pending"}
                                  className={`h-8 w-8 p-0 ${
                                    app.syncStatus === "syncing" || app.syncStatus === "pending"
                                      ? "border-gray-200 bg-gray-50 text-gray-400 cursor-not-allowed"
                                      : ""
                                  }`}
                                  title={app.syncStatus === "syncing" || app.syncStatus === "pending" ? "Cannot edit while syncing or pending deployment" : "Edit"}
                                >
                                  <Pen className="w-4 h-4" />
                                </Button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Add/Edit Application Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => {
        setDialogOpen(open);
        if (!open) {
          setEditingApp(null);
          setNewApp({ appId: "", appName: "" });
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingApp ? "Edit Application" : "Add Application"}</DialogTitle>
            <DialogDescription>
              {editingApp 
                ? "Update the application name" 
                : "Create a new application container. Services can be added to the application after creation."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="app-name">Application Name *</Label>
              <Input
                id="app-name"
                placeholder="web-server"
                value={newApp.appName}
                onChange={(e) => setNewApp({ ...newApp, appName: e.target.value })}
              />
              <p className="text-xs text-gray-500">Descriptive name for the application (e.g., web-server, database, api-gateway).{!editingApp && " An ID will be automatically assigned."}</p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setDialogOpen(false);
              setEditingApp(null);
              setNewApp({ appId: "", appName: "" });
            }}>
              Cancel
            </Button>
            <Button onClick={handleAddApplication}>
              {editingApp ? "Update Application" : "Add Application"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add/Edit Service Dialog */}
      <Dialog open={serviceDialogOpen} onOpenChange={setServiceDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingService ? "Edit Service" : "Add Service"}</DialogTitle>
            <DialogDescription>
              {editingService 
                ? "Update service configuration" 
                : `Add a new service to ${selectedAppForService?.appName || "application"}`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="service-name">Service Name *</Label>
              <Input
                id="service-name"
                placeholder="nginx-web"
                value={newService.serviceName}
                onChange={(e) => setNewService({ ...newService, serviceName: e.target.value })}
              />
              <p className="text-xs text-gray-500">Descriptive service name</p>
            </div>

             <div className="space-y-2">
              <Label htmlFor="app-image">Docker Image *</Label>
              {!useCustomImage ? (
                <>
                  <Select
                    value={newService.imageName}
                    onValueChange={(value) => setNewService({ ...newService, imageName: value })}
                    disabled={loadingImages}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={loadingImages ? "Loading images..." : "Select a Docker image"} />
                    </SelectTrigger>
                    <SelectContent>
                      {loadingImages ? (
                        <div className="p-4 text-center text-sm text-muted-foreground">
                          Loading available images...
                        </div>
                      ) : availableImages.length === 0 ? (
                        <div className="p-4 text-center text-sm text-muted-foreground">
                          No approved images available
                        </div>
                      ) : (
                        availableImages.map((img) => (
                          <SelectItem key={img.value} value={img.value}>
                            {img.label}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => setUseCustomImage(true)}
                    className="px-0 h-auto"
                  >
                    Or enter custom image
                  </Button>
                </>
              ) : (
                <>
                  <Input
                    id="app-image-custom"
                    placeholder="your-registry/image:tag"
                    value={newService.imageName}
                    onChange={(e) => setNewService({ ...newService, imageName: e.target.value })}
                  />
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => setUseCustomImage(false)}
                    className="px-0 h-auto"
                  >
                    Choose from popular images
                  </Button>
                </>
              )}
            </div>


            <div className="space-y-2">
              <Label htmlFor="service-ports">Ports</Label>
              <Textarea
                id="service-ports"
                placeholder="8080:80&#10;8443:443"
                value={newService.ports}
                onChange={(e) => setNewService({ ...newService, ports: e.target.value })}
                rows={3}
              />
              <p className="text-xs text-gray-500">One port mapping per line (format: host:container)</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="service-environment">Environment Variables (JSON)</Label>
              <Textarea
                id="service-environment"
                placeholder='{\n  "NODE_ENV": "production",\n  "API_KEY": "secret"\n}'
                value={newService.environment}
                onChange={(e) => setNewService({ ...newService, environment: e.target.value })}
                rows={4}
                className="font-mono text-sm"
              />
              <p className="text-xs text-gray-500">JSON object with environment variables</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="service-volumes">Volumes</Label>
              <Textarea
                id="service-volumes"
                placeholder="/host/path:/container/path&#10;my-volume:/app/data"
                value={newService.volumes}
                onChange={(e) => setNewService({ ...newService, volumes: e.target.value })}
                rows={3}
              />
              <p className="text-xs text-gray-500">One volume mount per line</p>
            </div>

           
          </div>

          <DialogFooter className="gap-2">
            <div className="flex-1">
              {editingService && (
                <Button 
                  variant="destructive" 
                  onClick={() => setDeleteConfirmOpen(true)}
                  className="mr-auto"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete Service
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setServiceDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleSaveService}>
                {editingService ? "Update Service" : "Add Service"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Service Confirmation Dialog */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Service</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the service <strong>"{editingService?.serviceName}"</strong>? 
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteService}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Application Confirmation Dialog */}
      <AlertDialog open={deleteAppConfirmOpen} onOpenChange={setDeleteAppConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Application</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the application <strong>"{appToDelete?.appName || appToDelete?.name}"</strong>? 
              This will remove all associated services and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemoveApplication}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
