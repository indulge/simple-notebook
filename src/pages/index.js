import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import styles from './index.module.css';

const docs = [
  {
    category: 'Claude Code',
    items: [
      {
        label: 'Workshop 1 — The Five Building Blocks',
        to: '/docs/claude-notes/claude-workshop-1',
        description:
          'Hands-on walkthrough of Tools, Workflows, Commands, Skills, and Hooks. Each section includes a real example and a ready-to-paste prompt so you can build it yourself.',
      },
    ],
  },
];

export default function Home() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout title="Home" description={siteConfig.tagline}>
      <header className={styles.heroBanner}>
        <div className="container">
          <Heading as="h1">{siteConfig.title}</Heading>
          <p>{siteConfig.tagline}</p>
        </div>
      </header>
      <main className="container margin-vert--lg">
        {docs.map(({category, items}) => (
          <section key={category} className="margin-bottom--xl">
            <Heading as="h2">{category}</Heading>
            <div className="row">
              {items.map(({label, to, description}) => (
                <div key={to} className="col col--6 margin-bottom--md">
                  <div className="card padding--md" style={{height: '100%'}}>
                    <Heading as="h3">
                      <Link to={to}>{label}</Link>
                    </Heading>
                    <p>{description}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </main>
    </Layout>
  );
}
