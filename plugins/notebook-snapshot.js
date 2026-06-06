// Local Docusaurus plugin. Reads the notebooks from disk at build time and
// exposes them as plugin global data, so the home hub (src/pages/index.js) has
// an instant, SSR-friendly initial render and a reliable "what's actually
// deployed" set to compare the live GitHub listing against (publishing badges).

import { readNotebooksFromDisk } from '../src/lib/notebooksFs.js';

export default function notebookSnapshotPlugin() {
  return {
    name: 'notebook-snapshot',
    async loadContent() {
      return readNotebooksFromDisk('docs');
    },
    async contentLoaded({ content, actions }) {
      actions.setGlobalData({ notebooks: content });
    },
  };
}
