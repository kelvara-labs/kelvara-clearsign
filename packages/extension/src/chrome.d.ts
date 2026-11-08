// Minimal typings for the chrome.* APIs this extension uses. Kept local so the
// extension adds no dependency (and no lockfile change) for @types/chrome.
declare namespace chrome {
  namespace runtime {
    const id: string;
    interface MessageSender {
      id?: string;
      tab?: { id?: number; url?: string };
      frameId?: number;
      url?: string;
    }
    function sendMessage(message: unknown): Promise<unknown>;
    function getURL(path: string): string;
    function openOptionsPage(): Promise<void>;
    const onInstalled: {
      addListener(cb: (details: { reason: string }) => void): void;
    };
    const onMessage: {
      addListener(
        cb: (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | void
      ): void;
    };
  }
  namespace permissions {
    function request(details: { origins: string[] }): Promise<boolean>;
    function contains(details: { origins: string[] }): Promise<boolean>;
  }
  namespace tabs {
    function create(props: { url: string; active?: boolean }): Promise<unknown>;
  }
  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
  }
}
