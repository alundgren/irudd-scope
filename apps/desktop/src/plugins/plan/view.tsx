import { useRef } from "react";
import type { TabProps } from "../api.ts";
import { PublishedContent } from "../../library/content-view.tsx";
import { useDocumentScroll } from "./document-scroll.ts";

export function PlanView({ artifact, focus, active }: TabProps) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const observeDocument = useDocumentScroll(iframe, active, artifact?.revision);
  return (
    <div className="plan-view" data-focus={focus}>
      <PublishedContent artifact={artifact}>
        {(item) => (
          <div className="plan-page">
            <iframe
              key={item.artifact.revision}
              ref={iframe}
              className="plan-document"
              title={item.artifact.title}
              srcDoc={new TextDecoder().decode(item.bytes)}
              onLoad={observeDocument}
            />
          </div>
        )}
      </PublishedContent>
    </div>
  );
}
