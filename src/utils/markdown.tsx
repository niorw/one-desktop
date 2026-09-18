/**
 * Markdown renderer — mirrors openworker's implementation.
 * Uses remarkGfm for tables, lists, strikethrough etc.
 *
 * Adds defensive normalization:
 * - converts literal \n escape sequences to real newlines
 * - normalizes Windows/mac line endings
 * - repairs tables whose rows were collapsed onto one line by the LLM
 * - ensures block-level markdown (headings, tables) starts on a new line
 */

import React, { isValidElement, memo, useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { splitStreaming } from "./streamSplit";
import { openInDefaultApp } from "./openFile";
import { Icons } from "../components/common/Icons";
import { useI18n } from "../i18n/I18nProvider";

/**
 * Heuristic repair for single-line markdown tables.
 *
 * Some models emit a whole table on one line, e.g.:
 *   "| a | b | | c | d |"
 * or
 *   "| a | b || c | d |"
 *
 * When we detect table syntax but fewer than 2 standalone table rows,
 * we walk through the text and insert newlines between consecutive rows.
 */
function repairInlineTables(text: string): string {
  if (!text.includes("|")) return text;

  const lines = text.split("\n");
  const tableRowCount = lines.filter((l) => /^\s*\|/.test(l)).length;

  // Already looks like a proper table — leave it alone.
  if (tableRowCount >= 2) return text;

  let result = "";
  let currentRow = "";
  let pipeCount = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    currentRow += char;

    if (char === "|") {
      pipeCount++;
      const trimmed = currentRow.trim();
      if (
        pipeCount >= 2 &&
        trimmed.startsWith("|") &&
        trimmed.endsWith("|")
      ) {
        // Look ahead: if the next non-whitespace char is another '|',
        // this is likely the boundary between two table rows.
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (j < text.length && text[j] === "|") {
          result += currentRow + "\n";
          currentRow = "";
          pipeCount = 0;
          i = j - 1;
          continue;
        }
      }
    }
  }

  return result + currentRow;
}

/**
 * Ensure block-level markdown starts on its own line.
 * Fixes cases like "...paragraph ### Heading" where the heading
 * is inline because newlines were collapsed by the model.
 */
function ensureBlockSeparators(text: string): string {
  // Insert newlines before # headings when they follow non-whitespace text
  // on the same line. Avoid splitting inside URLs/links by skipping common
  // URL delimiters right before the '#'.
  return text.replace(/(\S)(\s*)(#{1,6}\s+\S)/g, (_m, before, space, heading) => {
    if (space.includes("\n")) return before + space + heading;
    if ("/([".includes(before)) return before + space + heading;
    return before + "\n\n" + heading;
  });
}

/**
 * Fix inline ordered lists in CoT/reasoning text.
 *
 * Models frequently emit reasoning like:
 *   "我的理解： 1. **item one** (desc) 2. **item two** (desc)"
 * where list items are NOT on their own lines, so remarkGfm won't
 * parse them as <ol>. This heuristic inserts newlines before each
 * " N. " or " N）" pattern (N = 1-9) that follows text on the same line,
 * turning them into proper list items.
 */
function normalizeInlineLists(text: string): string {
  // R-9：收紧触发条件，避免把小数/版本号误判为有序列表。
  //
  // 旧正则 `(\S)([：:;；，,\s]*)(\d+)[.．.、]\s*` 会把「增长 14.9%」中的 "14."
  // 也匹配上并插入换行 → 渲染成有序列表（这正是当初被迫 disallowLists=true
  // 禁用全部列表的原因）。新条件要求两件事同时成立：
  //   ① 数字前不能紧邻数字或小数点（排除在「14.9」中间断开）
  //   ② 数字后必须是**分隔符 + 至少一个空白** —— 这才是真正的区分点：
  //      「增长 14.9%」里 "4." 后面紧跟 "9"（无空白）→ 不匹配；
  //      「理解： 1. **a** 2. **b**」里 "1. " / "2. " 后面有空白 → 都成列表。
  //   ③ 数字限 1-2 位（排除「2024.10.01」这类日期被拆开）
  return text.replace(
    /(^|\n|[^\d.])[ \t]*(\d{1,2})[.．、)][ \t]+/g,
    (_match, lead, num) => `${lead}\n${num}. `
  );
}

