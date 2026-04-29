/**
 * Release Service
 * Fetches the current stable release version from GitHub
 */

import axios from 'axios';
import semver from 'semver';
import { logger } from '../utils/logger';

interface GitHubTag {
  name: string;
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
    process.env.RELEASE_DEPLOYABLE_TAG_REGEX || '^v\\d+\\.\\d+\\.\\d+$'
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
   * Get the current stable release version from GitHub.
   * Uses git tags as the source of truth (GitHub Releases are not required).
   */
  async getCurrentStableRelease(): Promise<string> {
    if (this.cachedVersion && Date.now() - this.cacheTimestamp < this.cacheTTL) {
      logger.info('Using cached release version', { version: this.cachedVersion });
      return this.cachedVersion;
    }
    return this.getLatestStableRelease();
  }

  /**
   * Fetch all git tags from GitHub (paginated) and return the highest semver-sorted
   * deployable tag. Git tags are the source of truth — GitHub Release objects are
   * not required.
   */
  private async getLatestStableRelease(): Promise<string> {
    try {
      logger.info('Fetching tags from GitHub', {
        repo: `${this.repoOwner}/${this.repoName}`,
      });

      const headers = {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Iotistic-Provisioning-Service',
        ...(process.env.GITOPS_PAT && {
          Authorization: `Bearer ${process.env.GITOPS_PAT}`,
        }),
      };

      const allTags: string[] = [];
      for (let page = 1; page <= 10; page++) {
        const response = await axios.get<GitHubTag[]>(
          `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/tags`,
          { headers, params: { per_page: 100, page }, timeout: 10000 }
        );
        const tags = response.data;
        allTags.push(...tags.map((t) => t.name));
        if (tags.length < 100) break;
      }

      const stableTags = allTags
        .filter((tag) => this.isDeployableTag(tag))
        .sort((a, b) => semver.rcompare(semver.clean(a)!, semver.clean(b)!));

      if (stableTags.length === 0) {
        throw new Error('No deployable releases found');
      }

      const version = stableTags[0];
      logger.info('Found latest stable release from tags', { version });

      this.cachedVersion = version;
      this.cacheTimestamp = Date.now();

      return version;
    } catch (error: any) {
      logger.error('Failed to fetch stable releases', { error: error.message });

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
