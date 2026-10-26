import { useId, useState, type ReactElement } from "react";
import { Tooltip as Primitive } from "@base-ui/react/tooltip";

export function Tooltip({ children, content }: { children: ReactElement; content?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  if (!content) return children;
  return (
    <Primitive.Root open={open} onOpenChange={setOpen}>
      <Primitive.Trigger render={children} aria-describedby={open ? id : undefined} />
      <Primitive.Portal>
        <Primitive.Positioner sideOffset={8} className="scope-tooltip-positioner">
          <Primitive.Popup id={id} role="tooltip" className="scope-tooltip">
            {content}
          </Primitive.Popup>
        </Primitive.Positioner>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
