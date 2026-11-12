import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../../src/shared/types.js";

export type Connection = "connecting" | "live" | "offline";

/** Subscribes to the server's SSE stream; EventSource reconnects on its own after drops. */
export function useSnapshot(): {
  snapshot: Snapshot | undefined;
  connection: Connection;
  error?: string;
} {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState<string>();
  const lastAt = useRef(0);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.addEventListener("snapshot", (e) => {
      try {
        setSnapshot(JSON.parse((e as MessageEvent<string>).data) as Snapshot);
        lastAt.current = Date.now();
        setConnection("live");
        setError(undefined);
      } catch (err) {
        setError(String(err));
      }
    });
    es.addEventListener("error", (e) => {
      const data = (e as MessageEvent<string>).data;
      if (data) setError(JSON.parse(data) as string);
      else setConnection(es.readyState === EventSource.CLOSED ? "offline" : "connecting");
    });
    const watchdog = setInterval(() => {
      if (lastAt.current && Date.now() - lastAt.current > 5000) setConnection("offline");
    }, 1000);
    return () => {
      clearInterval(watchdog);
      es.close();
    };
  }, []);

  return { snapshot, connection, error };
}
