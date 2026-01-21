import { useState, useEffect } from "react";
import { Server, User, LogIn, Settings, HelpCircle, LogOut, RefreshCw, XCircle, Save, MessageSquare, Tag, Building2 } from "lucide-react";
import { Button } from "./ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { toast } from "sonner";
import { ThemeToggle } from "./theme-toggle";
import { useDeviceState } from "../contexts/DeviceStateContext";
import { AIChatWidget } from "./AIChatWidget";

interface HeaderProps {
  isAuthenticated?: boolean;
  onLogout?: () => void;
  userEmail?: string;
  userName?: string;
  deviceUuid?: string; // Device UUID for deployment operations
  onAccountClick?: () => void; // Callback for opening account page
  onUsersClick?: () => void; // Callback for opening user management page
  onProfileClick?: () => void; // Callback for opening profile page
  onTagDefinitionsClick?: () => void; // Callback for opening tag definitions page
  onDigitalTwinClick?: () => void; // Callback for opening digital twin page
  userRole?: string; // User role for conditional UI
}

export function Header({
  isAuthenticated = true,
  onLogout = () => {},
  userEmail = "john.doe@company.com",
  userName = "John Doe",
  deviceUuid,
  onAccountClick = () => {},
  onUsersClick = () => {},
  onProfileClick = () => {},
  onTagDefinitionsClick = () => {},
  onDigitalTwinClick = () => {},
  userRole = 'viewer'
}: HeaderProps) {
  // AI Chat state
  const [isChatOpen, setIsChatOpen] = useState(false);
  
  // Force re-render when sensor config changes
  const [, forceUpdate] = useState({});
  
  // Get deployment status and functions from context
  const { syncTargetState, cancelDeployment, hasPendingChanges, saveTargetState, getDeviceState } = useDeviceState();
  
  const needsDeployment = deviceUuid ? hasPendingChanges(deviceUuid) : false;
  const deviceState = deviceUuid ? getDeviceState(deviceUuid) : null;
  const hasUnsavedChanges = deviceState?.isDirty || false;
  
  const handleDeploy = async () => {
    if (!deviceUuid) {
      toast.error("No device selected");
      return;
    }
    
    try {
      // If there are unsaved changes, save them first
      if (hasUnsavedChanges) {
        toast.info("Saving changes...");
        try {
          await saveTargetState(deviceUuid);
          toast.success("Changes saved");
        } catch (saveError: any) {
          console.error("Save error:", saveError);
          toast.error(`Failed to save changes: ${saveError.message || 'Unknown error'}`);
          throw saveError; // Stop deployment if save fails
        }
      }
      
      // Then deploy
      const toastId = toast.loading("Deploying changes...");
      
      try {
        await syncTargetState(deviceUuid, 'dashboard');
        
        // Emit event so SensorsPage can refresh immediately
        window.dispatchEvent(new CustomEvent('deployment-started', { detail: { deviceUuid } }));
        
        toast.success("Changes deployed - waiting for agent confirmation", { id: toastId });
      } catch (deployError: any) {
        console.error("Deployment error:", deployError);
        toast.error(`Deployment failed: ${deployError.message || 'Unknown error'}`, { id: toastId });
        throw deployError;
      }
    } catch (error: any) {
      // Error already handled in nested try-catch blocks
      // This outer catch is just to prevent unhandled promise rejection
    }
  };
  
  const handleCancelDeploy = async () => {
    if (!deviceUuid) {
      toast.error("No device selected");
      return;
    }
    
    try {
      await cancelDeployment(deviceUuid);
      toast.success("Deployment cancelled");
    } catch (error) {
      toast.error("Failed to cancel deployment");
      console.error("Cancel deployment error:", error);
    }
  };
  
  const handleSaveDraft = async () => {
    if (!deviceUuid) {
      toast.error("No device selected");
      return;
    }
    
    try {
      await saveTargetState(deviceUuid);
      toast.success("Changes saved as draft");
    } catch (error) {
      toast.error("Failed to save draft");
      console.error("Save draft error:", error);
    }
  };
  
  return (
    <header className="bg-card border-b border-border sticky top-0 z-50">
      <div className="px-4 md:px-6 py-3 flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-blue-600 to-purple-600 rounded-lg flex items-center justify-center">
            <Server className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-extrabold text-foreground leading-tight">Iotistica</h1>
            <p className="text-xs text-muted-foreground hidden sm:block">Your Device Management Platform</p>
          </div>
        </div>

        {/* Right Side - Deploy Button + Profile/Login */}
        <div className="flex items-center gap-3">
          {isAuthenticated ? (
            <>
              {/* Save Draft + Deploy Buttons + AI Chat */}
              <div className="flex items-center gap-2">
                {hasUnsavedChanges && (
                  <Button 
                    onClick={handleSaveDraft}
                    size="lg"
                    variant="outline"
                    className="border-yellow-300 bg-yellow-50 text-yellow-700 hover:bg-yellow-100 font-semibold shadow-md"
                    style={{ 
                      padding: '0.75rem 1.5rem',
                      fontSize: '1rem'
                    }}
                  >
                    <Save className="w-5 h-5 mr-2" />
                    Save Draft
                  </Button>
                )}
                <Button 
                  onClick={handleDeploy}
                  size="lg"
                  disabled={!needsDeployment}
                  style={{ 
                    backgroundColor: needsDeployment ? '#ca8a04' : '#9ca3af',
                    color: 'white',
                    padding: '0.75rem 1.5rem',
                    fontSize: '1rem'
                  }}
                  className="font-semibold shadow-md"
                >
                  <RefreshCw className="w-6 h-6 mr-2" />
                  Sync
                </Button>
                {needsDeployment && (
                  <Button 
                    onClick={handleCancelDeploy}
                    size="sm"
                    variant="outline"
                  >
                    <XCircle className="w-4 h-4 mr-2" />
                    Cancel
                  </Button>
                )}
                
                {/* AI Chat Button */}
                {deviceUuid && (
                  <Button
                    onClick={() => setIsChatOpen(true)}
                    size="lg"
                    variant="outline"
                    className="border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 font-semibold shadow-md"
                    style={{ 
                      padding: '0.75rem 1.5rem',
                      fontSize: '1rem'
                    }}
                  >
                    <MessageSquare className="w-5 h-5 mr-2" />
                    AI Assistant
                  </Button>
                )}
              </div>

              <ThemeToggle />

              <Button
                variant="ghost"
                size="icon"
                className="hidden md:flex"
                onClick={() => toast.info("Help & Documentation")}
              >
                <HelpCircle className="w-5 h-5" />
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="flex items-center gap-2 px-2">
                    <Avatar className="w-8 h-8">
                      <AvatarImage src="https://api.dicebear.com/7.x/avataaars/svg?seed=${userName}" />
                      <AvatarFallback>{userName.split(' ').map(n => n[0]).join('')}</AvatarFallback>
                    </Avatar>
                    <span className="hidden md:inline text-foreground">{userName}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>
                    <div className="flex flex-col">
                      <span>{userName}</span>
                      <span className="text-muted-foreground">{userEmail}</span>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onProfileClick}>
                    <User className="w-4 h-4 mr-2" />
                    Profile
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onAccountClick}>
                    <Settings className="w-4 h-4 mr-2" />
                    Account & License
                  </DropdownMenuItem>
                  {(userRole === 'owner' || userRole === 'admin' || userRole === 'manager') && (
                    <>
                      <DropdownMenuItem onClick={onUsersClick}>
                        <User className="w-4 h-4 mr-2" />
                        User Management
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={onTagDefinitionsClick}>
                        <Tag className="w-4 h-4 mr-2" />
                        Tag Definitions
                      </DropdownMenuItem>
                    </>
                  )}
                  {/* <DropdownMenuItem onClick={onDigitalTwinClick}>
                    <Building2 className="w-4 h-4 mr-2" />
                    Digital Twin
                  </DropdownMenuItem> */}
                  <DropdownMenuItem onClick={() => toast.info("Opening help...")}>
                    <HelpCircle className="w-4 h-4 mr-2" />
                    Help & Support
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem 
                    onClick={() => {
                      onLogout();
                      toast.success("Logged out successfully");
                    }}
                  >
                    <LogOut className="w-4 h-4 mr-2" />
                    Log out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : (
            <Button onClick={() => toast.info("Login functionality")}>
              <LogIn className="w-4 h-4 mr-2" />
              Log in
            </Button>
          )}
        </div>
      </div>
      
      {/* AI Chat Widget */}
      {deviceUuid && (
        <AIChatWidget 
          deviceUuid={deviceUuid} 
          isOpen={isChatOpen} 
          onClose={() => setIsChatOpen(false)} 
        />
      )}
    </header>
  );
}
