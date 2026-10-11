import { recordEvent, type UsageEvent } from "./usage";

// A bare `void promise` only silences the linter: if the promise rejects it is
// still an unhandled rejection. These helpers keep fire-and-forget calls
// non-throwing AND observable (a console.warn instead of silence).

export function logRejection(label: string): (reason: unknown) => void {
  return (reason) => {
    console.warn(`[${label}]`, reason instanceof Error ? reason.message : reason);
  };
}

// Promise.resolve() tolerates a non-promise return (e.g. a stubbed fn). A callee
// that throws synchronously still throws at the call site; async functions never do.
export function fireAndForget(promise: PromiseLike<unknown> | void, label: string): void {
  Promise.resolve(promise).catch(logRejection(label));
}

// recordEvent does queue I/O (read + write) and can reject, so UI call sites
// that don't await it go through here. flushUsageEvents never throws (see
// flush.ts), so it needs no wrapper.
export function recordEventSafe(event: UsageEvent): void {
  fireAndForget(recordEvent(event), "recordEvent");
}
