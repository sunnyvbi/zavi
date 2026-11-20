
import { Fragment, type JSX } from "react";
import { parseMarkup, type Block, type Span } from "../markup";
import { openInTab } from "./open-in-tab";

export function Markup(props: { text: string }): JSX.Element {
  const blocks = parseMarkup(props.text);
  return (
    <div className="zv-md">
      {blocks.map((block, i) => (
        <BlockNode key={i} block={block} />
      ))}
    </div>
  );
}

function BlockNode(props: { block: Block }): JSX.Element {
  const b = props.block;
  if (b.kind === "paragraph") {
    return (
      <p className="zv-md-p">
        <Spans spans={b.spans} />
      </p>
    );
  }
  const items = b.items.map((spans, i) => (
    <li key={i}>
      <Spans spans={spans} />
    </li>
  ));
  return b.ordered ? (
    <ol className="zv-md-list" start={b.start}>
      {items}
    </ol>
  ) : (
    <ul className="zv-md-list">{items}</ul>
  );
}

function Spans(props: { spans: Span[] }): JSX.Element {
  return (
    <>
      {props.spans.map((span, i) => (
        <SpanNode key={i} span={span} />
      ))}
    </>
  );
}

function SpanNode(props: { span: Span }): JSX.Element {
  const s = props.span;
  if (s.kind === "text") return <Fragment>{s.text}</Fragment>;
  if (s.kind === "code") return <code className="zv-md-code">{s.text}</code>;
  if (s.kind === "strong") {
    return (
      <strong className="zv-md-strong">
        <Spans spans={s.spans} />
      </strong>
    );
  }
  return (
    <a
      className="zv-md-link"
      href={s.href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={openInTab(s.href)}
    >
      {s.text}
    </a>
  );
}
