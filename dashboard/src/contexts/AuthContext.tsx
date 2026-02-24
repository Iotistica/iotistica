import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { buildApiUrl } from '../config/api';

interface User {
  id: number;
  username: string;
  email: string;
  role: string;
  isActive: boolean;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (accessToken: string, refreshToken: string, user: User) => void;
  logout: () => void;
  refreshToken: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Initialize auth state from localStorage
  useEffect(() => {
    let isMounted = true; // Prevent state updates if unmounted

    const initAuth = async () => {
      const accessToken = localStorage.getItem('accessToken');
      const refreshTokenValue = localStorage.getItem('refreshToken');

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
              } else {
                // Failed to get user, clear tokens
                console.warn('Failed to fetch user after token refresh, clearing tokens');
                localStorage.removeItem('accessToken');
                localStorage.removeItem('refreshToken');
              }
            } else {
              // Refresh failed, clear tokens
              console.warn('Token refresh failed during auth init, clearing tokens');
              localStorage.removeItem('accessToken');
              localStorage.removeItem('refreshToken');
            }
          } catch (refreshError) {
            console.error('Token refresh error:', refreshError);
            if (isMounted) {
              console.warn('Exception during token refresh, clearing tokens');
              localStorage.removeItem('accessToken');
              localStorage.removeItem('refreshToken');
            }
          }
        } else {
          // Other error status, clear tokens
          console.warn(`Auth verification failed with status ${response.status}, clearing tokens`);
          localStorage.removeItem('accessToken');
          localStorage.removeItem('refreshToken');
        }
      } catch (error) {
        console.error('Auth initialization error:', error);
        if (isMounted) {
          console.warn('Exception during auth init, clearing tokens');
          localStorage.removeItem('accessToken');
          localStorage.removeItem('refreshToken');
        }
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
    setUser(userData);
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
    localStorage.removeItem('selectedDeviceId');
    setUser(null);
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
