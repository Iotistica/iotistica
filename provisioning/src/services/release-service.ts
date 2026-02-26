/**
 * Release Service
 * Fetches the current stable release version from GitHub
 */

import axios from 'axios';
import { logger } from '../utils/logger';

interface GitHubRelease {
  tag_name: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
}

export class ReleaseService {
  private repoOwner = 'Iotistica';
  private repoName = 'iotistic';
  private cachedVersion: string | null = null;
  private cacheTimestamp: number = 0;
  private cacheTTL = 5 * 60 * 1000; // 5 minutes

  /**
   * Get the current stable release version from GitHub
   * Uses caching to avoid excessive API calls
   */
  async getCurrentStableRelease(): Promise<string> {
    // Return cached version if still valid
    if (this.cachedVersion && Date.now() - this.cacheTimestamp < this.cacheTTL) {
      logger.info('Using cached release version', { version: this.cachedVersion });
      return this.cachedVersion;
    }

    try {
      logger.info('Fetching latest release from GitHub', {
        repo: `${this.repoOwner}/${this.repoName}`,
      });

      const response = await axios.get<GitHubRelease>(
        `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases/latest`,
        {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'Iotistic-Provisioning-Service',
            ...(process.env.GITOPS_PAT && {
              Authorization: `Bearer ${process.env.GITOPS_PAT}`,
            }),
          },
          timeout: 10000, // 10 second timeout
        }
      );

      const release = response.data;

      // Validate that it's a stable release (not draft or prerelease)
      if (release.draft || release.prerelease) {
        logger.warn('Latest release is draft or prerelease, fetching stable releases', {
          tagName: release.tag_name,
          draft: release.draft,
          prerelease: release.prerelease,
        });
        return this.getLatestStableRelease();
      }

      const version = release.tag_name;
      logger.info('Fetched latest stable release', {
        version,
        name: release.name,
        publishedAt: release.published_at,
      });

      // Cache the version
      this.cachedVersion = version;
      this.cacheTimestamp = Date.now();

      return version;
    } catch (error: any) {
      logger.error('Failed to fetch release from GitHub', {
        error: error.message,
        repo: `${this.repoOwner}/${this.repoName}`,
      });

      // Fallback to cached version if available
      if (this.cachedVersion) {
        logger.warn('Using stale cached version due to fetch error', {
          version: this.cachedVersion,
        });
        return this.cachedVersion;
      }

      // No cache available - fail with connection diagnostics
      logger.error('GitHub connection failed and no cache available', {
        hint: 'Run: provisioning/scripts/test-github-connection.ps1 to diagnose',
      });
      throw new Error('Failed to fetch release version from GitHub and no cached version available');
    }
  }

  /**
   * Get the latest stable release (non-draft, non-prerelease)
   * Used as fallback when /releases/latest returns a prerelease
   */
  private async getLatestStableRelease(): Promise<string> {
    try {
      const response = await axios.get<GitHubRelease[]>(
        `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases`,
        {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'Iotistic-Provisioning-Service',
          },
          params: {
            per_page: 100, // Fetch up to 100 releases
          },
          timeout: 10000,
        }
      );

      // Find first stable release (not draft, not prerelease)
      const stableRelease = response.data.find(
        (release) => !release.draft && !release.prerelease
      );

      if (!stableRelease) {
        throw new Error('No stable releases found');
      }

      const version = stableRelease.tag_name;
      logger.info('Found latest stable release', {
        version,
        name: stableRelease.name,
        publishedAt: stableRelease.published_at,
      });

      // Cache the version
      this.cachedVersion = version;
      this.cacheTimestamp = Date.now();

      return version;
    } catch (error: any) {
      logger.error('Failed to fetch stable releases', { error: error.message });

      // Fallback to cached version if available
      if (this.cachedVersion) {
        logger.warn('Using cached version due to fetch error', {
          version: this.cachedVersion,
        });
        return this.cachedVersion;
      }

      // No cache available - throw error
      throw new Error('Failed to fetch stable release from GitHub and no cached version available');
    }
  }

  /**
   * Clear the cached version (useful for testing or forced refresh)
   */
  clearCache(): void {
    this.cachedVersion = null;
    this.cacheTimestamp = 0;
    logger.info('Release version cache cleared');
  }
}

// Export singleton instance
export const releaseService = new ReleaseService();
