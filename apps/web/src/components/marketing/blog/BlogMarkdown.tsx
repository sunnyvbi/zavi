import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Schema } from "hast-util-sanitize";

const SCHEMA: Schema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((t) => t !== "img"),
  protocols: { ...(defaultSchema.protocols ?? {}), href: ["http", "https", "mailto"] },
};

const SITE_HOSTS = new Set(["www.zaviagent.com", "zaviagent.com"]);

export function isExternal(href: string | undefined): boolean {
  if (!href) return false;
  if (!href.startsWith("//") && !/^https?:\/\//i.test(href)) return false;
  try {
    return !SITE_HOSTS.has(new URL(href, "https://www.zaviagent.com").hostname.toLowerCase());
  } catch {
    return true;
  }
}

const REMARK: Options["remarkPlugins"] = [remarkGfm];
const REHYPE: Options["rehypePlugins"] = [[rehypeSanitize, SCHEMA]];

export function BlogMarkdown({ children }: { children: string }) {
  return (
    <div className="prose prose-neutral max-w-none [overflow-wrap:anywhere] prose-headings:tracking-tight prose-a:font-semibold prose-a:text-[#027bff] prose-table:text-[14px]">
      <ReactMarkdown
        remarkPlugins={REMARK}
        rehypePlugins={REHYPE}
        components={{
          a: ({ href, children: c }) => {
            const external = isExternal(href);
            return external ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {c}
              </a>
            ) : (
              <a href={href}>{c}</a>
            );
          },
          table: ({ children: c }) => (
            <div className="overflow-x-auto">
              <table>{c}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