function normalizeMarkdown(input: string): string {
  let text = input;

  // Convert literal "\n" (two characters) to real newlines.
  text = text.replace(/\\n/g, "\n");

  // Normalize all line endings to LF.
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Only run heuristic repairs when the content clearly lacks newlines
  // (e.g., model collapsed everything to one line). If the text already
  // has proper structure, leave it alone so we don't break valid tables.
  const newlineCount = (text.match(/\n/g) || []).length;
  const likelyCollapsed = newlineCount < 3;

  if (likelyCollapsed && text.includes("|")) {
    text = repairInlineTables(text);
  }

  if (likelyCollapsed && /#{1,6}\s/.test(text)) {
    text = ensureBlockSeparators(text);
  }

  // Fix inline numbered lists common in CoT/reasoning output:
  // "理解： 1. **a** 2. **b**" → proper <ol> items
  text = normalizeInlineLists(text);

  return text;
}

/**
 * 判定 Markdown 链接 `href` 是否指向本机文件；是则返回规范化路径，否则返回 null。
 *
 * 覆盖三种写法：
 * - `file:///abs/path/x.pdf` 协议前缀
 * - Unix 绝对路径 `/Users/x/report.pdf`（Tauri 桌面应用无前端路由，`/` 即文件系统根）
 * - Windows 盘符 `C:\x` / `C:/x`、家目录 `~`
 * 协议相对 `//host` 与裸 `http(s)` 不算本机文件。
 */
export function detectLocalFile(href: string): string | null {
  if (!href) return null;
  let h = href.trim();
  if (h.startsWith("file://")) h = h.slice("file://".length);
  if (h.startsWith("//")) return null;
  const isAbsolute = /^(?:[a-zA-Z]:[\\/]|[\\/]|~[\\/])/.test(h);
  // Agent 输出里的工作区相对路径（src/App.tsx、./report.md）也能由预览后端
  // 按授权工作区根目录解析。只接受带目录或明显文件扩展名的形式，避免把普通文字
  // / 站内链接误判为本机文件。
  const isRelativeFile = /^(?:\.{1,2}[\\/]|(?:src|dist|public|assets|docs|scripts|e2e|tests?)[\\/])/.test(h)
    || /^(?:[^\\/\s]+[\\/])+[^\\/\s]+\.[a-zA-Z0-9]{1,12}$/.test(h)
    || /^[^\\/\s]+\.[a-zA-Z0-9]{1,12}$/.test(h);
  if (!isAbsolute && !isRelativeFile) return null;
  return h;
}

/** 输出文本中可安全识别的本地路径 token（不包含普通 URL）。 */
const LOCAL_PATH_TOKEN = /file:\/\/[^\s`"'<>]+|(?:~[\\/]|[a-zA-Z]:[\\/]|\/|\.{1,2}[\\/])[^\s`"'<>()[\]{}]+|(?:src|dist|public|assets|docs|scripts|e2e|tests?)[\\/][^\s`"'<>()[\]{}]+/g;

function trimPathPunctuation(value: string): string {
  return value.replace(/[，。、】【、】【,.;:!?]+$/g, "");
}

/**
 * 将工具输出中的文件地址渲染为预览链接，同时保留原有空格与换行。
 * `pre` / 终端输出也可直接使用，因此不依赖 Markdown 解析。
 */
export function LocalPathText({
  text,
  onFileLink,
}: {
  text: string;
  onFileLink?: (path: string) => void;
}) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  LOCAL_PATH_TOKEN.lastIndex = 0;
  for (let match = LOCAL_PATH_TOKEN.exec(text); match; match = LOCAL_PATH_TOKEN.exec(text)) {
    const raw = match[0];
    const path = trimPathPunctuation(raw);
    const localPath = detectLocalFile(path);
    if (!localPath) continue;
    const start = match.index;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <button
        key={`${start}-${path}`}
        type="button"
        className="file-path-link"
        title={`预览 ${localPath}`}
        onClick={(event) => {
          event.stopPropagation();
          if (onFileLink) onFileLink(localPath);
          else void openInDefaultApp(localPath);
        }}
      >
        {path}
      </button>,
    );
    // token 末尾的标点不能丢失。
    if (path.length < raw.length) parts.push(raw.slice(path.length));
    last = start + raw.length;
  }
  if (last === 0) return <>{text}</>;
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** 代码块语言标识 → 展示名（未收录则原样显示，如 `language-ruby` → `ruby`）。 */
const LANG_LABEL: Record<string, string> = {
  ts: "TypeScript", typescript: "TypeScript",
  js: "JavaScript", javascript: "JavaScript",
  jsx: "JSX", tsx: "TSX",
  py: "Python", python: "Python",
  sh: "Shell", bash: "Shell", shell: "Shell", zsh: "Shell",
  json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML",
  md: "Markdown", markdown: "Markdown",
  html: "HTML", css: "CSS", scss: "SCSS", less: "Less",
  sql: "SQL", go: "Go", rust: "Rust", java: "Java",
  c: "C", cpp: "C++", "c++": "C++", cs: "C#", "c#": "C#",
  php: "PHP", rb: "Ruby", swift: "Swift", kt: "Kotlin", scala: "Scala",
  text: "Text", plaintext: "Text", txt: "Text", plain: "Text",
  diff: "Diff", dockerfile: "Dockerfile", graphql: "GraphQL",
};

