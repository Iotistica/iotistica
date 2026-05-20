import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link
            className="button button--secondary button--lg"
            to="/docs/intro">
            Open Documentation
          </Link>
        </div>
      </div>
    </header>
  );
}

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={siteConfig.title}
      description="Iotistica product and deployment documentation.">
      <HomepageHeader />
      <main className="container margin-vert--lg">
        <div className="row">
          <div className={clsx('col col--4')}>
            <h3>Getting Started</h3>
            <p>Install the agent and connect your first edge device.</p>
            <Link to="/docs/getting-started/quickstart">Quickstart guide</Link>
          </div>
          <div className={clsx('col col--4')}>
            <h3>Agent</h3>
            <p>Understand orchestration, state reconciliation, and cloud sync.</p>
            <Link to="/docs/agent/overview">Agent overview</Link>
          </div>
          <div className={clsx('col col--4')}>
            <h3>Deployment</h3>
            <p>Deploy customer environments on Kubernetes with Helm.</p>
            <Link to="/docs/deployment/kubernetes">Kubernetes deployment</Link>
          </div>
        </div>
      </main>
    </Layout>
  );
}
