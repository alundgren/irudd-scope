import { afterEach, expect, test, vi } from "vite-plus/test";
import { PullRequestsFrameHost } from "../apps/desktop/src/plugins/pull-requests/frame-host.ts";
import type { ContentWindow } from "../apps/desktop/src/plugins/pull-requests/window-content.ts";

afterEach(() => vi.unstubAllGlobals());

async function focusFixture() {
  const callbacks: FrameRequestCallback[] = [];
  let receive: ((event: MessageEvent) => void) | undefined;
  let currentFocus = "inbox opener";
  let windows: ContentWindow[] = [];
  const identity = { channel: crypto.randomUUID(), tabId: crypto.randomUUID() };
  const opener = { isConnected: true, focus: () => (currentFocus = "inbox opener") };
  const mainFrame = {
    contentDocument: { activeElement: opener },
    contentWindow: { focus: () => (currentFocus = "inbox iframe"), postMessage: () => {} },
  };
  const interest = vi.fn(async () => {});
  vi.stubGlobal("window", {
    scope: {
      onPullRequestsLinkResult: () => () => {},
      onPullRequestsDetailUpdate: () => () => {},
      pullRequestsInterest: interest,
    },
    addEventListener(_type: string, listener: typeof receive) {
      receive = listener;
    },
    removeEventListener() {},
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  const host = new PullRequestsFrameHost({
    name: "synthetic-inbox",
    identity,
    refresh: async () => {},
    onSnapshot: () => {},
    onWindows: (value) => (windows = value),
    onError: (error) => {
      throw new Error(error);
    },
    onLinkError: (error) => {
      if (error) throw new Error(error);
    },
  });
  const stop = host.start();
  host.attach("main", mainFrame as unknown as HTMLIFrameElement);
  await host.setActive(true);
  return {
    host,
    stop,
    focus: () => currentFocus,
    open(title: string) {
      receive!({
        source: mainFrame.contentWindow,
        data: {
          ...identity,
          type: "scope-pull-requests-call",
          id: crypto.randomUUID(),
          method: "openWindow",
          args: [{ title, html: "<p>Synthetic content</p>" }],
        },
      } as unknown as MessageEvent);
      // The mounted window focuses its close control while older cleanup may still run.
      currentFocus = `${title} close button`;
      return windows.find((window) => window.title === title)!.environment.id;
    },
    holdInterest() {
      const requested = Promise.withResolvers<void>();
      const reply = Promise.withResolvers<void>();
      interest.mockImplementationOnce(() => {
        requested.resolve();
        return reply.promise;
      });
      return { requested: requested.promise, release: () => reply.resolve() };
    },
    runFrames() {
      for (const callback of callbacks.splice(0)) callback(0);
    },
  };
}

test("a close waiting for interest cannot take focus from a newly opened window", async () => {
  const fixture = await focusFixture();
  try {
    const first = fixture.open("First");
    const interest = fixture.holdInterest();
    const closing = fixture.host.close(first);
    await interest.requested;
    fixture.open("Second");
    interest.release();
    await closing;
    fixture.runFrames();
    expect(fixture.focus()).toBe("Second close button");
  } finally {
    fixture.stop();
  }
});

test("a queued close callback cannot take focus from a newly opened window", async () => {
  const fixture = await focusFixture();
  try {
    await fixture.host.close(fixture.open("First"));
    fixture.open("Second");
    fixture.runFrames();
    expect(fixture.focus()).toBe("Second close button");
  } finally {
    fixture.stop();
  }
});

test("a normal close restores focus to its surviving opener", async () => {
  const fixture = await focusFixture();
  try {
    await fixture.host.close(fixture.open("First"));
    fixture.runFrames();
    expect(fixture.focus()).toBe("inbox opener");
  } finally {
    fixture.stop();
  }
});

test("closing a background window preserves the active window's focus", async () => {
  const fixture = await focusFixture();
  try {
    const first = fixture.open("First");
    fixture.open("Second");
    await fixture.host.close(first);
    fixture.runFrames();
    expect(fixture.focus()).toBe("Second close button");
  } finally {
    fixture.stop();
  }
});

test("a close callback does not restore focus after its inbox becomes inactive", async () => {
  const fixture = await focusFixture();
  try {
    await fixture.host.close(fixture.open("First"));
    await fixture.host.setActive(false);
    fixture.runFrames();
    expect(fixture.focus()).toBe("First close button");
  } finally {
    fixture.stop();
  }
});
