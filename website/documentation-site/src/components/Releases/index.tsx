import React, { useEffect, useState } from 'react';

interface Release {
  id: number;
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .trim();
}

export default function Releases(): JSX.Element {
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('https://api.github.com/repos/Iotistica/iotistic/releases?per_page=50')
      .then((res) => {
        if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
        return res.json() as Promise<Release[]>;
      })
      .then((data) => {
        setReleases(data.filter((r) => !r.draft));
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return <p style={{ color: 'var(--ifm-color-secondary)' }}>Loading releases…</p>;
  }

  if (error) {
    return <p style={{ color: 'var(--ifm-color-danger)' }}>Could not load releases: {error}</p>;
  }

  if (releases.length === 0) {
    return <p>No releases published yet.</p>;
  }

  return (
    <div>
      {releases.map((release) => {
        const body = stripMarkdown(release.body ?? '');
        const preview = body.length > 500 ? `${body.slice(0, 500)}…` : body;

        return (
          <div
            key={release.id}
            style={{
              borderLeft: '3px solid var(--ifm-color-primary)',
              paddingLeft: '1rem',
              marginBottom: '2.5rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.25rem' }}>
              <a
                href={release.html_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontWeight: 700, fontSize: '1.1rem' }}
              >
                {release.name || release.tag_name}
              </a>
              <code style={{ fontSize: '0.8rem' }}>{release.tag_name}</code>
              {release.prerelease && (
                <span
                  style={{
                    background: 'var(--ifm-color-warning-contrast-background)',
                    color: 'var(--ifm-color-warning-dark)',
                    border: '1px solid var(--ifm-color-warning)',
                    borderRadius: '4px',
                    padding: '1px 6px',
                    fontSize: '0.72rem',
                    fontWeight: 600,
                  }}
                >
                  pre-release
                </span>
              )}
            </div>
            <p style={{ color: 'var(--ifm-color-secondary-darkest)', fontSize: '0.85rem', margin: '0 0 0.6rem' }}>
              {formatDate(release.published_at)}
            </p>
            {preview && (
              <p style={{ whiteSpace: 'pre-line', margin: '0 0 0.5rem', fontSize: '0.95rem' }}>
                {preview}
              </p>
            )}
            <a href={release.html_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.9rem' }}>
              Full release notes →
            </a>
          </div>
        );
      })}
    </div>
  );
}
