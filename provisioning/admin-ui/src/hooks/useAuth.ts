import { useCallback, useState } from 'react';

const TOKEN_KEY = 'admin_token';

export function useAuth() {
  const [token, setTokenState] = useState<string | null>(
    () => sessionStorage.getItem(TOKEN_KEY)
  );

  const setToken = useCallback((t: string) => {
    sessionStorage.setItem(TOKEN_KEY, t);
    setTokenState(t);
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    setTokenState(null);
  }, []);

  return { token, setToken, logout };
}
