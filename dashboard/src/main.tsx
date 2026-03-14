
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App.tsx";
import { CallbackPage } from "./pages/CallbackPage.tsx";
import { InviteAcceptPage } from "./pages/InviteAcceptPage.tsx";
import "./styles/globals.css";
import "./index.css";
import { ThemeProvider } from "./components/theme-provider";
import { DeviceStateProvider } from "./contexts/DeviceStateContext";
import { AuthProvider } from "./contexts/AuthContext";
import { MetricsHistoryProvider } from "./contexts/MetricsHistoryContext";
import { MqttProvider } from "./contexts/MqttContext";
import { SystemMetricsProvider } from "./contexts/SystemMetricsContext";
import { FleetProvider } from "./contexts/FleetContext";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
    <AuthProvider>
      <FleetProvider>
        <DeviceStateProvider>
          <MetricsHistoryProvider>
            <SystemMetricsProvider>
              <MqttProvider>
                <BrowserRouter>
                  <Routes>
                    <Route path="/auth/callback" element={<CallbackPage />} />
                    <Route path="/invite/accept" element={<InviteAcceptPage />} />
                    <Route path="/fleets/:fleetId/agents/:agentId/:view" element={<App />} />
                    <Route path="/fleets/:fleetId/agents/:agentId" element={<App />} />
                    <Route path="/fleets/:fleetId" element={<App />} />
                    <Route path="*" element={<App />} />
                  </Routes>
                </BrowserRouter>
              </MqttProvider>
            </SystemMetricsProvider>
          </MetricsHistoryProvider>
        </DeviceStateProvider>
      </FleetProvider>
    </AuthProvider>
  </ThemeProvider>
);