import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "../../renderer/components/ui/button.tsx";
import { NativeSelect, NativeSelectOption } from "../../renderer/components/ui/native-select.tsx";
import { Textarea } from "../../renderer/components/ui/textarea.tsx";
import { BLOCK_KINDS, BLOCK_WIDTHS, type Block, MAX_SOURCE } from "./contract.ts";

const kindLabel: Record<Block["kind"], string> = {
  text: "Text",
  diagram: "Diagram",
  note: "Note",
  decision: "Decision",
  risk: "Risk",
  question: "Question",
};
const widthLabel: Record<Block["width"], string> = {
  full: "Full width",
  half: "Half width",
  third: "Third width",
};

/** Edits one block's source. The page shows each change as a live preview. */
export function BlockEditor({
  block,
  onChange,
  onDone,
  onCancel,
  onDelete,
}: {
  block: Block;
  onChange: (block: Block) => void;
  onDone: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const source = useRef<HTMLTextAreaElement>(null);
  useEffect(() => source.current?.focus(), [block.id]);
  return (
    <section
      className="mc-editor"
      aria-label={`Edit block ${block.id}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) onDone();
      }}
    >
      <div className="mc-editor-fields">
        <NativeSelect
          size="sm"
          aria-label="Block kind"
          value={block.kind}
          onChange={(event) => onChange({ ...block, kind: event.target.value as Block["kind"] })}
        >
          {BLOCK_KINDS.map((kind) => (
            <NativeSelectOption key={kind} value={kind}>
              {kindLabel[kind]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect
          size="sm"
          aria-label="Block width"
          value={block.width}
          onChange={(event) => onChange({ ...block, width: event.target.value as Block["width"] })}
        >
          {BLOCK_WIDTHS.map((width) => (
            <NativeSelectOption key={width} value={width}>
              {widthLabel[width]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span className="mc-muted">{block.id}</span>
        <span className="mc-editor-actions">
          <Button variant="destructive" size="sm" onClick={onDelete}>
            <Trash2 /> Delete
          </Button>
          <Button size="sm" onClick={onDone}>
            Done
          </Button>
        </span>
      </div>
      <Textarea
        ref={source}
        aria-label="Block source"
        className="mc-editor-source"
        spellCheck={false}
        maxLength={MAX_SOURCE}
        value={block.source}
        onChange={(event) => onChange({ ...block, source: event.target.value })}
      />
    </section>
  );
}
