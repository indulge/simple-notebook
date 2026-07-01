// @ts-check
import {themes as prismThemes} from 'prism-react-renderer';

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "Sachin's Notebook",
  tagline: 'Notes, tutorials, and references on AI, tooling, and software engineering.',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  url: 'https://indulge.github.io',
  baseUrl: '/simple-notebook/',

  organizationName: 'indulge',
  projectName: 'simple-notebook',
  trailingSlash: false,

  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  plugins: ['./plugins/notebook-snapshot'],

  themes: [
    [
      '@easyops-cn/docusaurus-search-local',
      /** @type {import('@easyops-cn/docusaurus-search-local').PluginOptions} */
      ({
        hashed: true,
        indexBlog: false,
        indexPages: false,
        docsRouteBasePath: 'read',
        highlightSearchTermsOnTargetPage: true,
      }),
    ],
  ],

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          routeBasePath: 'read',
          sidebarPath: './sidebars.js',
          showLastUpdateTime: true,
          // Published notes carry ad-hoc frontmatter tags — no tags.yml registry.
          onInlineTags: 'ignore',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: {
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: "Sachin's Notebook",
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'tutorialSidebar',
            position: 'left',
            label: 'Read',
          },
          { to: '/write', label: 'Write', position: 'left' },
          { to: '/write?quick=1', label: '✏️ Quick note', position: 'right' },
          {
            href: 'https://github.com/indulge/simple-notebook',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
      },
    }),
};

export default config;
