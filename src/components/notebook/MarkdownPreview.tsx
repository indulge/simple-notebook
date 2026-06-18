// Client-only Markdown preview shared by the editor and the inline tiles.
// react-markdown is pulled in lazily inside BrowserOnly (it is ESM-only and
// should not run during SSR), so the require call is intentional here.

import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import { RAW_BASE } from '@site/src/lib/notes';
import { s } from './styles';

// Provided by the Docusaurus webpack/rspack runtime; type-only so it is erased.
declare function require(name: string): {
  default: React.ComponentType<{
    children: string;
    remarkPlugins: unknown[];
    urlTransform: (url: string) => string;
  }>;
  defaultUrlTransform: (url: string) => string;
};

interface Props {
  title: string;
  content: string;
  /** `h1` for the full editor, `h2` for the compact tiles. */
  headingLevel?: 'h1' | 'h2';
  /** Wrapper style — `s.markdownPreview` (editor) or `s.tilePreview` (tile). */
  wrapperStyle: React.CSSProperties;
}

export default function MarkdownPreview({
  title,
  content,
  headingLevel = 'h2',
  wrapperStyle,
}: Props) {
  return (
    <BrowserOnly fallback={<div style={wrapperStyle}>Loading preview…</div>}>
      {() => {
        const { default: ReactMarkdown, defaultUrlTransform } = require('react-markdown');
        const remarkGfm = require('remark-gfm').default;
        // Notes reference uploaded images as `/img/…` (a static/ path resolved
        // by Docusaurus at build time on the published site). In the live
        // preview the file may not be deployed yet, so serve it from the raw
        // repo contents instead.
        const transformUrl = (url: string) =>
          url.startsWith('/img/')
            ? `${RAW_BASE}/static${url}`
            : defaultUrlTransform(url);
        return (
          <div style={wrapperStyle}>
            {React.createElement(headingLevel, { style: s.previewTitle }, title.trim() || 'Untitled')}
            <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={transformUrl}>
              {content}
            </ReactMarkdown>
          </div>
        );
      }}
    </BrowserOnly>
  );
}
