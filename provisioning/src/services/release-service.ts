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
  // Default accepts app tags like v1.2.3, v1.2.3-rc.1, v1.2.3+meta.
  // Override with RELEASE_DEPLOYABLE_TAG_REGEX if needed.
  private deployableTagPattern = new RegExp(
    process.env.RELEASE_DEPLOYABLE_TAG_REGEX || '^v\\d+\\.\\d+\\.\\d+(?:[-+].*)?$'
  );

  private isDeployableTag(tag: string): boolean {
    if (!tag) {
      return false;
    }

    // Guardrail: never allow provisioning release tags for customer workload images.
    if (tag.toLowerCase().startsWith('provisioning-')) {
      return false;
    }

    return this.deployableTagPattern.test(tag);
  }

  /**
   * Validate that the iotistic/api image exists on Docker Hub for the given version.
   * Prevents provisioning releases tagged with plain v*.*.* format from being
   * used for customer app deployments (api, ingestion, dashboard, nodered).
   */
  private async appImageExists(version: string): Promise<boolean> {
    try {
      const response = await axios.get(
        `https://hub.docker.com/v2/repositories/iotistic/api/tags/${encodeURIComponent(version)}/`,
        {
          timeout: 5000,
          validateStatus: () => true, // don't throw on 404
          headers: { 'User-Agent': 'Iotistica-Provisioning-Service' },
        }
      );
      return response.status === 200;
    } catch {
      // Network error — assume image exists to avoid blocking deployment
      return true;
    }
  }

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

      // Validate that it's deployable (stable + allowed tag format).
      if (release.draft || release.prerelease || !this.isDeployableTag(release.tag_name)) {
        logger.warn('Latest release is not deployable, fetching stable deployable release', {
          tagName: release.tag_name,
          draft: release.draft,
          prerelease: release.prerelease,
          deployable: this.isDeployableTag(release.tag_name),
        });
        return await this.getLatestStableRelease();
      }

      // Validate that the iotistic/api image actually exists for this tag.
      // Prevents provisioning-only releases (e.g. v1.0.2) from being used for app images.
      const imageExists = await this.appImageExists(release.tag_name);
      if (!imageExists) {
        logger.warn('Latest release has no iotistic/api image on Docker Hub, fetching stable deployable release', {
          tagName: release.tag_name,
        });
        return await this.getLatestStableRelease();
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

      throw new Error('Failed to fetch release version from GitHub and no cached version available');
    }
  }

  /**
   * Get the latest stable deployable release.
   * Used as fallback when /releases/latest is not deployable.
   */
  private async getLatestStableRelease(): Promise<string> {
    try {
      const response = await axios.get<GitHubRelease[]>(
        `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases`,
        {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'Iotistic-Provisioning-Service',
            ...(process.env.GITOPS_PAT && {
              Authorization: `Bearer ${process.env.GITOPS_PAT}`,
            }),
          },
          params: {
            per_page: 100,
          },
          timeout: 10000,
        }
      );

      // Find first deployable release that also has a real iotistic/api image.
      // Prereleases (e.g. rc.1) are allowed since all app releases may be prereleases;
      // only drafts and provisioning-prefixed tags are excluded.
      let stableRelease: GitHubRelease | undefined;
      for (const release of response.data) {
        if (release.draft || !this.isDeployableTag(release.tag_name)) {
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const imageExists = await this.appImageExists(release.tag_name);
        if (imageExists) {
          stableRelease = release;
          break;
        }
        logger.warn('Skipping release — no iotistic/api image found on Docker Hub', {
          tagName: release.tag_name,
        });
      }

      if (!stableRelease) {
        throw new Error('No deployable releases found with a published iotistic/api image');
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
