
  import { createRoot } from "react-dom/client";
  import App from "./App.tsx";
  import "./styles/globals.css";
  import "./index.css";
  import { ThemeProvider } from "./components/theme-provider";
  import { DeviceStateProvider } from "./contexts/DeviceStateContext";
  import { AuthProvider } from "./contexts/AuthContext";
  import { MetricsHistoryProvider } from "./contexts/MetricsHistoryContext";
  import { MqttProvider } from "./contexts/MqttContext";
import { SystemMetricsProvider } from "./contexts/SystemMetricsContext";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
    <AuthProvider>
      <DeviceStateProvider>
        <MetricsHistoryProvider>
          <SystemMetricsProvider>
            <MqttProvider>
              <App />
            </MqttProvider>
          </SystemMetricsProvider>        </MetricsHistoryProvider>
      </DeviceStateProvider>
    </AuthProvider>
  </ThemeProvider>
);  