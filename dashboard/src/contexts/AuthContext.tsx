import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { buildApiUrl } from '../config/api';

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

    window.addEventListener('auth:tokens-cleared', handleTokensCleared as EventListener);
    return () => {
      window.removeEventListener('auth:tokens-cleared', handleTokensCleared as EventListener);
    };
  }, []);

  // Initialize auth state from localStorage
  useEffect(() => {
    let isMounted = true; // Prevent state updates if unmounted

    const initAuth = async () => {
      const accessToken = localStorage.getItem('accessToken');
      const refreshTokenValue = localStorage.getItem('refreshToken');
      const storedUserJson = localStorage.getItem('user');

      if (storedUserJson) {
        try {
          const parsedUser = JSON.parse(storedUserJson) as User;
          if (isMounted) {
            setUser(parsedUser);
          }
        } catch {
          localStorage.removeItem('user');
        }
      }

      if (!accessToken || !refreshTokenValue) {
        if (isMounted) setIsLoading(false);
        return;
      }

      try {
        // Verify token by fetching current user
        const response = await fetch(buildApiUrl('/api/v1/auth/me'), {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        if (!isMounted) return; // Component unmounted, skip state updates

        if (response.ok) {
          const data = await response.json();
          setUser(data.data.user);
          localStorage.setItem('user', JSON.stringify(data.data.user));
        } else if (response.status === 401) {
          // Try to refresh token inline (avoid circular dependency)
          try {
            const refreshResponse = await fetch(buildApiUrl('/api/v1/auth/refresh'), {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ refreshToken: refreshTokenValue }),
            });

            if (!isMounted) return;

            if (refreshResponse.ok) {
              const refreshData = await refreshResponse.json();
              localStorage.setItem('accessToken', refreshData.data.accessToken);

              // Fetch updated user info
              const userResponse = await fetch(buildApiUrl('/api/v1/auth/me'), {
                headers: {
                  Authorization: `Bearer ${refreshData.data.accessToken}`,
                },
              });

              if (!isMounted) return;

              if (userResponse.ok) {
                const userData = await userResponse.json();
                setUser(userData.data.user);
                localStorage.setItem('user', JSON.stringify(userData.data.user));
              } else {
                // Keep tokens on transient/server errors; clear only on explicit unauthorized.
                if (userResponse.status === 401 || userResponse.status === 403) {
                  console.warn('User fetch unauthorized after token refresh, clearing tokens');
                  localStorage.removeItem('accessToken');
                  localStorage.removeItem('refreshToken');
                  localStorage.removeItem('user');
                  setUser(null);
                } else {
                  console.warn(`User fetch after refresh returned ${userResponse.status}; preserving auth state`);
                }
              }
            } else {
              // Clear only on explicit unauthorized/forbidden; preserve on transient errors.
              if (refreshResponse.status === 401 || refreshResponse.status === 403) {
                console.warn('Token refresh unauthorized during auth init, clearing tokens');
                localStorage.removeItem('accessToken');
                localStorage.removeItem('refreshToken');
                localStorage.removeItem('user');
                setUser(null);
              } else {
                console.warn(`Token refresh returned ${refreshResponse.status}; preserving auth state`);
              }
            }
          } catch (refreshError) {
            console.error('Token refresh error:', refreshError);
            console.warn('Exception during token refresh, preserving auth state for retry');
          }
        } else {
          // Preserve tokens on non-401 errors (e.g., deploy restart, 5xx)
          console.warn(`Auth verification returned status ${response.status}, preserving auth state`);
        }
      } catch (error) {
        console.error('Auth initialization error:', error);
        console.warn('Exception during auth init, preserving auth state for retry');
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    initAuth();

    return () => {
      isMounted = false; // Cleanup: prevent state updates after unmount
    };
  }, []); // Safe: no external dependencies

  const login = (accessToken: string, refreshTokenValue: string, userData: User) => {
    localStorage.setItem('accessToken', accessToken);
    localStorage.setItem('refreshToken', refreshTokenValue);
    localStorage.setItem('user', JSON.stringify(userData));
    setUser(userData);
  };

  const loginWithAuth0Credentials = async (email: string, password: string): Promise<void> => {
    const auth0Domain = import.meta.env.VITE_AUTH0_DOMAIN;
    const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID;
    const audience = import.meta.env.VITE_AUTH0_AUDIENCE;

    if (!auth0Domain || !clientId) {
      throw new Error('Auth0 configuration missing');
    }

    // Use Resource Owner Password Grant to get tokens from Auth0
    const response = await fetch(`https://${auth0Domain}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        username: email,
        password,
        audience,
        grant_type: 'http://auth0.com/oauth/grant-type/password-realm',
        realm: 'Username-Password-Authentication',
        scope: 'openid profile email offline_access',
      }),
    });

    let data: any = null;
    try {
      data = await response.json();
    } catch {
      throw new Error('Failed to parse Auth0 response');
    }

    if (!response.ok) {
      throw new Error(data?.error_description || data?.error || 'Authentication failed');
    }

    if (!data?.access_token) {
      throw new Error('No access token returned from Auth0');
    }

    // Fetch user info from Auth0
    const userInfoResponse = await fetch(`https://${auth0Domain}/userinfo`, {
      headers: {
        Authorization: `Bearer ${data.access_token}`,
      },
    });

    let userInfo: any = null;
    try {
      userInfo = await userInfoResponse.json();
    } catch {
      throw new Error('Failed to fetch user info');
    }

    if (!userInfoResponse.ok) {
      throw new Error('Failed to fetch user information from Auth0');
    }

    // Create local user object from Auth0 info
    const user: User = {
      id: 0,
      username: userInfo.email || userInfo.sub,
      email: userInfo.email,
      name: userInfo.name,
      role: 'user',
      isActive: true,
    };

    login(data.access_token, data.refresh_token || '', user);
  };

  const logout = async () => {
    const accessToken = localStorage.getItem('accessToken');
    const refreshTokenValue = localStorage.getItem('refreshToken');

    // Call logout endpoint to revoke tokens
    if (accessToken && refreshTokenValue) {
      try {
        await fetch(buildApiUrl('/api/v1/auth/logout'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ refreshToken: refreshTokenValue }),
        });
      } catch (error) {
        console.error('Logout error:', error);
      }
    }

    // Clear local state
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
    localStorage.removeItem('selectedDeviceId');
    setUser(null);

    // Redirect to Auth0 logout
    const auth0Domain = import.meta.env.VITE_AUTH0_DOMAIN;
    const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID;
    const returnTo = window.location.origin; // Redirect back to home page

    if (auth0Domain && clientId) {
      window.location.href = `https://${auth0Domain}/v2/logout?client_id=${clientId}&returnTo=${encodeURIComponent(returnTo)}`;
    }
  };

  const refreshToken = async (): Promise<boolean> => {
    const refreshTokenValue = localStorage.getItem('refreshToken');

    if (!refreshTokenValue) {
      return false;
    }

    try {
      const response = await fetch(buildApiUrl('/api/v1/auth/refresh'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refreshToken: refreshTokenValue }),
      });

      if (!response.ok) {
        return false;
      }

      const data = await response.json();
      localStorage.setItem('accessToken', data.data.accessToken);

      // Fetch updated user info
      const userResponse = await fetch(buildApiUrl('/api/v1/auth/me'), {
        headers: {
          Authorization: `Bearer ${data.data.accessToken}`,
        },
      });

      if (userResponse.ok) {
        const userData = await userResponse.json();
        setUser(userData.data.user);
      }

      return true;
    } catch (error) {
      console.error('Token refresh error:', error);
      return false;
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        login,
        loginWithAuth0Credentials,
        logout,
        refreshToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
