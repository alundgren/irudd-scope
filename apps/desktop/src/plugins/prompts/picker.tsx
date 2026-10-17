import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import {
  PROMPT_STRUCTURE,
  type PromptField,
  type PromptItem,
  type PromptReply,
} from "@irudd-scope/protocol/prompts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { Input } from "../../renderer/components/ui/input.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../renderer/components/ui/dialog.tsx";
import { promptCommand, readPromptItem } from "./editor.ts";

type Page = Extract<PromptReply, { type: "items" }>;
function ExampleImage({ item }: { item: PromptItem }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !item.image) {
      setUrl("");
      return;
    }
    let active = true;
    let objectUrl = "";
    setError("");
    void window.scope
      .promptImage({ itemId: item.id, imageId: item.image.id })
      .then((result) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(result.bytes)], { type: result.image.mediaType }),
        );
        setUrl(objectUrl);
      })
      .catch(() => {
        if (active) setError("Example image could not load.");
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [visible, item.id, item.image?.id, retry]);
  return (
    <div className="prompt-example" ref={host}>
      {url ? (
        <img src={url} alt={item.exampleScene?.title ?? `${item.name} example`} />
      ) : error ? (
        <div role="alert">
          <p>{error}</p>
          <Button variant="outline" onClick={() => setRetry(retry + 1)}>
            Retry image
          </Button>
        </div>
      ) : (
        <span>{item.image ? "Loading example…" : "No example image"}</span>
      )}
    </div>
  );
}
export function PromptPicker({
  field,
  epoch,
  selectedId,
  onClose,
  onSelect,
}: {
  field: PromptField;
  epoch: number;
  selectedId: string | null;
  onClose: () => void;
  onSelect: (item: PromptItem) => void;
}) {
  const definition = PROMPT_STRUCTURE.fields.find((entry) => entry.id === field)!;
  const input = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<Page>();
  const [items, setItems] = useState<PromptItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const query = useRef("");
  useEffect(() => {
    const version = ++generation.current;
    setLoading(true);
    setError("");
    setItems([]);
    setPage(undefined);
    const timer = setTimeout(
      () => {
        query.current = search;
        void promptCommand({ action: "list-items", field, search })
          .then((reply) => {
            if (version !== generation.current || reply.type !== "items") return;
            setPage(reply);
            setItems([...reply.items]);
          })
          .catch((cause) => {
            if (version === generation.current)
              setError(cause instanceof Error ? cause.message : "Could not load the library.");
          })
          .finally(() => {
            if (version === generation.current) setLoading(false);
          });
      },
      search ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [search, field, epoch, retry]);
  async function more() {
    if (!page?.next || loading) return;
    const version = generation.current;
    setLoading(true);
    setError("");
    try {
      const reply = await promptCommand({
        action: "list-items",
        field,
        search: query.current,
        cursor: page.next,
      });
      if (version !== generation.current || reply.type !== "items") return;
      setPage(reply);
      setItems((previous) => [...previous, ...reply.items]);
    } catch (cause) {
      if (version === generation.current)
        setError(
          cause instanceof Error ? cause.message : "The library changed. Refresh to continue.",
        );
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }
  async function select(item: PromptItem) {
    setSelecting(true);
    setError("");
    try {
      onSelect(await readPromptItem(item.id));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "This item changed. Refresh the library and retry.",
      );
    } finally {
      setSelecting(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="prompt-picker"
        showCloseButton={false}
        initialFocus={input}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="prompt-picker-header">
          <Button variant="ghost" aria-label="Back to prompt" onClick={onClose}>
            <ArrowLeft />
            Back
          </Button>
          <div>
            <DialogTitle>{definition.name}</DialogTitle>
            <DialogDescription>{definition.guidance}</DialogDescription>
          </div>
          <label className="prompt-picker-search">
            <Search size={16} />
            <Input
              ref={input}
              aria-label={`Search ${definition.name} library`}
              placeholder="Search name, text or description"
              maxLength={160}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </header>
        <div className="prompt-picker-body">
          {error && (
            <div className="prompt-notice" role="alert">
              <p>{error}</p>
              <Button variant="outline" onClick={() => setRetry(retry + 1)}>
                Refresh library
              </Button>
            </div>
          )}
          {!loading && !error && !items.length && (
            <div className="prompt-picker-empty">
              <p>{search ? "No matching items." : "This field's library is empty."}</p>
              <p>
                {search
                  ? "Try another search."
                  : "Ask your CLI agent to add library items and optional example images."}
              </p>
              {search && (
                <Button variant="outline" onClick={() => setSearch("")}>
                  Clear search
                </Button>
              )}
            </div>
          )}
          <div className="prompt-picker-grid">
            {items.map((item) => (
              <article className="prompt-picker-item" key={`${item.id}:${item.revision}`}>
                <ExampleImage item={item} />
                <div className="prompt-item-heading">
                  <h3>{item.name}</h3>
                  <Button
                    variant={selectedId === item.id ? "secondary" : "default"}
                    disabled={selecting}
                    onClick={() => void select(item)}
                    aria-label={`Use ${item.name}`}
                  >
                    {selectedId === item.id ? "Use again" : "Use fragment"}
                  </Button>
                </div>
                <p className="prompt-item-fragment">{item.fragment}</p>
                {item.description && <p className="prompt-item-description">{item.description}</p>}
                {item.exampleScene && (
                  <details>
                    <summary>{item.exampleScene.title}</summary>
                    <p>{item.exampleScene.prompt}</p>
                  </details>
                )}
              </article>
            ))}
          </div>
          {loading && <p role="status">Loading library…</p>}
          {page?.next && (
            <Button variant="outline" disabled={loading} onClick={() => void more()}>
              Load more
            </Button>
          )}
        </div>
        <footer>
          Example images illustrate library items. They are not generated from your current prompt.
        </footer>
      </DialogContent>
    </Dialog>
  );
}
