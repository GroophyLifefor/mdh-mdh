// Editor colors, driven by the --syn-* CSS variables so every theme (light/dark/future) works.
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const style = HighlightStyle.define([
  { tag: t.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.monospace], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.function(t.variableName), t.definition(t.variableName)], color: 'var(--syn-fn)' },
  { tag: [t.typeName, t.className], color: 'var(--syn-type)' },
  { tag: [t.propertyName, t.tagName, t.attributeName, t.labelName], color: 'var(--syn-tag)' },
  { tag: [t.punctuation, t.separator, t.operator, t.bracket, t.meta, t.processingInstruction, t.contentSeparator], color: 'var(--syn-punct)' },
  { tag: t.heading, color: 'var(--syn-fn)', fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.quote, color: 'var(--syn-comment)' },
  { tag: [t.link, t.url], color: 'var(--accent)' },
]);

export const mdhHighlight = syntaxHighlighting(style);
