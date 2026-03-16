const API_TOKEN_STORAGE_KEY = "salvo.apiToken";
const API_TOKEN_EVENT = "salvo:api-token-changed";

function dispatchTokenEvent(): void {
  window.dispatchEvent(new Event(API_TOKEN_EVENT));
}

export function getStoredApiToken(): string {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(API_TOKEN_STORAGE_KEY)?.trim() ?? "";
}

export function setStoredApiToken(token: string): string {
  const trimmed = token.trim();
  window.localStorage.setItem(API_TOKEN_STORAGE_KEY, trimmed);
  dispatchTokenEvent();
  return trimmed;
}

export function clearStoredApiToken(): void {
  window.localStorage.removeItem(API_TOKEN_STORAGE_KEY);
  dispatchTokenEvent();
}

export function subscribeToApiToken(listener: () => void): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === API_TOKEN_STORAGE_KEY) {
      listener();
    }
  };

  window.addEventListener(API_TOKEN_EVENT, listener);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(API_TOKEN_EVENT, listener);
    window.removeEventListener("storage", handleStorage);
  };
}
