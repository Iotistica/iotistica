import { createContext, ReactNode } from 'react';

interface AuthContextType {
  login: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  // Universal Login only
  const getConfig = () => ({
    VITE_AUTH0_DOMAIN: import.meta.env.VITE_AUTH0_DOMAIN,
    VITE_AUTH0_CLIENT_ID: import.meta.env.VITE_AUTH0_CLIENT_ID,
    VITE_AUTH0_CALLBACK_URL: import.meta.env.VITE_AUTH0_CALLBACK_URL,
    VITE_AUTH0_AUDIENCE: import.meta.env.VITE_AUTH0_AUDIENCE,
  });

  const login = () => {
    const config = getConfig();
    const params = new URLSearchParams({
      client_id: String(config.VITE_AUTH0_CLIENT_ID || ''),
      response_type: 'code',
      redirect_uri: String(config.VITE_AUTH0_CALLBACK_URL || ''),
      scope: 'openid profile email',
      audience: String(config.VITE_AUTH0_AUDIENCE || ''),
    });
    window.location.href = `https://${config.VITE_AUTH0_DOMAIN}/authorize?${params.toString()}`;
  };

  const logout = () => {
    const config = getConfig();
    const returnTo = encodeURIComponent(window.location.origin);
    window.location.href = `https://${config.VITE_AUTH0_DOMAIN}/v2/logout?client_id=${config.VITE_AUTH0_CLIENT_ID}&returnTo=${returnTo}`;
  };

  return (
    <AuthContext.Provider value={{ login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