/** 递归取出 React 子树的纯文本（用于复制代码，忽略高亮产生的 span）。 */
function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) {
    return extractText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/**
 * 代码块渲染器：包一层容器，顶部加语言标签 + 复制按钮。
 * 复制目标取 `extractText` 的纯文本（而非 DOM innerText），避免带上高亮 span 造成的
 * 多余空白；`navigator.clipboard` 不可用时静默失败（不打扰用户）。
 */
function makePre(): Components["pre"] {
  return function Pre({ children }: { children?: ReactNode }) {
    const { t } = useI18n();
    const [copied, setCopied] = useState(false);

    const codeEl = children as ReactElement<{
      className?: string;
      children?: ReactNode;
    }> | null;
    const cls = codeEl?.props?.className ?? "";
    const langKey = /language-([\w+#.-]+)/.exec(cls)?.[1]?.toLowerCase();
    const langLabel = langKey ? (LANG_LABEL[langKey] ?? langKey) : null;
    const raw = useMemo(() => extractText(codeEl?.props?.children), [children]);

    const handleCopy = () => {
      const done = () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      };
      try {
        void navigator.clipboard?.writeText(raw).then(done);
      } catch {
        /* 剪贴板不可用时静默 */
      }
    };

    return (
      <div className="md-codeblock">
        <div className="md-codeblock-bar">
          <span className="md-codeblock-lang">{langLabel ?? t("common.code")}</span>
          <button
            type="button"
            className={`md-codeblock-copy${copied ? " copied" : ""}`}
            onClick={handleCopy}
            title={copied ? t("common.copied") : t("common.copy")}
            aria-label={copied ? t("common.copied") : t("common.copy")}
          >
            {copied ? <Icons.Check size={11} /> : <Icons.Copy size={11} />}
            <span>{copied ? t("common.copied") : t("common.copy")}</span>
          </button>
        </div>
        <pre>{children}</pre>
      </div>
    );
  };
}

/**
 * 链接渲染器：拦截本机文件链接，转交 `onFileLink`（预览到右栏）或降级用系统程序打开；
 * 外部 http(s) 链接走浏览器新标签，避免 SPA 内跳 blank page。
 */
function makeAnchor(
  onFileLink?: (path: string) => void,
): Components["a"] {
  return function Anchor(props) {
    const href = (props.href ?? "") as string;
    const file = detectLocalFile(href);
    const handleClick = (e: React.MouseEvent) => {
      if (file) {
        e.preventDefault();
        if (onFileLink) onFileLink(file);
        else void openInDefaultApp(file);
        return;
      }
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault();
        window.open(href, "_blank", "noopener,noreferrer");
      }
    };
    const isExternal = /^https?:\/\//i.test(href);
    return (
      <a
        {...props}
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
        onClick={handleClick}
      />
    );
  };
}

/** 反引号包裹的路径（`src/App.tsx`）同样应该可以直接预览。 */
function makeCode(onFileLink?: (path: string) => void): Components["code"] {
  return function Code({ children, className, ...props }) {
    const text = String(children).replace(/\n$/, "");
    const file = !className ? detectLocalFile(text) : null;
    if (file) {
      return (
        <button
          type="button"
          className="file-path-link file-path-link--code"
          title={`预览 ${file}`}
          onClick={(event) => {
            event.stopPropagation();
            if (onFileLink) onFileLink(file);
            else void openInDefaultApp(file);
          }}
        >
          {children}
        </button>
      );
    }
    return <code className={className} {...props}>{children}</code>;
  };
}

export function Markdown({
  children,
  components,
  restricted,
  disallowLists = false,
  onFileLink,
}: {
  children: string;
  components?: Components;
  /** 弱化渲染：屏蔽标题/列表/表格/引用/代码块，仅保留粗体/链接/换行。用于聊天型群的低强度展示。 */
  restricted?: boolean;
  /** R-9：默认 false —— **渲染列表**。
   *  此前默认 true（禁用 ol/ul/li 并解包为纯文本），源自一个真实痛点：
   *  「增长 14.9%」这类词内数字会被 `normalizeInlineLists` 误判成有序列表
   *  （渲染成 16/17/18 的错号）。但代价是**整个应用的列表都不渲染**，
   *  成了"md 渲染能力太弱"的主因。
   *  现已收紧该正则（要求数字前是句子结束标点/换行、后是分隔符+空白），
   *  小数与版本号不再误伤，因此可以安全地默认渲染列表。
   *  需要保留旧行为的调用方仍可显式传 true。 */
  disallowLists?: boolean;
  /** 本机文件链接点击回调；不传时降级为系统程序打开（绝不跳 blank page）。 */
  onFileLink?: (path: string) => void;
}) {
  const normalized = normalizeMarkdown(children);

  // 产品级默认：答案区不依赖列表排版，默认禁用 ol/ul/li（解包为纯文本）。
  // 既消除"行内小数被误判为有序列表"的错号（14.9% → 16/17/18），也契合 no-card / 自然语言基调。
  // restricted 为聊天型群的全弱化（额外屏蔽标题/表格/引用/代码块）。
  const listOpts = disallowLists
    ? { disallowedElements: ["ul", "ol", "li"], unwrapDisallowed: true }
    : {};
  const restrictedOpts = restricted
    ? {
        disallowedElements: [
          "h1", "h2", "h3", "h4", "h5", "h6",
          "ul", "ol", "li",
          "table", "thead", "tbody", "tr", "th", "td",
          "blockquote", "pre", "code",
        ],
        unwrapDisallowed: true,
      }
    : listOpts;

  // 文件链接拦截 + 代码块增强：合并调用方自定义组件（若有）与本机链接拦截器。
  // 注意顺序：调用方的 components 先铺底，本机增强覆盖其后；若调用方需要自定义
  // pre/a/code，应通过 props 传入（这里不覆盖调用方显式指定的同名 key 之外的行为）。
  const mergedComponents: Components = {
    ...components,
    a: makeAnchor(onFileLink),
    code: makeCode(onFileLink),
    pre: makePre(),
  };

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={mergedComponents}
        {...restrictedOpts}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
//  流式分段解析（Phase 4 / G7）
//
//  纯分段逻辑在 `./streamSplit`（零 React 依赖、可单测），这里只做
//  memo 化渲染：已闭合段内容不变 → 永不重解析；只有活跃尾段每帧解析。
// ══════════════════════════════════════════════════════════════

const MemoMarkdown = memo(function MemoMarkdown({ children }: { children: string }) {
  return <Markdown>{children}</Markdown>;
});

/**
 * 流式分段 Markdown：流式期间只重解析活跃尾段，已闭合段稳定不重渲染。
 * 用于仍在增长的流式文本（最终答案 / 长回答的 streaming 态）。
 * 已闭合段只会在末尾追加，下标 key 稳定，不会引起列表错位重挂载。
 */
export function SegmentedMarkdown({ children }: { children: string }) {
  const { closed, tail } = useMemo(() => splitStreaming(children), [children]);
  return (
    <>
      {closed.map((seg, i) => (
        <MemoMarkdown key={`seg-${i}`}>{seg}</MemoMarkdown>
      ))}
      {tail && <MemoMarkdown>{tail}</MemoMarkdown>}
    </>
  );
}
