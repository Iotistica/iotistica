import { useState, useEffect } from "react";
import { Server, User, LogIn, Settings, HelpCircle, LogOut, MessageSquare, Tag, Building2 } from "lucide-react";
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
import { AIChatWidget } from "./AIChatWidget";

interface HeaderProps {
  isAuthenticated?: boolean;
  onLogout?: () => void;
  userEmail?: string;
  userName?: string;
  deviceUuid?: string; // Device UUID for deployment operations
  onHomeClick?: () => void; // Callback for navigating to home
  onAccountClick?: () => void; // Callback for opening account page
  onUsersClick?: () => void; // Callback for opening user management page
  onProfileClick?: () => void; // Callback for opening profile page
  onTagDefinitionsClick?: () => void; // Callback for opening tag definitions page
  onDigitalTwinClick?: () => void; // Callback for opening digital twin page
  userRole?: string; // User role for conditional UI
  // Deploy button props
  needsDeployment?: boolean;
  hasUnsavedChanges?: boolean;
  onDeploy?: () => void;
  onCancelDeploy?: () => void;
  onSaveDraft?: () => void;
  devicesWithPendingChanges?: number;
  onDeployAll?: () => void;
  isGlobalView?: boolean;
}

export function Header({
  isAuthenticated = true,
  onLogout = () => {},
  userEmail = "john.doe@company.com",
  userName = "John Doe",
  deviceUuid,
  onHomeClick = () => {},
  onAccountClick = () => {},
  onUsersClick = () => {},
  onProfileClick = () => {},
  onTagDefinitionsClick = () => {},
  userRole = 'viewer',
  needsDeployment = false,
  hasUnsavedChanges = false,
  onDeploy = () => {},
  onCancelDeploy = () => {},
  onSaveDraft = () => {},
  devicesWithPendingChanges = 0,
  onDeployAll = () => {},
  isGlobalView = false
}: HeaderProps) {
  // AI Chat state
  const [isChatOpen, setIsChatOpen] = useState(false);
  
  // Force re-render when sensor config changes
  const [, forceUpdate] = useState({});
  
  // Listen for sensor config changes (toggle events)
  useEffect(() => {
    const handleConfigChanged = (event: CustomEvent) => {
      if (event.detail.deviceUuid === deviceUuid) {
        console.log('Sensor config changed - refreshing Header state');
        forceUpdate({}); // Trigger re-render to update needsDeployment
      }
    };
    
    window.addEventListener('sensor-config-changed', handleConfigChanged as EventListener);
    
    return () => {
      window.removeEventListener('sensor-config-changed', handleConfigChanged as EventListener);
    };
  }, [deviceUuid]);
  
  return (
    <header className="bg-card border-b border-border sticky top-0 z-50">
      <div className="px-6 md:px-8 py-3 flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center cursor-pointer" onClick={onHomeClick}>
          <div className="leading-snug">
            <h1 style={{ fontSize: '40px' }} className="font-black tracking-tight">
              <span style={{ color: '#1e40af' }}>Iot</span>
              <span style={{ color: '#16a34a' }}>istica</span>
            </h1>
            <p style={{ fontSize: '1rem' }} className="font-semibold text-muted-foreground mt-1">Your Edge Management Platform</p>
          </div>
        </div>

        {/* Right Side - Deploy Button + Profile/Login */}
        <div className="flex items-center gap-3">
          {isAuthenticated ? (
            <>
              {/* Deploy Buttons - Only show for agent views */}
              {!isGlobalView && (
                <>
                  {hasUnsavedChanges && (
                    <Button
                      onClick={onSaveDraft}
                      size="sm"
                      variant="outline"
                      className="border-yellow-300 bg-yellow-50 text-yellow-700 hover:bg-yellow-100"
                      style={{ fontSize: '1.1rem', padding: '0.6rem 1.25rem' }}
                    >
                      Save Draft
                    </Button>
                  )}
                  <Button
                    onClick={onDeploy}
                    size="sm"
                    disabled={!needsDeployment}
                    variant="ghost"
                    style={needsDeployment ? {
                      backgroundColor: '#d97706',
                      color: 'white',
                      fontWeight: 500,
                      fontSize: '1.1rem',
                      padding: '0.6rem 1.25rem'
                    } : {
                      backgroundColor: '#9ca3af',
                      color: 'white',
                      cursor: 'not-allowed',
                      fontSize: '1.1rem',
                      padding: '0.6rem 1.25rem'
                    }}
                    className="hover:opacity-90"
                  >
                    Deploy
                  </Button>
                  {needsDeployment && (
                    <Button
                      onClick={onCancelDeploy}
                      size="sm"
                      variant="outline"
                      className="border-red-300 hover:bg-red-50 text-red-600"
                      style={{ fontSize: '1.1rem', padding: '0.6rem 1.25rem' }}
                    >
                      {hasUnsavedChanges && !needsDeployment ? 'Discard' : 'Cancel'}
                    </Button>
                  )}
                  {devicesWithPendingChanges > 1 && (
                    <Button
                      onClick={onDeployAll}
                      size="sm"
                      variant="ghost"
                      style={{
                        backgroundColor: '#ea580c',
                        color: 'white',
                        fontWeight: 600,
                        fontSize: '1.1rem',
                        padding: '0.6rem 1.25rem'
                      }}
                      className="hover:opacity-90"
                    >
                      Deploy All ({devicesWithPendingChanges})
                    </Button>
                  )}
                </>
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

              <ThemeToggle />

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
