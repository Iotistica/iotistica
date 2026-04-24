import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { buildApiUrl } from '../config/api';
import { auth0Config } from '../config/auth0';

interface User {
  id: number;
  username: string;
  email: string;
  name?: string; // Display name from Auth0
  role: string;
  isActive: boolean;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (accessToken: string, refreshToken: string, user: User) => void;
  loginWithAuth0Credentials: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshToken: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const handleTokensCleared = () => {
      localStorage.removeItem('user');
      setUser(null);
      setIsLoading(false);
    };

  // Universal Login: No local login, just redirect
  const login = () => {
    const config = getConfig();
    const params = new URLSearchParams({
      client_id: config.VITE_AUTH0_CLIENT_ID,
      response_type: 'code',
      redirect_uri: config.VITE_AUTH0_CALLBACK_URL,
      scope: 'openid profile email',
      audience: config.VITE_AUTH0_AUDIENCE || '',
    });
    window.location.href = `https://${config.VITE_AUTH0_DOMAIN}/authorize?${params.toString()}`;
  };

  const logout = () => {
    const config = getConfig();
    const returnTo = encodeURIComponent(window.location.origin);
    window.location.href = `https://${config.VITE_AUTH0_DOMAIN}/v2/logout?client_id=${config.VITE_AUTH0_CLIENT_ID}&returnTo=${returnTo}`;
  };

  const value: AuthContextType = {
    user,
    loading,
    error,
    login,
    logout,
    setUser,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
}
