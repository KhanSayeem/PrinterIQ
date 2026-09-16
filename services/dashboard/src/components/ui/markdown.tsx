"use client";

/**
 * Renders the answer's markdown.
 *
 * From 21st.dev Agent Elements ("Markdown" by serafimcloud), the sibling of
 * the chat and tool call components already in here.
 * https://21st.dev/@serafimcloud/components/markdown
 *
 * Without this the panel printed the model's markup literally, so a bold
 * heading arrived as "**Active (status 1):**" and a list as a wall of
 * hyphens. Adapted in one way only: the upstream neutral-* colours are
 * replaced with the dashboard's own tokens, so an answer looks like the rest
 * of the dashboard rather than like a different product.
 */
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

function fixNumberedListBreaks(text: string): string {
  return text.replace(/^(\d+)\.\s*\n+\s*\n*/gm, "$1. ");
}

const CODE_FENCE_LANGS = new Set([
  "bash",
  "diff",
  "html",
  "js",
  "json",
  "jsx",
  "md",
  "markdown",
  "sh",
  "shell",
  "sql",
  "text",
  "ts",
  "tsx",
  "yml",
  "yaml",
]);

function normalizeCodeFenceLanguages(text: string): string {
  return text.replace(/```([^\n]*)/g, (_match, langRaw) => {
    const lang = String(langRaw || "")
      .trim()
      .toLowerCase();
    if (!lang) {
      return "```";
    }
    const normalized = lang.split(/\s+/)[0];
    return CODE_FENCE_LANGS.has(normalized!) ? `\`\`\`${normalized}` : "```text";
  });
}

export type MarkdownProps = {
  content: string;
  className?: string;
};

const components: Components = {
  h1: ({ children, ...props }) => (
    <h1 className="mt-3 mb-1.5 text-base font-semibold text-foreground" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="mt-3 mb-1.5 text-base font-semibold text-foreground" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="mt-2 mb-1 text-sm font-semibold text-foreground" {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 className="mt-2 mb-1 text-sm font-medium text-foreground" {...props}>
      {children}
    </h4>
  ),
  p: ({ children, ...props }) => (
    <p className="mb-2 text-sm leading-relaxed text-foreground" {...props}>
      {children}
    </p>
  ),
  ul: ({ children, ...props }) => (
    <ul className="mb-2 list-outside list-disc space-y-0.5 pl-4 text-sm text-foreground" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol
      className="mb-2 list-outside list-decimal space-y-0.5 pl-5 text-sm text-foreground"
      {...props}
    >
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="pl-0.5 text-sm text-foreground" {...props}>
      {children}
    </li>
  ),
  strong: ({ children, ...props }) => (
    <strong className="font-semibold text-foreground" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }) => (
    <em className="italic" {...props}>
      {children}
    </em>
  ),
  a: ({ href, children, ...props }) => {
    if (!href) {
      return <span>{children}</span>;
    }
    const isExternal = href.startsWith("http") || href.startsWith("mailto:");
    return (
      <a
        {...props}
        href={href}
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
        className="text-blue-700 underline-offset-2 hover:underline"
      >
        {children}
      </a>
    );
  },
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="mb-2 border-l-2 border-border pl-3 text-sm italic text-muted-foreground"
      {...props}
    >
      {children}
    </blockquote>
  ),
  hr: ({ ...props }) => <hr className="my-4 border-border" {...props} />,
  table: ({ children, ...props }) => (
    <div className="my-3 overflow-x-auto rounded-[10px] border border-border">
      <table className="w-full text-sm" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }) => (
    <thead className="bg-muted" {...props}>
      {children}
    </thead>
  ),
  th: ({ children, ...props }) => (
    <th className="px-3 py-2 text-left font-medium text-foreground" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="border-t border-border px-3 py-2 text-foreground" {...props}>
      {children}
    </td>
  ),
  code: ({ children, className, ...props }) => {
    const isBlock = typeof className === "string" && className.startsWith("language-");
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded bg-muted px-1 py-0.5 font-mono text-[0.875em] text-foreground"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }) => (
    <pre
      className="my-3 overflow-x-auto rounded-[10px] border border-border bg-muted p-3 font-mono text-xs text-foreground"
      {...props}
    >
      {children}
    </pre>
  ),
};

export const Markdown = memo(function Markdown({ content, className }: MarkdownProps) {
  const safeContent = normalizeCodeFenceLanguages(fixNumberedListBreaks(content));

  return (
    <div className={cn("break-words", className)}>
      <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
        {safeContent}
      </ReactMarkdown>
    </div>
  );
});

export default Markdown;
