import { useEffect, useState, type RefObject } from 'react';

interface UseVisibilityStateOptions {
  rootMargin?: string;
  threshold?: number;
}

export function useVisibilityState<T extends Element>(
  targetRef: RefObject<T | null>,
  options?: UseVisibilityStateOptions,
): { isInViewport: boolean; isPageVisible: boolean } {
  const [isInViewport, setIsInViewport] = useState(true);
  const [isPageVisible, setIsPageVisible] = useState(
    typeof document === 'undefined' ? true : !document.hidden,
  );

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const handleVisibilityChange = () => {
      setIsPageVisible(!document.hidden);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    handleVisibilityChange();

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const target = targetRef.current;
    if (!target || typeof IntersectionObserver === 'undefined') {
      setIsInViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        setIsInViewport(Boolean(entry?.isIntersecting || (entry?.intersectionRatio ?? 0) > 0));
      },
      {
        rootMargin: options?.rootMargin ?? '240px 0px',
        threshold: options?.threshold ?? 0.01,
      },
    );

    observer.observe(target);

    return () => {
      observer.disconnect();
    };
  }, [options?.rootMargin, options?.threshold, targetRef]);

  return { isInViewport, isPageVisible };
}